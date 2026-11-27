import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
} from "../../../../shared/db/test-helpers";
import { SqliteConversationStore } from "../adapter/sqlite-conversation-store";
import { AsyncQueue } from "../../../../shared/async-queue";
import type { AgentOutput, AgentSession, OpenParams } from "../domain/agent-port";
import { ok } from "neverthrow";
import { turnEnd, ScriptedAgent } from "../adapter/scripted-agent";
import { ConversationRuntime, type RuntimeSignal } from "../usecase/runtime";
import type { AgentScript } from "../../../../shared/agent-script";
import type { Clock } from "../domain/clock";
import { recover } from "../usecase/recover";

class TestClock implements Clock {
  time = 100000;
  timers = new Map<number, { at: number; callback: () => void | Promise<void> }>();
  private seq = 0;
  now = () => this.time;
  setTimeout(callback: () => void | Promise<void>, ms: number): () => void {
    const id = ++this.seq;
    this.timers.set(id, { at: this.time + ms, callback });
    return () => {
      this.timers.delete(id);
    };
  }
  async advance(ms: number): Promise<void> {
    this.time += ms;
    for (const [id, timer] of this.timers) {
      if (timer.at <= this.time) {
        this.timers.delete(id);
        await timer.callback();
      }
    }
  }
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function fixture(script: AgentScript, allowResume = true) {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  const store = new SqliteConversationStore(database.sqlite);
  const agent = new ScriptedAgent(script);
  const clock = new TestClock();
  const signals: RuntimeSignal[] = [];
  const runtime = new ConversationRuntime({
    store,
    agent,
    clock,
    id: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
    uuid: (() => {
      let n = 0;
      return () => `session-${++n}`;
    })(),
    canResume: () => Promise.resolve(allowResume),
    log: () => {},
    notice: () => {},
  });
  runtime.subscribe((signal) => {
    signals.push(signal);
  });
  cleanups.push(async () => {
    await runtime.shutdown();
    database.close();
    removeTempHome(home);
  });
  const start = (kind: "chat" | "triage" = "chat", message?: string) =>
    runtime
      .start({ projectId: "p", kind, cwd: "/tmp", title: "会話", message })
      .then((r) => r._unsafeUnwrap().conversationId);
  const until = (id: string, predicate: () => boolean): Promise<void> => {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve) => {
      const off = runtime.subscribe((signal) => {
        if (signal.conversationId === id && predicate()) {
          off();
          resolve();
        }
      });
    });
  };
  return { home, database, store, agent, clock, runtime, start, until, signals };
}
const send = (text: string, clientId = text, interrupt = false) => ({
  text,
  clientId,
  interrupt,
  images: [],
  origin: "developer" as const,
});
const holdScript: AgentScript = {
  rules: [{ match: "^hold", steps: [{ text: "作業中" }, { hold: true }] }],
  fallback: [{ text: "完了" }, { end: "success" }],
};

class ControlledAgent extends ScriptedAgent {
  outputs: AsyncQueue<AgentOutput>[] = [];
  override open(params: OpenParams): AgentSession {
    this.opened.push(params);
    const output = new AsyncQueue<AgentOutput>();
    this.outputs.push(output);
    return {
      output,
      send: ({ text }) => {
        this.sent.push({ sessionId: params.sessionId, text });
      },
      interrupt: () => {
        output.push(turnEnd("error_during_execution"));
        return Promise.resolve();
      },
      close: () => output.close(),
      commands: () => Promise.resolve([]),
    };
  }
}

