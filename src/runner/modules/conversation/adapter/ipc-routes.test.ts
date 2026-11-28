import { expect, it } from "vite-plus/test";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
} from "../../../../shared/db/test-helpers";
import { startRunnerApp } from "../../../app";
import { ScriptedAgent, turnEnd } from "./scripted-agent";
import { createIpcRoutes } from "./ipc-routes";
import { createLogger, type LogEntry } from "../../../../shared/log";
import { AsyncQueue } from "../../../../shared/async-queue";
import type { AgentOutput, AgentSession, OpenParams } from "../domain/agent-port";
import type { ConversationRuntime } from "../usecase/runtime";

class ControlledAgent extends ScriptedAgent {
  sessions = new Map<string, { output: AsyncQueue<AgentOutput>; params: OpenParams }>();
  override open(params: OpenParams): AgentSession {
    this.opened.push(params);
    const output = new AsyncQueue<AgentOutput>();
    this.sessions.set(params.context.conversationId, { output, params });
    output.push({
      kind: "init",
      sessionId: params.sessionId,
      commands: [{ name: params.cwd, description: "init" }],
    });
    return {
      output,
      send: () => {},
      interrupt: () => {
        output.push(turnEnd("error_during_execution"));
        return Promise.resolve();
      },
      commands: () => Promise.resolve([{ name: params.cwd, description: "live" }]),
      close: () => output.close(),
    };
  }
  async text(runtime: ConversationRuntime, id: string, text: string): Promise<void> {
    const received = new Promise<void>((resolve) => {
      const unsubscribe = runtime.subscribe((signal) => {
        if (
          signal.type === "event" &&
          signal.conversationId === id &&
          signal.event.type === "assistant_text" &&
          signal.event.payload.text === text
        ) {
          unsubscribe();
          resolve();
        }
      });
    });
    this.sessions
      .get(id)
      ?.output.push({ kind: "assistant_text", uuid: text, text, parentToolUseId: null });
    await received;
  }
}
it.each(["active", "released", "same-project", "other-project", "latest-init"] as const)(
  "候補を実行か同じプロジェクトの最後のinitから取得する: %s",
  async (scenario) => {
    const home = createTempHome();
    const database = openMigratedDatabase(home);
    const agent = new ControlledAgent({ rules: [] });
    const app = await startRunnerApp({
      database,
      agent,
      environment: testEnvironment(home),
      log: () => {},
    });
    const routes = createIpcRoutes(app.runtime, () => {});
    const start = async (projectId: string, cwd: string, message?: string) =>
      (
        await app.runtime.start({ projectId, cwd, kind: "chat", title: "会話", message })
      )._unsafeUnwrap().conversationId;
    try {
      const first = await start("p", "first", "start");
      await agent.text(app.runtime, first, "first initialized");
      const another = await start("q", "unrelated", "start");
      await agent.text(app.runtime, another, "other initialized");
      let target = first;
      let expected = [{ name: "first", description: "live" }];
      if (scenario === "released") {
        await app.runtime.release(first);
        expected = [{ name: "first", description: "init" }];
      }
      if (scenario === "same-project" || scenario === "latest-init") {
        target = await start("p", "idle");
        expected = [{ name: "first", description: "init" }];
      }
      if (scenario === "latest-init") {
        const latest = await start("p", "latest", "start");
        await agent.text(app.runtime, latest, "latest initialized");
        expected = [{ name: "latest", description: "init" }];
      }
      if (scenario === "other-project") {
        target = await start("r", "empty");
        expected = [];
      }
      const opened = agent.opened.length;
      const response = await routes.request(`/conversations/${target}/commands`);
      expect({
        status: response.status,
        body: await response.json(),
        opened: agent.opened.length,
      }).toEqual({ status: 200, body: { commands: expected }, opened });
    } finally {
      await app.shutdown();
      database.close();
      removeTempHome(home);
    }
  },
);
it.each(["developer", "answer_text"] as const)(
  "遅れたAI応答で回答を消した後に知らせ、answer_textの保留回答は残す: %s",
  async (origin) => {
    const home = createTempHome();
    const database = openMigratedDatabase(home);
    const agent = new ControlledAgent({ rules: [] });
    const app = await startRunnerApp({
      database,
      agent,
      environment: testEnvironment(home),
      log: () => {},
    });
    try {
      const id = (
        await app.runtime.start({
          projectId: "p",
          cwd: home,
          kind: "chat",
          title: "会話",
          message: "first",
        })
      )._unsafeUnwrap().conversationId;
      const [question] = app.runtime.record(id, [
        {
          type: "question",
          payload: {
            request_id: "old",
            questions: [
              {
                question: "選択",
                header: "質問",
                options: [{ label: "A", description: "a" }],
                multi_select: false,
              },
            ],
          },
        },
      ]);
      database.sqlite
        .prepare("INSERT INTO pending_answers VALUES (?, ?, ?, 1)")
        .run(id, question?.seq, '{"0":{"choices":["A"],"text":""}}');
      await app.runtime.stop(id);
      const read = () => ({
        pending: database.sqlite
          .prepare("SELECT question_seq, answers FROM pending_answers WHERE conversation_id = ?")
          .all(id),
        questions: database.sqlite
          .prepare("SELECT seq, answered FROM questions WHERE conversation_id = ?")
          .all(id),
      });
      const snapshots: ReturnType<typeof read>[] = [];
      app.changes.subscribe((notice) => {
        if (notice.kind === "conversation_parts" && notice.parts.includes("answers"))
          snapshots.push(read());
      });
      await app.runtime.send(id, { text: "next", images: [], origin });
      expect(read()).toEqual({
        pending: [{ question_seq: question?.seq, answers: '{"0":{"choices":["A"],"text":""}}' }],
        questions: [{ seq: question?.seq, answered: 0 }],
      });
      snapshots.length = 0;
      await agent.text(app.runtime, id, "late reply");
      expect({ current: read(), snapshots }).toEqual(
        origin === "developer"
          ? {
              current: { pending: [], questions: [{ seq: question?.seq, answered: 1 }] },
              snapshots: [{ pending: [], questions: [{ seq: question?.seq, answered: 1 }] }],
            }
          : {
              current: {
                pending: [
                  { question_seq: question?.seq, answers: '{"0":{"choices":["A"],"text":""}}' },
                ],
                questions: [{ seq: question?.seq, answered: 0 }],
              },
              snapshots: [],
            },
      );
    } finally {
      await app.shutdown();
      database.close();
      removeTempHome(home);
    }
  },
);
it("指示を預けた後と届けて削除した後に、変更済みの待ち行列を購読者が読める", async () => {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  const app = await startRunnerApp({
    database,
    agent: new ControlledAgent({ rules: [] }),
    environment: testEnvironment(home),
    log: () => {},
  });
  try {
    const id = (
      await app.runtime.start({
        projectId: "p",
        cwd: home,
        kind: "chat",
        title: "会話",
        message: "first",
      })
    )._unsafeUnwrap().conversationId;
    const snapshots: string[][] = [];
    app.changes.subscribe((notice) => {
      if (notice.kind === "conversation_parts" && notice.parts.includes("queue"))
        snapshots.push(app.runtime.store.queue(id).map((item) => item.text));
    });
    const queued = (
      await app.runtime.send(id, { text: "queued", images: [], origin: "developer" })
    )._unsafeUnwrap();
    expect({ result: queued.result, snapshots }).toEqual({
      result: "queued",
      snapshots: [["queued"]],
    });
    await app.runtime.stop(id);
    const delivered = (await app.runtime.deliverQueue(id))._unsafeUnwrap();
    expect({ delivered, snapshots }).toEqual({
      delivered: { seq: 4 },
      snapshots: [["queued"], []],
    });
  } finally {
    await app.shutdown();
    database.close();
    removeTempHome(home);
  }
});
it.each(["waiting", "queued", "delivered"] as const)(
  "回答を渡して削除した後に、変更済みの回答を購読者が読める: %s",
  async (mode) => {
    const home = createTempHome();
    const database = openMigratedDatabase(home);
    const agent = new ControlledAgent({ rules: [] });
    const app = await startRunnerApp({
      database,
      agent,
      environment: testEnvironment(home),
      log: () => {},
    });
    try {
      const id = (
        await app.runtime.start({
          projectId: "p",
          cwd: home,
          kind: "chat",
          title: "会話",
          message: "first",
        })
      )._unsafeUnwrap().conversationId;
      const waiting = agent.sessions
        .get(id)
        ?.params.onQuestion({
          requestId: "question",
          questions: [
            {
              question: "選択",
              header: "質問",
              options: [{ label: "A", description: "a" }],
              multi_select: false,
            },
          ],
        })
        .catch(() => null);
      const seq = app.runtime.store.events(id).at(-1)?.seq;
      database.sqlite
        .prepare("INSERT INTO pending_answers VALUES (?, ?, ?, 1)")
        .run(id, seq, '{"0":{"choices":["A"],"text":""}}');
      if (mode !== "waiting") await app.runtime.stop(id);
      if (mode === "queued")
        await app.runtime.send(id, { text: "next", images: [], origin: "developer" });
      const read = () => ({
        pending: database.sqlite
          .prepare("SELECT * FROM pending_answers WHERE conversation_id = ?")
          .all(id),
        questions: database.sqlite
          .prepare("SELECT seq, answered FROM questions WHERE conversation_id = ?")
          .all(id),
      });
      const snapshots: ReturnType<typeof read>[] = [];
      app.changes.subscribe((notice) => {
        if (notice.kind === "conversation_parts" && notice.parts.includes("answers"))
          snapshots.push(read());
      });
      const result = (
        await app.runtime.answer(id, "question", { "0": { choices: ["A"], text: "" } })
      )._unsafeUnwrap();
      expect({ result: result.result, snapshots }).toEqual({
        result: mode === "waiting" ? "answered" : mode,
        snapshots: [{ pending: [], questions: [{ seq, answered: 1 }] }],
      });
      expect(await waiting).toEqual(mode === "waiting" ? { 選択: "A" } : null);
    } finally {
      await app.shutdown();
      database.close();
      removeTempHome(home);
    }
  },
);
it("IPC境界の例外だけをerrorログに残し、本文は公開せず終了中は再操作を案内する", async () => {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  const lines: string[] = [];
  const log = createLogger({ now: () => 0, level: "debug", write: (line) => lines.push(line) });
  const app = await startRunnerApp({
    database,
    agent: new ScriptedAgent({ rules: [] }),
    environment: testEnvironment(home),
    log,
  });
  const routes = createIpcRoutes(app.runtime, log, undefined, {
    workspace: async () => {
      throw new TypeError("workspace unavailable");
    },
  });
  try {
    const response = await routes.request("/conversations/a/workspace", {
      method: "POST",
      body: JSON.stringify({ cwd: "secret message" }),
    });
    expect({
      status: response.status,
      body: await response.json(),
      errors: lines
        .map((line) => JSON.parse(line) as unknown)
        .filter((line) => (line as { level: string }).level === "error"),
    }).toEqual({
      status: 500,
      body: {
        error: {
          code: "internal",
          message: "会話の操作に失敗しました。もう一度操作してください。",
        },
      },
      errors: [
        {
          time: "1970-01-01T00:00:00.000Z",
          level: "error",
          component: "runner.ipc",
          message: "会話の操作に失敗しました。",
          error: { name: "TypeError", message: "workspace unavailable" },
        },
      ],
    });
    await routes.request("/health");
    await routes.request("/conversations", { method: "POST", body: "{}" });
    await routes.request("/conversations/missing/stop", { method: "POST" });
    expect(
      lines
        .map((line) => JSON.parse(line) as { level: string })
        .filter((line) => line.level === "error").length,
    ).toBe(1);
    expect(lines.join("\n").includes("secret message")).toBe(false);
    app.runtime.closing = true;
    const closing = await routes.request("/health");
    expect({ status: closing.status, body: await closing.json() }).toEqual({
      status: 503,
      body: {
        error: {
          code: "runner_unavailable",
          message:
            "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
        },
      },
    });
    app.runtime.closing = false;
  } finally {
    await app.shutdown();
    database.close();
    removeTempHome(home);
  }
});

