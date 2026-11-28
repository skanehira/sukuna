import { execFile, spawn } from "node:child_process";
import { on, once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vite-plus/test";
import { WebSocket } from "ws";
import { terminalOpenedSchema, terminalOutputFrameSchema } from "../shared/api/terminal";
import { createTempHome, removeTempHome } from "../shared/db/test-helpers";
import { activeFixtureJob } from "./modules/workspace/adapter/terminal-test-helpers";
import { xdgVariablesIn } from "../test/directories";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url));
const devServer = String.raw`
import assert from "node:assert/strict";
import { join } from "node:path";
import { createServer } from "vite";

const home = process.argv[1];
const loader = await createServer({
  root: process.cwd(),
  cacheDir: join(home, "vite-cache"),
  define: { __SUKUNA_BUILD_ID__: JSON.stringify("terminal-hmr-test") },
  server: { host: "127.0.0.1", port: 0, strictPort: true, ws: false, watch: null },
  appType: "custom",
  optimizeDeps: { entries: [], noDiscovery: true },
});
const runtimePath = "/src/server/runtime.ts";
const devPath = "/src/server/dev.ts";
const runtime = await loader.ssrLoadModule(runtimePath);
const started = await runtime.initializeRuntime({ directories: { data: home, state: home, runtime: home } });
if (started.isErr()) throw new Error(started.error.message);
const database = runtime.getDatabase();
database.sqlite.prepare("INSERT INTO projects (id, name, path, default_branch) VALUES ('p', 'sample', ?, 'main')").run(home);
`;

const entry =
  devServer +
  String.raw`
const sessions = runtime.getPtySessions();
async function open(app) {
  const request = new Request("http://127.0.0.1/api/terminals", {
    method: "POST",
    body: JSON.stringify({ projectId: "p", worktreeId: null, conversationId: null, cols: 80, rows: 24 }),
  });
  const connection = { incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 50123 } } };
  const response = await app.fetch(request, connection);
  return { status: response.status, body: await response.json() };
}

try {
  const firstApp = (await loader.ssrLoadModule(devPath)).default;
  const first = await open(firstApp);
  assert.equal(first.status, 201);
  const terminal = sessions.find(first.body.id);
  assert.ok(terminal);
  const graph = loader.environments.ssr.moduleGraph;
  const checked = [];
  for (const path of [
    "/src/server/app.ts",
    "/src/server/modules/workspace/adapter/worktree-routes.ts",
    "/src/server/modules/recap/adapter/http.ts",
  ]) {
    const changed = await graph.getModuleByUrl(path);
    assert.ok(changed, path);
    graph.invalidateModule(changed, new Set(), Date.now(), true);
    const nextApp = (await loader.ssrLoadModule(devPath)).default;
    assert.notEqual(nextApp, firstApp, path);
    const latestRuntime = await loader.ssrLoadModule(runtimePath);
    assert.equal(latestRuntime.getDatabase(), database, path);
    assert.equal(latestRuntime.getPtySessions(), sessions, path);
    assert.deepEqual(await open(nextApp), { status: 200, body: { ...first.body, reused: true } }, path);
    checked.push(path);
  }
  let exited = false;
  terminal.subscribe((frame) => {
    if (frame.type === "exit") exited = true;
  });
  await loader.close();
  assert.equal(exited, true);
  assert.equal(sessions.find(first.body.id), undefined);
  console.log(JSON.stringify({ checked, exited }));
} finally {
  runtime.getRunnerLink().stop();
  await sessions.close();
  database.close();
  await loader.close();
}
`;

function devEnvironment(home: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "development",
    SHELL: "/bin/sh",
    ...xdgVariablesIn(home),
    SUKUNA_RUNNER_SOCKET: join(home, "runner.sock"),
  };
  delete env.VITEST;
  return env;
}