it.each(
  [
    [false, true],
    [true, false],
    [false, true, false, true],
    [true, true],
  ].map((numbered) => ({ numbered })),
)("番号の有無が混在する指示 %j の配達後も初回の受付結果を返す", async ({ numbered }) => {
  const f = fixture(holdScript);
  const id = await f.start("chat", "hold");
  const accepted = [];
  for (const [index, hasId] of numbered.entries()) {
    const input = {
      text: `q${index}`,
      images: [],
      origin: "flow" as const,
      ...(hasId ? { clientId: `c${index}` } : {}),
    };
    accepted.push({ input, result: (await f.runtime.send(id, input))._unsafeUnwrap() });
  }
  const direct = send("new", "direct", true);
  const delivered = (await f.runtime.send(id, direct))._unsafeUnwrap();
  await f.until(id, () => f.store.get(id)?.runState === "idle");
  for (const { input, result } of accepted)
    if (input.clientId) expect((await f.runtime.send(id, input))._unsafeUnwrap()).toEqual(result);
  expect((await f.runtime.send(id, direct))._unsafeUnwrap()).toEqual(delivered);
  expect(f.agent.sent.map((m) => m.text)).toEqual([
    "hold",
    [...numbered.map((_, i) => `q${i}`), "new"].join("\n\n"),
  ]);
  await f.clock.advance(600001);
  expect((await f.runtime.send(id, direct))._unsafeUnwrap().result).toBe("delivered");
});

it.each(["developer", "usage_limit", "flow"] as const)(
  "%s の再開は預かった指示を成功まで残す",
  async (by) => {
    const f = fixture(holdScript);
    const agent = new ControlledAgent({ rules: [] });
    f.runtime.options.agent = agent;
    const id = await f.start("chat", "hold");
    await f.runtime.send(id, send("one"));
    await f.runtime.send(id, send("two"));
    await f.runtime.stop(id);
    f.runtime.record(id, [{ type: "stopped", payload: { reason: "error" } }]);
    const queue = f.store.queue(id);
    await f.runtime.resume(id, by);
    expect({ sent: agent.sent.map((m) => m.text), queue: f.store.queue(id) }).toEqual({
      sent: ["hold", "中断したところから続けてください。"],
      queue,
    });
    agent.outputs[0].push(turnEnd("success"));
    await f.until(id, () => f.store.events(id).filter((e) => e.type === "turn_end").length === 2);
    await f.runtime.serial(id, () => Promise.resolve(ok(undefined)));
    expect({ sent: agent.sent.map((m) => m.text), queue: f.store.queue(id) }).toEqual({
      sent: ["hold", "中断したところから続けてください。", "one\n\ntwo"],
      queue: [],
    });
  },
);

it.each(["event", "runStateChanged", "turnEnded"] as const)(
  "%s の受け手から送信しても空の指示を預けない",
  async (type) => {
    const f = fixture(holdScript);
    const agent = new ControlledAgent({ rules: [] });
    f.runtime.options.agent = agent;
    const id = await f.start("chat", "hold");
    await f.runtime.send(id, send("queued"));
    let next: Promise<unknown> | undefined;
    const off = f.runtime.subscribe((signal) => {
      if (signal.type === type && f.store.get(id)?.runState === "idle" && !next)
        next = f.runtime.send(id, send("new"));
    });
    agent.outputs[0].push(turnEnd("success"));
    await f.until(id, () => f.store.events(id).some((e) => e.type === "turn_end"));
    await next;
    await f.runtime.serial(id, () => Promise.resolve(ok(undefined)));
    off();
    expect({ sent: agent.sent.map((m) => m.text), queue: f.store.queue(id) }).toEqual({
      sent: ["hold", "queued\n\nnew"],
      queue: [],
    });
  },
);

it.each(["event", "runStateChanged", "turnEnded", "stopped", "inputRecorded", "delta"] as const)(
  "%s の同期・非同期購読者が失敗しても他の受け手と操作を続ける",
  async (type) => {
    for (const asynchronous of [false, true]) {
      const f = fixture(holdScript);
      const agent = new ControlledAgent({ rules: [] });
      f.runtime.options.agent = agent;
      const id = await f.start();
      const logs: unknown[][] = [];
      let logged: (() => void) | undefined;
      const failureLogged = new Promise<void>((resolve) => {
        logged = resolve;
      });
      f.runtime.options.log = (...args) => {
        if (args[1] === "会話の合図の受け手が失敗しました。") {
          logs.push(args);
          logged?.();
        }
      };
      const error = new Error("subscriber failed");
      const off = f.runtime.subscribe((signal) => {
        if (signal.type !== type) return;
        if (asynchronous) return Promise.reject(error);
        throw error;
      });
      await f.runtime.send(id, send("run"));
      agent.outputs[0].push({ kind: "text_delta", text: "途中", parentToolUseId: null });
      agent.outputs[0].push(turnEnd("success"));
      await f.until(id, () => f.store.get(id)?.runState === "idle");
      f.runtime.record(id, [{ type: "stopped", payload: { reason: "error" } }]);
      await failureLogged;
      off();
      await f.runtime.send(id, send("next"));
      const count = type === "event" || type === "runStateChanged" ? 3 : 1;
      expect(logs).toEqual(
        Array.from({ length: count }, () => [
          { conversationId: id, issueId: null },
          "会話の合図の受け手が失敗しました。",
          error,
        ]),
      );
      expect({
        observed: f.signals.filter((s) => s.type === type).length > 0,
        sent: agent.sent.map((m) => m.text),
        state: f.store.get(id)?.runState,
      }).toEqual({ observed: true, sent: ["run", "next"], state: "working" });
    }
  },
);