it("会話の操作を振り分け、409と400を返し、指示をログへ出さない", async () => {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  const logs: LogEntry[] = [];
  const app = await startRunnerApp({
    database,
    environment: testEnvironment(home),
    agent: new ScriptedAgent({ rules: [], fallback: [{ hold: true }] }),
    log: (entry) => logs.push(entry),
  });
  const routes = createIpcRoutes(app.runtime, (entry) => logs.push(entry));
  try {
    const create = await routes.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: "p",
        kind: "chat",
        cwd: home,
        title: "会話",
        message: "secret message",
      }),
    });
    const { conversation_id: id } = (await create.json()) as { conversation_id: string };
    expect(create.status).toBe(200);
    expect(app.runtime.store.events(id).map((e) => ({ type: e.type, payload: e.payload }))).toEqual(
      [
        {
          type: "user_message",
          payload: {
            text: "secret message",
            images: [],
            origin: "developer",
            client_ids: [],
            queued_ids: [],
            client_receipts: [],
          },
        },
      ],
    );
    const stopped = await routes.request(`/conversations/${id}/stop`, { method: "POST" });
    expect({ status: stopped.status, body: await stopped.json() }).toEqual({
      status: 200,
      body: { run_state: "stopped" },
    });
    const conflict = await routes.request(`/conversations/${id}/stop`, { method: "POST" });
    expect({ status: conflict.status, body: await conflict.json() }).toEqual({
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: "会話の状態が変わりました。もう一度操作してください。",
        },
      },
    });
    const invalid = await routes.request("/conversations", { method: "POST", body: "{}" });
    expect({ status: invalid.status, body: await invalid.json() }).toEqual({
      status: 400,
      body: { error: { code: "invalid_input", message: "入力を確認してください。" } },
    });
    const ipc = logs.filter((e) => e.component === "runner.ipc");
    expect(ipc.length).toBe(8);
    expect(JSON.stringify(ipc).includes("secret message")).toBe(false);
  } finally {
    await app.shutdown();
    database.close();
    removeTempHome(home);
  }
});
it("届く前の指示は作業中には届けず、停止後に明示して届けるとseqだけを返す", async () => {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  const app = await startRunnerApp({
    database,
    environment: testEnvironment(home),
    agent: new ScriptedAgent({ rules: [], fallback: [{ hold: true }] }),
    log: () => {},
  });
  const routes = createIpcRoutes(app.runtime, () => {});
  try {
    const id = (
      await app.runtime.start({
        projectId: "p",
        kind: "chat",
        cwd: home,
        title: "会話",
        message: "first",
      })
    )._unsafeUnwrap().conversationId;
    const queued = (
      await app.runtime.send(id, { text: "queued", images: [], origin: "developer" })
    )._unsafeUnwrap();
    if (queued.result !== "queued") throw new Error("指示が預けられませんでした。");
    const busy = await routes.request(`/conversations/${id}/queue/deliver`, { method: "POST" });
    expect({ status: busy.status, body: await busy.json() }).toEqual({
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: "会話の状態が変わりました。もう一度操作してください。",
        },
      },
    });
    await app.runtime.stop(id);
    const response = await routes.request(`/conversations/${id}/queue/deliver`, { method: "POST" });
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { seq: 4 },
    });
    expect(app.runtime.store.queue(id)).toEqual([]);
    expect(app.runtime.store.events(id).at(-1)?.payload).toEqual({
      text: "queued",
      images: [],
      origin: "queued",
      client_ids: [],
      queued_ids: [queued.queuedId],
      client_receipts: [],
    });
  } finally {
    await app.shutdown();
    database.close();
    removeTempHome(home);
  }
});
it("作業場所の振り分けは後続機能のPortへ渡し409を保つ", async () => {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  const app = await startRunnerApp({
    database,
    environment: testEnvironment(home),
    agent: new ScriptedAgent({ rules: [] }),
    log: () => {},
  });
  const calls: unknown[] = [];
  const routes = createIpcRoutes(app.runtime, () => {}, undefined, {
    workspace: async (id, input) => {
      calls.push({ id, input });
      return err({ code: "conflict", message: "作業場所を切り替えられません。" });
    },
  });
  try {
    const response = await routes.request("/conversations/a/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: "/work", worktree_id: "w" }),
    });
    expect({ status: response.status, body: await response.json(), calls }).toEqual({
      status: 409,
      body: { error: { code: "conflict", message: "作業場所を切り替えられません。" } },
      calls: [{ id: "a", input: { cwd: "/work", worktree_id: "w" } }],
    });
  } finally {
    await app.shutdown();
    database.close();
    removeTempHome(home);
  }
});
import { err } from "neverthrow";
import { testEnvironment } from "../../../../test/directories";
