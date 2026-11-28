import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { lstatSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { launchDevRunner } from "../../scripts/dev-runner";
import { createTempHome, removeTempHome } from "../shared/db/test-helpers";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function runnerStatus(socketPath: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const probe = request({ socketPath, path: "/health" }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    probe.on("error", () => resolve(undefined));
    probe.setTimeout(500, () => probe.destroy());
    probe.end();
  });
}

async function startScreen(home: string, socketPath: string) {
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const { port } = reservation.address() as AddressInfo;
  reservation.close();
  await once(reservation, "close");

  const child = spawn(
    "vp",
    ["dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      env: {
        ...process.env,
        VITEST: undefined,
        NODE_ENV: "development",
        SUKUNA_HOME: home,
        SUKUNA_RUNNER_SOCKET: socketPath,
        SUKUNA_AGENT: undefined,
        SUKUNA_AGENT_SCRIPT: undefined,
        SUKUNA_GH: undefined,
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const closed = once(child, "close");
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  cleanup.push(async () => {
    signal(child, "SIGTERM");
    await closed;
  });

  await expect
    .poll(
      async () => {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(output);
        try {
          return (
            await fetch("http://127.0.0.1:" + port + "/api/health", {
              signal: AbortSignal.timeout(500),
            })
          ).status;
        } catch {
          return undefined;
        }
      },
      { timeout: 15_000 },
    )
    .toBe(200);

  return {
    async stop() {
      signal(child, "SIGINT");
      await closed;
    },
    output: () => output,
  };
}

function signal(child: ChildProcess, signalName: NodeJS.Signals) {
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null)
    process.kill(-child.pid, signalName);
}

it("古いソケットが残っていても vp dev がランナーを起動し、終了時に止める", async () => {
  const home = createTempHome();
  cleanup.push(() => removeTempHome(home));
  const socket = join(home, "custom.sock");
  const stale = spawnSync(process.execPath, [
    "-e",
    "require('node:net').createServer().listen(process.argv[1],()=>process.exit(0))",
    socket,
  ]);
  expect(stale.status).toBe(0);
  expect(lstatSync(socket).isSocket()).toBe(true);
  const screen = await startScreen(home, socket);

  try {
    await expect.poll(() => runnerStatus(socket), { timeout: 10_000 }).toBe(200);
  } catch (cause) {
    throw new Error(screen.output(), { cause });
  }
  await screen.stop();
  expect(await runnerStatus(socket)).toBeUndefined();
}, 30_000);

it("同じソケットにランナーがいれば vp dev は再利用し、終了しても止めない", async () => {
  const home = createTempHome();
  cleanup.push(() => removeTempHome(home));
  const socket = join(home, "custom.sock");
  const runner = createServer((req, response) => {
    if (req.url === "/health") response.end("{}");
    else response.writeHead(404).end();
  }).listen(socket);
  await once(runner, "listening");
  cleanup.push(() => new Promise<void>((resolve) => runner.close(() => resolve())));

  const stop = await launchDevRunner(
    process.cwd(),
    socket,
    new AbortController().signal,
    (error) => {
      throw new Error(error);
    },
  );
  if (stop) cleanup.push(stop);
  expect(stop).toBeUndefined();

  const screen = await startScreen(home, socket);
  await screen.stop();

  expect(await runnerStatus(socket)).toBe(200);
  expect(screen.output()).not.toMatch(/別のランナーが動いています/);
}, 30_000);