it.each([
  "developer",
  "stock",
  "queued",
  "interrupt",
  "answer_text",
  "resume",
  "flow",
  "finish_proposal",
] as const)("%s の入力と番の終了の内部合図に保存済み番号と状態を載せる", async (origin) => {
  const f = fixture(holdScript);
  const agent = new ControlledAgent({ rules: [] });
  f.runtime.options.agent = agent;
  const id = await f.start();
  await f.runtime.send(id, { text: "run", images: [], origin });
  agent.outputs[0].push(turnEnd("success"));
  await f.until(id, () => f.store.get(id)?.runState === "idle");
  expect(f.signals.filter((s) => s.type !== "event")).toEqual([
    ...(["developer", "stock", "queued", "interrupt", "answer_text"].includes(origin)
      ? [{ type: "inputRecorded", conversationId: id, seq: 1, eventType: "user_message" }]
      : []),
    { type: "runStateChanged", conversationId: id, previous: "idle", current: "working" },
    { type: "runStateChanged", conversationId: id, previous: "working", current: "idle" },
    { type: "turnEnded", conversationId: id, startSeq: 1, endSeq: 2, subtype: "success" },
  ]);
  expect(
    f.signals
      .filter((s) => s.type === "event")
      .map((s) => ({ ...s.event, sdkUuid: s.event.sdkUuid ?? null })),
  ).toEqual(f.store.events(id));
});

it("停止・再開・回答の合図を完全な値で出し、割り込みではstoppedを出さない", async () => {
  const f = fixture(holdScript);
  const agent = new ControlledAgent({ rules: [] });
  f.runtime.options.agent = agent;
  const id = await f.start("chat", "hold");
  await f.runtime.send(id, send("interrupt", "interrupt", true));
  await f.runtime.stop(id);
  f.runtime.record(id, [
    { type: "stopped", payload: { reason: "restarted", previous_run_state: "working" } },
  ]);
  await f.runtime.resume(id);
  f.runtime.record(id, [
    { type: "answer", payload: { request_id: "old", answers: {}, as_message: true } },
  ]);
  expect(
    f.signals.filter((s) => ["stopped", "inputRecorded", "turnEnded"].includes(s.type)),
  ).toEqual([
    { type: "inputRecorded", conversationId: id, seq: 1, eventType: "user_message" },
    {
      type: "turnEnded",
      conversationId: id,
      startSeq: 1,
      endSeq: 2,
      subtype: "error_during_execution",
    },
    { type: "inputRecorded", conversationId: id, seq: 3, eventType: "user_message" },
    { type: "stopped", conversationId: id, reason: "user" },
    {
      type: "turnEnded",
      conversationId: id,
      startSeq: 3,
      endSeq: 4,
      subtype: "error_during_execution",
    },
    { type: "stopped", conversationId: id, reason: "restarted", previousRunState: "working" },
    { type: "inputRecorded", conversationId: id, seq: 7, eventType: "resumed" },
    { type: "inputRecorded", conversationId: id, seq: 9, eventType: "answer" },
  ]);
});