it(
  "HTTP ルートの再読み込みでは端末を保ち、開発サーバーの終了時に止める",
  { timeout: 15000 },
  async () => {
    const home = createTempHome();
    try {
      const { stdout } = await run(process.execPath, ["--input-type=module", "-e", entry, home], {
        cwd: root,
        env: devEnvironment(home),
        timeout: 12000,
      });
      const result = stdout.trim().split("\n").at(-1) ?? "";
      expect(JSON.parse(result)).toEqual({
        checked: [
          "/src/server/app.ts",
          "/src/server/modules/workspace/adapter/worktree-routes.ts",
          "/src/server/modules/recap/adapter/http.ts",
        ],
        exited: true,
      });
    } finally {
      removeTempHome(home);
    }
  },
);

async function startBackgroundJob(socket: WebSocket): Promise<number> {
  let output = "";
  for await (const [bytes] of on(socket, "message", {
    signal: AbortSignal.timeout(5000),
    close: ["close"],
  })) {
    const frame = terminalOutputFrameSchema.parse(JSON.parse(String(bytes)));
    if (frame.type === "snapshot") {
      socket.send(
        JSON.stringify({
          type: "input",
          data: `/bin/sleep 20 & printf "\\n%s%d\\n" job-pid: $!\r`,
        }),
      );
    }
    if (frame.type !== "output") continue;
    const match = (output += frame.data).match(/\r?\njob-pid:(\d+)\r?\n/);
    if (match) return Number(match[1]);
  }
  throw new Error("WebSocket が閉じるまでにジョブを起動できませんでした。");
}

it(
  "開発サーバーが SIGINT を受けると端末のバックグラウンドジョブも止まる",
  { timeout: 25000 },
  async () => {
    const home = createTempHome();
    const code =
      devServer + "await loader.listen(); process.send(loader.httpServer.address().port);";
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, home], {
      cwd: root,
      env: devEnvironment(home),
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    const closed = once(child, "close");
    let logs = "";
    child.stdout?.on("data", (chunk) => (logs += String(chunk)));
    child.stderr?.on("data", (chunk) => (logs += String(chunk)));
    let socket: WebSocket | undefined;
    let job: { pid: number; identity: string | null } | undefined;
    try {
      const [port] = await Promise.race([
        once(child, "message", { signal: AbortSignal.timeout(8000) }),
        closed.then(() => {
          throw new Error("開発サーバーを起動できませんでした。\n" + logs);
        }),
      ]);
      expect(port).toEqual(expect.any(Number));
      const address = `http://127.0.0.1:${port}`;
      const response = await fetch(`${address}/api/terminals`, {
        method: "POST",
        body: JSON.stringify({
          projectId: "p",
          worktreeId: null,
          conversationId: null,
          cols: 80,
          rows: 24,
        }),
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(201);
      const { id } = terminalOpenedSchema.parse(await response.json());
      socket = new WebSocket(`ws://127.0.0.1:${port}/ws/terminals/${id}`, { origin: address });
      const pid = await startBackgroundJob(socket);
      const fixture: { pid: number; identity: string | null } = { pid, identity: null };
      job = fixture;
      await expect
        .poll(() => {
          fixture.identity = activeFixtureJob(pid);
          return fixture.identity;
        })
        .toEqual(expect.any(String));

      const deadline = AbortSignal.timeout(6000);
      const ended = once(child, "close", { signal: deadline });
      const disconnected = once(socket, "close", { signal: deadline });
      child.kill("SIGINT");
      const [[status, signal]] = await Promise.all([ended, disconnected]);
      expect(activeFixtureJob(pid)).toBeNull();
      expect({ status, signal }).toEqual({ status: 130, signal: null });
    } finally {
      socket?.terminate();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      try {
        await closed;
      } finally {
        if (job?.identity && activeFixtureJob(job.pid) === job.identity)
          process.kill(job.pid, "SIGKILL");
        removeTempHome(home);
      }
    }
  },
);
