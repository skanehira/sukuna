import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { expect, it } from "vite-plus/test";
import { createTempHome, openMigratedDatabase, removeTempHome } from "../shared/db/test-helpers";
import { serverMessageSchema } from "../shared/ws";
import type { ConversationEventsPage, PublicConversation } from "../shared/conversation/api";
import type { IssueView } from "../shared/issue/schema";

const cwd = new URL("../..", import.meta.url);
const continuation = "ランナーが再起動しました。中断したところから続けてください。";
const firstLine = "画面の入れ替え前の出力";
const laterLine = "画面の入れ替え中の出力";

const agent = {
  rules: [
    { match: continuation, steps: [{ text: "止まっていた精査を続けています" }, { hold: true }] },
    {
      match: "^画面を入れ替える$",
      steps: [
        { text: firstLine },
        {
          shell:
            'i=0; while [ ! -f resume-output ] && [ "$i" -lt 300 ]; do i=$((i + 1)); sleep 0.05; done; test -f resume-output',
        },
        { text: laterLine },
        { end: "success" },
      ],
    },
    {
      match: "^作業を続ける$",
      steps: [{ text: "新しい指示を受け取りました" }, { end: "success" }],
    },
  ],
  fallback: [{ text: "作業を始めました" }, { hold: true }],
};