it.each(["open", "closing", "queue", "message"] as const)(
  "待ちの消えた回答の%s失敗では未送信回答を保持する",
  async (failure) => {
    const f = fixture(holdScript);
    const id = await f.start();
    f.runtime.record(id, [
      {
        type: "question",
        payload: {
          request_id: "old",
          questions: [{ question: "方針", header: "方針", options: [], multi_select: false }],
        },
      },
    ]);
    const answers = { "0": { choices: ["A"], text: "saved" } };
    f.database.sqlite
      .prepare("INSERT INTO pending_answers VALUES (?, 1, ?, 1)")
      .run(id, JSON.stringify(answers));
    f.database.sqlite
      .prepare("UPDATE conversations SET run_state = ? WHERE id = ?")
      .run(failure === "queue" ? "working" : "stopped", id);
    if (failure === "open")
      f.agent.open = () => {
        throw new Error("open failed");
      };
    if (failure === "closing") f.runtime.closing = true;
    if (failure === "queue")
      f.database.sqlite.exec(
        "CREATE TRIGGER reject_queue BEFORE INSERT ON queued_instructions BEGIN SELECT RAISE(ABORT, 'queue failed'); END",
      );
    if (failure === "message")
      f.database.sqlite.exec(
        "CREATE TRIGGER reject_message BEFORE INSERT ON conversation_events WHEN NEW.type = 'user_message' BEGIN SELECT RAISE(ABORT, 'message failed'); END",
      );
    expect((await f.runtime.answer(id, "old", answers)).isErr()).toBe(true);
    f.runtime.closing = false;
    expect({
      pending: f.database.sqlite.prepare("SELECT * FROM pending_answers").all(),
      questions: f.database.sqlite.prepare("SELECT text, answered FROM questions").all(),
      accepted: f.store.events(id).filter((e) => e.type === "answer" || e.type === "user_message"),
      queue: f.store.queue(id),
      sent: f.agent.sent,
    }).toEqual({
      pending: [
        { conversation_id: id, question_seq: 1, answers: JSON.stringify(answers), updated_at: 1 },
      ],
      questions: [{ text: "方針", answered: 0 }],
      accepted: [],
      queue: [],
      sent: [],
    });
  },
);

it.each(["sync", "async"] as const)(
  "SDK初期化前の%s失敗は新規として再試行し、成立後は再開する",
  async (failure) => {
    const f = fixture(holdScript);
    const id = await f.start();
    const original = f.agent.open.bind(f.agent);
    f.agent.open = (params) => {
      if (params.resume) throw new Error("履歴なしresume");
      if (failure === "sync") throw new Error("open failed");
      return {
        output: {
          [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("before init")) }),
        },
        send: () => {},
        interrupt: () => Promise.resolve(),
        close: () => {},
        commands: () => Promise.resolve([]),
      };
    };
    await f.runtime.send(id, send("first"));
    await f.until(id, () => f.store.get(id)?.runState === "failed");
    f.agent.open = (params) => {
      if (params.resume) throw new Error("履歴なしresume");
      return original(params);
    };
    expect((await f.runtime.send(id, send("retry")))._unsafeUnwrap().result).toBe("delivered");
    await f.until(id, () => f.store.get(id)?.runState === "idle");
    await f.runtime.release(id);
    const restored = new SqliteConversationStore(f.database.sqlite);
    f.runtime.options.agent = f.agent;
    f.agent.open = original;
    const recreated = new ConversationRuntime({ ...f.runtime.options, store: restored });
    try {
      await recreated.send(id, send("after release"));
      if (restored.get(id)?.runState !== "idle")
        await new Promise<void>((resolve) => {
          const off = recreated.subscribe(() => {
            if (restored.get(id)?.runState === "idle") {
              off();
              resolve();
            }
          });
        });
    } finally {
      await recreated.shutdown();
    }
    expect({
      resume: f.agent.opened.map((p) => p.resume),
      session: restored.get(id)?.sessionId,
      sent: f.agent.sent.map((m) => m.text),
    }).toEqual({
      resume: [false, true],
      session: f.agent.opened[0].sessionId,
      sent: ["retry", "after release"],
    });
  },
);

