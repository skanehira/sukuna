import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
import { createTempHome, openMigratedDatabase, removeTempHome } from "../shared/db/test-helpers";
import { startRunnerApp } from "./app";
import { readEnvironment } from "../shared/env";
import type { LogEntry } from "../shared/log";
import { ScriptedAgent } from "./modules/conversation/adapter/scripted-agent";

it("並行する2会話の全ログに対象の会話とissueを載せる", async () => {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  const entries: LogEntry[] = [];
  const agent = new ScriptedAgent({
    rules: [],
    fallback: [
      { rate_limit: { status: "rejected", resetsAt: 123 } },
      { end: "error_during_execution" },
    ],
  });
  const app = await startRunnerApp({
    database,
    environment: readEnvironment("runner", { SUKUNA_HOME: home }, home, () => true)._unsafeUnwrap(),
    agent,
    log: (entry) => {
      entries.push(entry);
    },
  });
  const until = (id: string, predicate: () => boolean) =>
    predicate()
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const off = app.runtime.subscribe((s) => {
            if (s.conversationId === id && predicate()) {
              off();
              resolve();
            }
          });
        });
  try {
    const ids = await Promise.all(
      ["issue-a", "issue-b"].map(
        async (issueId) =>
          (
            await app.runtime.start({
              projectId: "p",
              issueId,
              kind: "chat",
              title: "会話",
              cwd: home,
              message: "limit",
            })
          )._unsafeUnwrap().conversationId,
      ),
    );
    await Promise.all(
      ids.map((id) => until(id, () => app.runtime.store.get(id)?.runState === "usage_limited")),
    );
    const listenerError = new Error("listener");
    const off = app.runtime.subscribe(() => {
      throw listenerError;
    });
    await Promise.all(ids.map((id) => app.runtime.resume(id, "usage_limit")));
    off();
    await Promise.all(
      ids.map((id) => until(id, () => app.runtime.store.get(id)?.runState === "usage_limited")),
    );
    await Promise.all(
      ids.map((id) => app.runtime.serial(id, () => Promise.reject(new Error("operation")))),
    );
    await Promise.all(ids.map((id) => app.runtime.release(id)));
    agent.open = () => ({
      output: {
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("stream")) }),
      },
      send: () => {},
      interrupt: () => Promise.resolve(),
      close: () => {},
      commands: () => Promise.resolve([]),
    });
    await Promise.all(
      ids.map((id) => app.runtime.send(id, { text: "retry", images: [], origin: "developer" })),
    );
    await Promise.all(
      ids.map((id) => until(id, () => app.runtime.store.get(id)?.runState === "failed")),
    );
    for (const [index, id] of ids.entries()) {
      const messages = entries.filter((entry) => entry.conversation_id === id);
      expect(messages.every((entry) => entry.issue_id === ["issue-a", "issue-b"][index])).toBe(
        true,
      );
      expect([...new Set(messages.map((entry) => entry.message))].sort()).toEqual(
        [
          JSON.stringify({ rate_limit_info: { status: "rejected", resetsAt: 123 } }),
          "番が終わりました: error_during_execution; cost_usd=0; duration_ms=0",
          "会話が止まりました: usage_limit",
          "会話が止まりました: error",
          "利用枠が戻ったため、作業を再開しました。",
          "会話の合図の受け手が失敗しました。",
          "会話の操作に失敗しました。",
          "AI の実行に失敗しました。",
        ].sort(),
      );
      expect(
        messages
          .filter((entry) => entry.error)
          .map((entry) => (entry.error instanceof Error ? entry.error.message : entry.error)),
      ).toEqual([
        ...messages.filter((entry) => entry.error === listenerError).map(() => "listener"),
        "operation",
        "stream",
      ]);
    }
    expect(entries.filter((entry) => !entry.conversation_id)).toEqual([]);
  } finally {
    await app.shutdown();
    database.close();
    removeTempHome(home);
  }
});
it.each(["working", "waiting_answer", "waiting_permission", "idle"] as const)(
  "%s のランナーは SIGTERM でAIを停止し未保存出力を残して20秒以内に終わり、次の起動で復旧する",
  async (state) => {
    const home = createTempHome();
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const script = join(home, "agent.json");
    writeFileSync(
      script,
      JSON.stringify({ rules: [], fallback: [{ text: "保存済み" }, { hold: true }] }),
    );
    const actionsPath = join(home, "shutdown.jsonl");
    const code = `
    import { createServer } from 'vite';
    import { appendFileSync } from 'node:fs';
    const server = await createServer({ configFile: false, root: process.cwd(), server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom', optimizeDeps: { entries: [] } });
    const { runnerApp } = await server.ssrLoadModule('/src/runner/main.ts');
    const { AsyncQueue } = await server.ssrLoadModule('/src/shared/async-queue.ts');
    const { turnEnd } = await server.ssrLoadModule('/src/runner/modules/conversation/adapter/scripted-agent.ts');
    let params;
    const output = new AsyncQueue();
    const action = name => appendFileSync(${JSON.stringify(actionsPath)}, JSON.stringify(name) + '\\n');
    const pendingOutput = { kind: 'assistant_text', uuid: 'pending', text: '終了時まで保存待ち', parentToolUseId: null };
    let flushed = false;
    const flush = () => {
      if (flushed) return;
      flushed = true;
      output.push(pendingOutput);
    };
    runnerApp.runtime.options.agent = {
      open: p => {
        params = p;
        output.push({ kind: 'init', sessionId: p.sessionId, commands: [] });
        return {
          output,
          send: () => { output.push({ kind: 'assistant_text', uuid: 'ready', text: '保存済み', parentToolUseId: null }); if (${JSON.stringify(state)} === 'idle') output.push(turnEnd('success')); },
          interrupt: async () => { action('interrupt'); flush(); output.push(turnEnd('error_during_execution')); },
          close: () => { action('close'); flush(); output.close(); },
          commands: async () => [],
        };
      },
      fork: () => { throw new Error('unused'); }, complete: () => { throw new Error('unused'); },
    };
    const created = await runnerApp.runtime.start({ projectId: 'p', kind: 'chat', title: '実行', cwd: process.cwd(), message: 'run' });
    const id = created._unsafeUnwrap().conversationId;
    const ready = () => ${JSON.stringify(state)} === 'idle' ? runnerApp.runtime.store.get(id).runState === 'idle' : runnerApp.runtime.store.events(id).some(e => e.type === 'assistant_text');
    if (!ready()) await new Promise(resolve => { const off = runnerApp.runtime.subscribe(() => { if (ready()) { off(); resolve(); } }); });
    if (${JSON.stringify(state)} === 'waiting_answer') void params.onQuestion({ requestId: 'question', questions: [{ question: '方針', header: '方針', options: [], multi_select: false }] }).catch(() => {});
    if (${JSON.stringify(state)} === 'waiting_permission') void params.onPermission({ requestId: 'permission', toolName: 'Bash', input: {} });
    console.log(JSON.stringify({ready: id}));
  `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "development",
        SUKUNA_HOME: home,
        SUKUNA_AGENT: "fake",
        SUKUNA_AGENT_SCRIPT: script,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      const id = await new Promise<string>((resolve, reject) => {
        lines.on("line", (line) => {
          if (line.startsWith('{"ready":')) resolve((JSON.parse(line) as { ready: string }).ready);
        });
        child.once("exit", () => reject(new Error(stderr)));
      });
      const start = performance.now();
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
      expect(performance.now() - start).toBeLessThan(20000);
      const opened = openMigratedDatabase(home);
      expect(
        opened.sqlite
          .prepare("SELECT type FROM conversation_events WHERE conversation_id = ? ORDER BY seq")
          .all(id),
      ).toEqual([
        { type: "user_message" },
        { type: "assistant_text" },
        ...(state === "idle"
          ? [{ type: "turn_end" }]
          : state === "waiting_answer"
            ? [{ type: "question" }]
            : state === "waiting_permission"
              ? [{ type: "permission_request" }]
              : []),
        { type: "assistant_text" },
      ]);
      expect(
        readFileSync(actionsPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual(state === "idle" ? ["close"] : ["interrupt", "close"]);
      expect(
        opened.sqlite
          .prepare("SELECT payload FROM conversation_events WHERE sdk_uuid = 'pending'")
          .get(),
      ).toEqual({
        payload: JSON.stringify({ text: "終了時まで保存待ち", parent_tool_use_id: null }),
      });
      expect(
        opened.sqlite.prepare("SELECT run_state FROM conversations WHERE id = ?").get(id),
      ).toEqual({ run_state: state });
      opened.close();
      const second = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { createServer } from 'vite'; const s = await createServer({configFile:false,root:process.cwd(),server:{middlewareMode:true,ws:false,watch:null},optimizeDeps:{entries:[]}}); await s.ssrLoadModule('/src/runner/main.ts');`,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            NODE_ENV: "development",
            SUKUNA_HOME: home,
            SUKUNA_AGENT: "fake",
            SUKUNA_AGENT_SCRIPT: script,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const secondLines = createInterface({ input: second.stdout });
      const secondExit = new Promise<number | null>((resolve) => second.once("exit", resolve));
      try {
        await new Promise<void>((resolve, reject) => {
          secondLines.on("line", (line) => {
            if (
              line.startsWith("{") &&
              (JSON.parse(line) as { message?: string }).message === "started"
            )
              resolve();
          });
          second.once("exit", () => reject(new Error("再起動に失敗")));
        });
        second.kill("SIGTERM");
        expect(await secondExit).toBe(0);
        const recovered = openMigratedDatabase(home);
        expect(
          recovered.sqlite
            .prepare("SELECT run_state, stop_reason FROM conversations WHERE id = ?")
            .get(id),
        ).toEqual(
          state === "idle"
            ? { run_state: "idle", stop_reason: null }
            : { run_state: "stopped", stop_reason: "restarted" },
        );
        expect(
          recovered.sqlite
            .prepare("SELECT payload FROM conversation_events WHERE type = 'stopped'")
            .all(),
        ).toEqual(
          state === "idle"
            ? []
            : [{ payload: JSON.stringify({ reason: "restarted", previous_run_state: state }) }],
        );
        recovered.close();
        expect(readFileSync(join(home, "runner/children"), "utf8")).toBe("");
      } finally {
        if (second.exitCode === null) {
          second.kill("SIGKILL");
          await secondExit;
        }
        secondLines.close();
      }
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
      lines.close();
      removeTempHome(home);
    }
  },
  25000,
);
