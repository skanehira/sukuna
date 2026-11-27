import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { statSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import WebSocket from "ws";
import { expect, it } from "vite-plus/test";
import { createTempHome, openMigratedDatabase, removeTempHome } from "../shared/db/test-helpers";
import { migrations } from "../shared/db/migrate";
import { RunnerLink } from "./runner-link";
import type { ServerMessage } from "../shared/ws";

const loader = `import {createServer} from 'vite';const loader=await createServer({configFile:false,root:process.cwd(),cacheDir:process.env.SUKUNA_HOME+'/vite-cache-'+process.pid,envDir:false,server:{middlewareMode:true,ws:false,watch:null},optimizeDeps:{entries:[]}});`;
const root = fileURLToPath(new URL("../..", import.meta.url));
function startProcess(home: string, role: "runner" | "server") {
  const code =
    loader +
    (role === "runner"
      ? `await loader.ssrLoadModule('/src/runner/main.ts');`
      : `const {initializeRuntime,attachUpgradeHandler,getRunnerLink}=await loader.ssrLoadModule('/src/server/runtime.ts');const result=await initializeRuntime({homeDir:process.env.SUKUNA_HOME},{socket:process.env.SUKUNA_RUNNER_SOCKET});if(result.isErr())throw Error(result.error.message);const {serve}=await import('@hono/node-server');const {Hono}=await import('hono');const app=new Hono();app.post('/operate',async c=>getRunnerLink().forward('POST','/conversations/'+(await c.req.json()).id+'/stop'));const server=serve({fetch:app.fetch,port:0,hostname:'127.0.0.1'},info=>console.log(JSON.stringify({ready:info.port})));attachUpgradeHandler(server);`);
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "development",
      SUKUNA_HOME: home,
      SUKUNA_RUNNER_SOCKET: join(home, "runner.sock"),
      SUKUNA_AGENT: "fake",
      SUKUNA_AGENT_SCRIPT: join(home, "agent.json"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise<number>((resolve, reject) => {
    lines.on("line", (line) => {
      try {
        const data = JSON.parse(line) as { ready?: number; message?: string };
        if (data.ready !== undefined) resolve(data.ready);
        if (role === "runner" && data.message === "started") resolve(child.pid ?? 0);
      } catch {}
    });
    child.once("exit", (code) => {
      lines.close();
      reject(new Error(`process exited ${code}: ${output}`));
    });
  });
  return { child, ready, output: () => output };
}
async function stop(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}
async function socket(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const received: ServerMessage[] = [];
  ws.on("message", (data) =>
    received.push(
      JSON.parse(
        (data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Array.isArray(data)
            ? Buffer.concat(data)
            : data
        ).toString(),
      ) as ServerMessage,
    ),
  );
  await once(ws, "open");
  return { ws, received };
}
async function until(client: Awaited<ReturnType<typeof socket>>, predicate: () => boolean) {
  if (predicate()) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.ws.off("message", listener);
      reject(new Error("配信の条件が成立しませんでした: " + JSON.stringify(client.received)));
    }, 5000);
    const listener = () => {
      if (predicate()) {
        client.ws.off("message", listener);
        clearTimeout(timeout);
        resolve();
      }
    };
    client.ws.on("message", listener);
  });
}
it("別プロセスのIPCから購読へ配信し、両プロセスの片方だけの再起動から続きの記録を回収する", async () => {
  const home = createTempHome();
  writeFileSync(
    join(home, "agent.json"),
    JSON.stringify({
      rules: [],
      fallback: [
        { text: "reply" },
        { tool: "Read", input: { file_path: "a" }, result: "body" },
        { hold: true },
      ],
    }),
  );
  const runner = startProcess(home, "runner");
  let server = startProcess(home, "server");
  const children = [runner.child, server.child];
  const sockets: WebSocket[] = [];
  const link = new RunnerLink({
    socket: join(home, "runner.sock"),
    notice: () => {},
    connection: () => {},
    log: () => {},
  });
  try {
    const [, port] = await Promise.all([runner.ready, server.ready]);
    expect(statSync(join(home, "runner.sock")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, "db.lock"))).toBe(false);
    const db = openMigratedDatabase(home);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations").get()).toEqual({
      count: migrations.length,
    });
    db.sqlite
      .prepare("INSERT INTO projects(id,name,path,default_branch) VALUES('p','project',?,'main')")
      .run(home);
    db.close();
    const created = (
      await link.call("POST", "/conversations", {
        project_id: "p",
        kind: "chat",
        cwd: home,
        title: "会話",
        message: "first",
      })
    )._unsafeUnwrap();
    expect(created.status).toBe(200);
    const id = (created.body as { conversation_id: string }).conversation_id;
    const a = await socket(port);
    sockets.push(a.ws);
    a.ws.send(JSON.stringify({ op: "subscribe", topic: `conversation:${id}` }));
    a.ws.send(JSON.stringify({ op: "subscribe", topic: "inbox" }));
    a.ws.send(JSON.stringify({ op: "subscribe", topic: "app" }));
    await until(a, () =>
      a.received.some((m) => m.type === "event" && m.payload.type === "tool_result"),
    );
    const first = a.received.filter((m) => m.type === "event").map((m) => m.seq);
    expect(first).toEqual([1, 2, 3, 4]);
    await until(a, () => a.received.some((m) => m.type === "runner" && m.payload.connected));
    const sent = (
      await link.call("POST", `/conversations/${id}/messages`, {
        text: "second",
        images: [],
        interrupt: true,
        client_id: "second",
        origin: "developer",
      })
    )._unsafeUnwrap();
    expect(sent.status).toBe(200);
    await until(a, () => a.received.some((m) => m.topic === "inbox" && m.type === "changed"));
    await until(
      a,
      () =>
        a.received.some(
          (m) => m.type === "event" && m.seq > 4 && m.payload.type === "tool_result",
        ) && a.received.filter((m) => m.topic === "inbox").length >= 5,
    );
    expect(
      a.received.filter((m) => m.topic === "inbox" && m.type === "changed").at(-1)?.payload,
    ).toEqual({ conversation_ids: [id], issue_ids: [], project_ids: ["p"] });
    const saved = openMigratedDatabase(home);
    expect(saved.sqlite.prepare("SELECT run_state FROM conversations WHERE id=?").get(id)).toEqual({
      run_state: "working",
    });
    saved.close();
    const last = a.received.filter((m) => m.type === "event").at(-1)?.seq ?? 0;
    await stop(server.child);
    await link.call("POST", `/conversations/${id}/messages`, {
      text: "during restart",
      images: [],
      interrupt: true,
      client_id: "third",
      origin: "developer",
    });
    server = startProcess(home, "server");
    children.push(server.child);
    const restartedPort = await server.ready;
    const b = await socket(restartedPort);
    sockets.push(b.ws);
    b.ws.send(JSON.stringify({ op: "subscribe", topic: `conversation:${id}`, after: last }));
    b.ws.send(JSON.stringify({ op: "subscribe", topic: "app" }));
    await until(b, () =>
      b.received.some((m) => m.type === "event" && m.payload.type === "tool_result"),
    );
    const seqs = b.received.filter((m) => m.type === "event").map((m) => m.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => last + i + 1));
    expect(runner.child.exitCode).toBe(null);
    const duplicate = startProcess(home, "runner");
    children.push(duplicate.child);
    await expect(duplicate.ready).rejects.toThrow();
    expect(duplicate.output().includes("別のランナーが動いています。")).toBe(true);
    await stop(runner.child);
    const response = await fetch(`http://127.0.0.1:${restartedPort}/operate`, {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 503,
      body: {
        error: {
          code: "runner_unavailable",
          message:
            "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
        },
      },
    });
    const next = startProcess(home, "runner");
    children.push(next.child);
    await next.ready;
    await until(b, () =>
      b.received.some((m) => m.type === "event" && m.payload.type === "stopped"),
    );
    const event = b.received.find((m) => m.type === "event" && m.payload.type === "stopped");
    expect(event?.type === "event" ? event.payload.payload : null).toEqual({
      reason: "restarted",
      previous_run_state: "working",
    });
  } finally {
    for (const ws of sockets) ws.terminate();
    await Promise.all(children.map(stop));
    removeTempHome(home);
  }
}, 30000);