function start(home: string, role: "runner" | "server", build = "loaded") {
  const loader = `import {createServer} from 'vite';
    const loader = await createServer({
      configFile:false, root:process.cwd(), envDir:false,
      cacheDir:process.env.SUKUNA_HOME+'/vite-cache-'+process.pid,
      define:{__SUKUNA_BUILD_ID__:${JSON.stringify(JSON.stringify(build))}},
      server:{middlewareMode:true, ws:false, watch:null}, optimizeDeps:{entries:[]}
    });`;
  const entry =
    role === "runner"
      ? "await loader.ssrLoadModule('/src/runner/main.ts');"
      : `
        const {initializeRuntime, attachUpgradeHandler} = await loader.ssrLoadModule('/src/server/runtime.ts');
        const initialized = await initializeRuntime();
        if (initialized.isErr()) throw new Error(initialized.error.message);
        const {default: app} = await loader.ssrLoadModule('/src/server/dev.ts');
        const {serve} = await import('@hono/node-server');
        const server = serve({fetch:app.fetch, port:0, hostname:'127.0.0.1'},
          ({port}) => console.log(JSON.stringify({port})));
        attachUpgradeHandler(server);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", loader + entry], {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: "development",
      SUKUNA_HOME: home,
      SUKUNA_RUNNER_SOCKET: join(home, "runner.sock"),
      SUKUNA_LOGIN: "dev@example.com",
      SUKUNA_DEV_IDENTITY: "dev@example.com",
      SUKUNA_AGENT: "fake",
      SUKUNA_AGENT_SCRIPT: join(home, "agent.json"),
      SUKUNA_GH: join(home, "gh.json"),
      CLAUDE_CONFIG_DIR: join(home, "claude"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr.on("data", (data: Buffer) => {
    output += data.toString();
  });
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise<number>((resolve, reject) => {
    lines.on("line", (line) => {
      output += line + "\n";
      try {
        const record = JSON.parse(line) as { port?: number; message?: string };
        if (role === "server" && record.port) resolve(record.port);
        if (role === "runner" && record.message === "started") resolve(child.pid!);
      } catch {}
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      lines.close();
      reject(new Error(`${role} exited (${code})\n${output}`));
    });
  });
  async function stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, "exit");
    child.kill(signal);
    await exit;
  }
  return { ready, stop };
}

async function application(onTestFinished: (cleanup: () => Promise<void>) => void) {
  const home = createTempHome();
  const processes: ReturnType<typeof start>[] = [];
  const sockets: WebSocket[] = [];
  onTestFinished(async () => {
    try {
      for (const socket of sockets) socket.terminate();
      await Promise.all(processes.map((child) => child.stop()));
    } finally {
      removeTempHome(home);
    }
  });
  writeFileSync(join(home, "agent.json"), JSON.stringify(agent));
  writeFileSync(
    join(home, "gh.json"),
    '{"responses":[],"fallback":{"stdout":"","stderr":"unexpected gh","exit_code":1}}',
  );
  const db = openMigratedDatabase(home);
  try {
    db.sqlite
      .prepare(
        "INSERT INTO projects(id,name,path,default_branch,auto_stages) VALUES(?,?,?,'main',?)",
      )
      .run("p", "restart fixture", home, '["triage"]');
  } finally {
    db.close();
  }
  const launch = (role: "runner" | "server", build?: string) => {
    const child = start(home, role, build);
    processes.push(child);
    return child;
  };
  let runner = launch("runner");
  let server = launch("server");
  let [, port] = await Promise.all([runner.ready, server.ready]);

  async function subscribe(topic: string, after?: number) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(socket);
    const messages: ReturnType<typeof serverMessageSchema.parse>[] = [];
    socket.on("message", (raw) => {
      const frame =
        raw instanceof ArrayBuffer
          ? Buffer.from(raw)
          : Array.isArray(raw)
            ? Buffer.concat(raw)
            : raw;
      messages.push(serverMessageSchema.parse(JSON.parse(frame.toString())));
    });
    await once(socket, "open");
    socket.send(JSON.stringify({ op: "subscribe", topic, after }));
    return { socket, messages };
  }
  async function waitForRunner() {
    const { socket, messages } = await subscribe("app");
    try {
      await expect
        .poll(
          () => messages.some((message) => message.type === "runner" && message.payload.connected),
          { timeout: 5_000 },
        )
        .toBe(true);
    } finally {
      socket.terminate();
    }
  }
  await waitForRunner();

  const request = async <T>(path: string, method = "GET", data?: unknown): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method,
      ...(data === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }),
    });
    const body = (await response.json()) as T;
    if (!response.ok)
      throw new Error(`${method} ${path} ${response.status}: ${JSON.stringify(body)}`);
    return body;
  };
  const read = (id: string) =>
    request<{ conversation: PublicConversation }>(`/conversations/${id}`);
  const events = (id: string) => request<ConversationEventsPage>(`/conversations/${id}/events`);
  const reply = async (id: string, text: string) =>
    (await events(id)).events.find(
      (event) => event.type === "assistant_text" && event.payload.text === text,
    );
  return {
    home,
    request,
    read,
    events,
    reply,
    async chat() {
      const result = await request<{ conversation: PublicConversation }>("/conversations", "POST", {
        projectId: "p",
        workspace: { kind: "project" },
      });
      return result.conversation.id;
    },
    send: (id: string, text: string) =>
      request<{ result: string }>(`/conversations/${id}/messages`, "POST", {
        text,
        images: [],
        mode: "send",
        clientMessageId: randomUUID(),
      }),
    async restartRunner() {
      await runner.stop("SIGKILL");
      runner = launch("runner");
      await runner.ready;
      await waitForRunner();
    },
    async restartServer(whileDown?: () => Promise<void>) {
      await server.stop();
      await whileDown?.();
      server = launch("server", "updated");
      port = await server.ready;
      await waitForRunner();
    },
    subscribe: async (id: string, after: number) =>
      (await subscribe(`conversation:${id}`, after)).messages,
  };
}

it("別プロセスでランナーを再起動すると、作業中だった自動精査が同じ会話で続く", async ({
  onTestFinished,
}) => {
  const app = await application(onTestFinished);
  const { issue: draft } = await app.request<{ issue: IssueView }>("/projects/p/issues", "POST", {
    title: "再起動する精査",
    body: "同じ段階を続ける",
  });
  await app.request(`/issues/${draft.id}/confirm`, "POST");
  const issue = async () => (await app.request<{ issue: IssueView }>(`/issues/${draft.id}`)).issue;
  await expect
    .poll(async () => (await issue()).conversations)
    .toEqual([{ id: expect.any(String), kind: "triage", runState: "working" }]);
  const id = (await issue()).conversations[0]!.id;
  await expect.poll(() => app.reply(id, "作業を始めました")).toBeDefined();

  await app.restartRunner();

  await expect.poll(() => app.reply(id, "止まっていた精査を続けています")).toBeDefined();
  expect((await issue()).conversations).toEqual([{ id, kind: "triage", runState: "working" }]);
}, 30_000);

it("開発者の会話はランナーの再起動後に停止し、指示が来ると同じ会話で応じる", async ({
  onTestFinished,
}) => {
  const app = await application(onTestFinished);
  const id = await app.chat();
  await app.send(id, "作業を始める");
  await expect.poll(() => app.reply(id, "作業を始めました")).toBeDefined();

  await app.restartRunner();

  expect((await app.read(id)).conversation).toMatchObject({
    id,
    runState: "stopped",
    stopReason: "restarted",
  });
  expect((await app.events(id)).events.at(-1)).toMatchObject({
    type: "stopped",
    payload: { reason: "restarted", previous_run_state: "working" },
  });
  expect(await app.send(id, "作業を続ける")).toMatchObject({ result: "delivered" });
  await expect.poll(() => app.reply(id, "新しい指示を受け取りました")).toBeDefined();
}, 30_000);

it("画面のサーバーの停止中に保存されたAIの出力が再接続した購読に届く", async ({
  onTestFinished,
}) => {
  const app = await application(onTestFinished);
  const id = await app.chat();
  await app.send(id, "画面を入れ替える");
  await expect.poll(() => app.reply(id, firstLine)).toBeDefined();
  const after = (await app.reply(id, firstLine))!.seq;
  await app.subscribe(id, after);

  await app.restartServer(async () => {
    writeFileSync(join(app.home, "resume-output"), "");
    const db = openMigratedDatabase(app.home);
    try {
      const find = db.sqlite.prepare(
        "SELECT seq FROM conversation_events WHERE conversation_id = ? AND type = 'assistant_text' AND json_extract(payload, '$.text') = ?",
      );
      await expect.poll(() => find.get(id, laterLine)).toBeDefined();
    } finally {
      db.close();
    }
  });

  const received = await app.subscribe(id, after);
  await expect
    .poll(() => received)
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topic: `conversation:${id}`,
          type: "event",
          payload: expect.objectContaining({
            type: "assistant_text",
            payload: { text: laterLine, parent_tool_use_id: null },
          }),
        }),
      ]),
    );
}, 30_000);

it("画面のサーバーを入れ替えても履歴を読み直して同じ会話へ指示を送れる", async ({
  onTestFinished,
}) => {
  const app = await application(onTestFinished);
  const id = await app.chat();
  await app.send(id, "作業を続ける");
  await expect.poll(() => app.reply(id, "新しい指示を受け取りました")).toBeDefined();
  await expect.poll(async () => (await app.read(id)).conversation.runState).toBe("idle");
  const previous = (await app.events(id)).events;

  await app.restartServer();

  expect(await app.request("/me")).toMatchObject({ build: "updated" });
  expect((await app.events(id)).events).toEqual(previous);
  expect(await app.send(id, "作業を続ける")).toMatchObject({ result: "delivered" });
  await expect
    .poll(
      async () =>
        (await app.events(id)).events.filter((event) => event.type === "assistant_text").length,
    )
    .toBe(2);
}, 30_000);