it("SDK の履歴が成立する前の会話は分岐せず状態の競合を返す", async () => {
  const f = fixture(holdScript);
  const id = await f.start();
  expect((await f.runtime.fork(id, { title: "分岐", kind: "thread" }))._unsafeUnwrapErr()).toEqual({
    code: "conflict",
    message: "会話の状態が変わりました。もう一度操作してください。",
  });
  expect(f.store.list().map((c) => c.id)).toEqual([id]);
});

describe("会話の実行と記録", () => {
  it("最初の指示なしでは行だけ作り、指示のあと出力を順序と状態と時刻ごと保存する", async () => {
    const f = fixture(holdScript);
    const id = await f.start();
    expect({
      state: f.store.get(id)?.runState,
      events: f.store.events(id),
      opens: f.agent.opened.length,
    }).toEqual({ state: "idle", events: [], opens: 0 });
    const delivered = (await f.runtime.send(id, send("run")))._unsafeUnwrap();
    await f.until(id, () => f.store.get(id)?.runState === "idle");
    expect(delivered).toEqual({ result: "delivered", seq: 1 });
    expect(
      f.store.events(id).map(({ type, seq, createdAt }) => ({ type, seq, createdAt })),
    ).toEqual([
      { type: "user_message", seq: 1, createdAt: 100000 },
      { type: "assistant_text", seq: 2, createdAt: 100000 },
      { type: "turn_end", seq: 3, createdAt: 100000 },
    ]);
    expect({
      seq: f.store.get(id)?.lastSeq,
      activity: f.store.get(id)?.lastActivityAt,
      state: f.store.get(id)?.runState,
    }).toEqual({ seq: 3, activity: 100000, state: "idle" });
    expect(
      f.agent.opened.map(({ model, permissionMode, appendSystemPrompt }) => ({
        model,
        permissionMode,
        appendSystemPrompt,
      })),
    ).toEqual([{ model: null, permissionMode: "bypassPermissions", appendSystemPrompt: "" }]);
  });

  it("イベント追加後の状態更新が失敗すると両方の書き込みがロールバックする", async () => {
    const f = fixture(holdScript);
    const id = await f.start();
    f.database.sqlite.exec(
      "CREATE TRIGGER reject_state BEFORE UPDATE ON conversations BEGIN SELECT RAISE(ABORT, 'reject'); END",
    );
    expect(() =>
      f.store.transaction(() =>
        f.store.append(
          id,
          { type: "user_message", payload: { text: "run", images: [], origin: "developer" } },
          f.clock.now(),
        ),
      ),
    ).toThrow("reject");
    expect({
      events: f.store.events(id),
      state: f.store.get(id)?.runState,
      seq: f.store.get(id)?.lastSeq,
    }).toEqual({ events: [], state: "idle", seq: 0 });
  });

  it("作業中の指示を順に預け、成功した番のあと一通で届け、二重送信は元の結果を返す", async () => {
    const f = fixture({
      rules: [
        {
          match: "^start",
          steps: [
            { ask: [{ question: "続けますか", header: "確認", options: [], multi_select: false }] },
            { end: "success" },
          ],
        },
      ],
      fallback: [{ text: "受信" }, { end: "success" }],
    });
    const id = await f.start("chat", "start");
    await f.until(id, () => f.store.get(id)?.runState === "waiting_answer");
    const first = (await f.runtime.send(id, send("one", "client1")))._unsafeUnwrap();
    await f.runtime.send(id, send("two", "client2"));
    expect((await f.runtime.send(id, send("one", "client1")))._unsafeUnwrap()).toEqual(first);
    const question = f.store.events(id).find((e) => e.type === "question");
    if (question?.type !== "question") throw new Error("質問なし");
    await f.runtime.answer(id, question.payload.request_id, {});
    await f.until(id, () => f.agent.sent.length === 2 && f.store.get(id)?.runState === "idle");
    expect(f.agent.sent.map((m) => m.text)).toEqual(["start", "one\n\ntwo"]);
    expect((await f.runtime.send(id, send("one", "client1")))._unsafeUnwrap()).toEqual(first);
    expect(f.store.queue(id)).toEqual([]);
    expect(
      f.store.events(id).flatMap((e) => (e.type === "user_message" ? [e.payload] : [])),
    ).toEqual([
      {
        text: "start",
        images: [],
        origin: "developer",
        client_ids: [],
        queued_ids: [],
        client_receipts: [],
      },
      {
        text: "one\n\ntwo",
        images: [],
        origin: "queued",
        client_ids: ["client1", "client2"],
        client_receipts: [
          { client_id: "client1", result: "queued", queued_id: "id-2", received_at: 100000 },
          { client_id: "client2", result: "queued", queued_id: "id-3", received_at: 100000 },
        ],
        queued_ids: [first.result === "queued" ? first.queuedId : "", "id-3"],
      },
    ]);
  });

  it.each([false, true])("停止と割り込み %s で保留した指示の扱いを分ける", async (interrupt) => {
    const f = fixture(holdScript);
    const id = await f.start("chat", "hold");
    await f.until(id, () => f.store.events(id).some((e) => e.type === "assistant_text"));
    await f.runtime.send(id, send("queued"));
    if (interrupt) {
      await f.runtime.send(id, send("new", "new", true));
      await f.until(id, () => f.store.get(id)?.runState === "idle");
      expect(f.agent.sent.map((m) => m.text)).toEqual(["hold", "queued\n\nnew"]);
      expect(f.store.events(id).filter((e) => e.type === "stopped")).toEqual([]);
    } else {
      expect((await f.runtime.stop(id))._unsafeUnwrap()).toEqual({ runState: "stopped" });
      expect({
        queued: f.store.queue(id).map((q) => q.text),
        sent: f.agent.sent.map((m) => m.text),
        state: f.store.get(id)?.runState,
      }).toEqual({ queued: ["queued"], sent: ["hold"], state: "stopped" });
    }
  });

  it.each(["allow", "deny"] as const)(
    "質問をまとめて回答し、許可に %s を返すと同じ実行が続く",
    async (behavior) => {
      const f = fixture({
        rules: [],
        fallback: [
          {
            ask: [
              { question: "方針", header: "A", options: [], multi_select: true },
              { question: "未回答", header: "B", options: [], multi_select: false },
            ],
          },
          { permission: { tool_name: "Bash", input: { command: "ls" } } },
          { text: "続行" },
          { end: "success" },
        ],
      });
      const id = await f.start("chat", "run");
      await f.until(id, () => f.store.get(id)?.runState === "waiting_answer");
      const question = f.store.events(id).find((e) => e.type === "question");
      if (question?.type !== "question") throw new Error("質問なし");
      expect(
        (
          await f.runtime.answer(id, question.payload.request_id, {
            "0": { choices: ["A", "B"], text: "詳しく" },
          })
        )._unsafeUnwrap(),
      ).toEqual({ result: "answered", seq: 3 });
      await f.until(id, () => f.store.get(id)?.runState === "waiting_permission");
      const permission = f.store.events(id).find((e) => e.type === "permission_request");
      if (permission?.type !== "permission_request") throw new Error("許可なし");
      await f.runtime.permission(
        id,
        permission.payload.request_id,
        behavior === "allow" ? { behavior } : { behavior, message: "不要" },
      );
      await f.until(id, () => f.store.get(id)?.runState === "idle");
      expect(f.agent.receivedAnswers.map((answer) => answer.answers)).toEqual([
        { 方針: "A、B: 詳しく", 未回答: "(開発者は答えなかった)" },
      ]);
      expect(f.agent.permissionDecisions.map((answer) => answer.decision)).toEqual([
        behavior === "allow" ? { behavior } : { behavior, message: "不要" },
      ]);
      expect(f.store.events(id).map((e) => e.type)).toEqual([
        "user_message",
        "question",
        "answer",
        "permission_request",
        "permission_decision",
        "assistant_text",
        "turn_end",
      ]);
      expect(
        f.database.sqlite.prepare("SELECT text, answered FROM questions ORDER BY rowid").all(),
      ).toEqual([
        { text: "方針", answered: 1 },
        { text: "未回答", answered: 1 },
      ]);
    },
  );

  it.each(["working", "waiting_answer", "waiting_permission"] as const)(
    "再起動で %s を前の状態つきで停止し、待ちが消えた回答は指示として送る",
    async (state) => {
      const f = fixture({ rules: [], fallback: [{ hold: true }] });
      const id = await f.start();
      f.store.transaction(() =>
        f.store.append(
          id,
          {
            type: "question",
            payload: {
              request_id: "old",
              questions: [{ question: "方針", header: "方針", options: [], multi_select: false }],
            },
          },
          f.clock.now(),
        ),
      );
      f.database.sqlite
        .prepare("UPDATE conversations SET run_state = ? WHERE id = ?")
        .run(state, id);
      recover(f.runtime);
      expect(f.store.events(id).at(-1)?.payload).toEqual({
        reason: "restarted",
        previous_run_state: state,
      });
      expect(
        (
          await f.runtime.answer(id, "old", { "0": { choices: ["A"], text: null } })
        )._unsafeUnwrap(),
      ).toEqual({ result: "delivered", seq: 4 });
      expect(f.agent.sent.map((m) => m.text)).toEqual(["Q: 方針\nA: A"]);
      expect(
        (await f.runtime.permission(id, "old", { behavior: "allow" }))._unsafeUnwrapErr(),
      ).toEqual({
        code: "conflict",
        message:
          "AI を動かすプロセスが再起動したため、この確認は無効になりました。指示を送って続けてください。",
      });
    },
  );

  it("分岐の行を親の参照と新しいセッションで作り、最初の指示を再開で送る", async () => {
    const f = fixture(holdScript);
    const parent = await f.start("chat", "run");
    await f.until(parent, () => f.store.get(parent)?.runState === "idle");
    const id = (await f.runtime.fork(parent, { title: "スレッド", kind: "thread" }))._unsafeUnwrap()
      .conversationId;
    expect({
      parent: f.store.get(id)?.parentConversationId,
      state: f.store.get(id)?.runState,
    }).toEqual({ parent, state: "idle" });
    await f.runtime.send(id, send("first"));
    await f.until(id, () => f.store.get(id)?.runState === "idle");
    expect(f.agent.opened.at(-1)?.resume).toBe(true);
  });

  it.each([123, null])(
    "利用枠の戻る時刻 %s のあと偽時計で再開し、最後の知らせを保存する",
    async (resetsAt) => {
      const f = fixture({
        rules: [
          {
            match: "^limit",
            steps: [
              { rate_limit: { status: "allowed", resetsAt: 999 } },
              { rate_limit: { status: "rejected", resetsAt } },
              { end: "error_during_execution" },
            ],
          },
        ],
        fallback: [{ end: "success" }],
      });
      const id = await f.start("chat", "limit");
      await f.until(id, () => f.store.get(id)?.runState === "usage_limited");
      expect(f.store.rateLimit()).toEqual({
        status: "rejected",
        resetsAt: resetsAt === null ? null : resetsAt * 1000,
        overageStatus: null,
        observedAt: 100000,
      });
      const delay = resetsAt === null ? 900000 : resetsAt * 1000 + 60000 - f.clock.now();
      await f.clock.advance(delay - 1);
      expect(f.agent.sent.map((m) => m.text)).toEqual(["limit"]);
      await f.clock.advance(1);
      await f.until(id, () => f.agent.sent.length === 2 && f.store.get(id)?.runState === "idle");
      expect(f.agent.sent.map((m) => m.text)).toEqual([
        "limit",
        "中断したところから続けてください。",
      ]);
      expect(
        f.store
          .events(id)
          .filter((e) => e.type === "resumed")
          .map((e) => e.payload),
      ).toEqual([{ by: "usage_limit" }]);
    },
  );

  it.each(["denied", "released", "closed"])(
    "%s の利用枠切れの会話はタイマーで再開しない",
    async (mode) => {
      const f = fixture(
        {
          rules: [],
          fallback: [
            { rate_limit: { status: "rejected", resetsAt: 123 } },
            { end: "error_during_execution" },
          ],
        },
        mode !== "denied",
      );
      const id = await f.start(mode === "denied" ? "triage" : "chat", "limit");
      await f.until(id, () => f.store.get(id)?.runState === "usage_limited");
      if (mode === "released") await f.runtime.release(id);
      if (mode === "closed")
        f.database.sqlite.prepare("UPDATE conversations SET closed_at = 1 WHERE id = ?").run(id);
      await f.clock.advance(1000000);
      await Promise.resolve();
      await Promise.resolve();
      expect({ sent: f.agent.sent.map((m) => m.text), state: f.store.get(id)?.runState }).toEqual({
        sent: ["limit"],
        state: "usage_limited",
      });
    },
  );
});

it("質問を待つ AI を停止すると拒否で待ちを解き、回答は次の作業中には預ける", async () => {
  const f = fixture({
    rules: [
      {
        match: "^ask",
        steps: [
          { ask: [{ question: "方針", header: "方針", options: [], multi_select: false }] },
          { end: "success" },
        ],
      },
    ],
    fallback: [{ hold: true }],
  });
  const id = await f.start("chat", "ask");
  await f.until(id, () => f.store.get(id)?.runState === "waiting_answer");
  const question = f.store.events(id).find((e) => e.type === "question");
  if (question?.type !== "question") throw new Error("質問なし");
  expect((await f.runtime.stop(id))._unsafeUnwrap()).toEqual({ runState: "stopped" });
  await f.runtime.send(id, send("next"));
  expect(
    (
      await f.runtime.answer(id, question.payload.request_id, {
        "0": { choices: ["A"], text: null },
      })
    )._unsafeUnwrap(),
  ).toEqual({ result: "queued" });
  expect({
    state: f.store.get(id)?.runState,
    sent: f.agent.sent.map((m) => m.text),
    queue: f.store.queue(id).map((q) => q.text),
  }).toEqual({ state: "working", sent: ["ask", "next"], queue: ["Q: 方針\nA: A"] });
});

it("同じ送信を10分の境界で拒まず、期限を過ぎたら新しい指示として届ける", async () => {
  const f = fixture({ rules: [], fallback: [{ end: "success" }] });
  const id = await f.start();
  const first = (await f.runtime.send(id, send("run", "client")))._unsafeUnwrap();
  await f.until(id, () => f.store.get(id)?.runState === "idle");
  await f.clock.advance(600000);
  expect((await f.runtime.send(id, send("run", "client")))._unsafeUnwrap()).toEqual(first);
  await f.clock.advance(1);
  expect((await f.runtime.send(id, send("run", "client")))._unsafeUnwrap()).toEqual({
    result: "delivered",
    seq: 3,
  });
  await f.until(id, () => f.store.get(id)?.runState === "idle");
  expect(f.agent.sent.map((m) => m.text)).toEqual(["run", "run"]);
});

it("AI の実行を開けないときは理由つきで失敗を記録し、次の指示で再試行できる", async () => {
  const f = fixture({ rules: [], fallback: [{ end: "success" }] });
  const id = await f.start();
  const original = f.agent.open.bind(f.agent);
  f.agent.open = () => {
    throw new Error("ログインの有効期限が切れました。");
  };
  expect((await f.runtime.send(id, send("first"))).isErr()).toBe(true);
  expect({ state: f.store.get(id)?.runState, payload: f.store.events(id).at(-1)?.payload }).toEqual(
    { state: "failed", payload: { reason: "error", detail: "ログインの有効期限が切れました。" } },
  );
  f.agent.open = original;
  await f.runtime.send(id, send("retry"));
  await f.until(id, () => f.store.get(id)?.runState === "idle");
  expect(f.agent.sent.map((m) => m.text)).toEqual(["retry"]);
});

it("同じ SDK の出力をもう一度受けても記録と番号を増やさない", async () => {
  const f = fixture({ rules: [] });
  const id = await f.start();
  const event = {
    type: "assistant_text" as const,
    sdkUuid: "sdk:text:0",
    payload: { text: "出力", parent_tool_use_id: null },
  };
  f.runtime.record(id, [event]);
  f.runtime.record(id, [event]);
  expect(f.store.events(id)).toEqual([{ ...event, conversationId: id, seq: 1, createdAt: 100000 }]);
  expect({ lastSeq: f.store.get(id)?.lastSeq, state: f.store.get(id)?.runState }).toEqual({
    lastSeq: 1,
    state: "idle",
  });
});
