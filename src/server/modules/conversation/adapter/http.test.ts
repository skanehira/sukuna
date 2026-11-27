import { createWorktreeActivity } from "../../../../shared/workspace/sqlite-worktree-activity";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type {
  ConversationSnapshot,
  ConversationEventsPage,
  ConversationQueueItem,
} from "../../../../shared/conversation/api";
import { afterEach, expect, it } from "vite-plus/test";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { err, ok } from "neverthrow";
import { issueInstructions } from "../../../../runner/modules/issue/domain/issue-instructions";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
} from "../../../../shared/db/test-helpers";
import { readEnvironment } from "../../../../shared/env";
import type { AgentScript } from "../../../../shared/agent-script";
import type {
  AgentSession,
  OpenParams,
} from "../../../../runner/modules/conversation/domain/agent-port";
import type { Clock } from "../../../../runner/modules/conversation/domain/clock";
import { ScriptedAgent } from "../../../../runner/modules/conversation/adapter/scripted-agent";
import { startRunnerApp } from "../../../../runner/app";
import { createApp } from "../../../app";
import { RunnerLink, runnerUnavailable } from "../../../runner-link";
import { WsHub } from "../../../ws-hub";
import { createClockFake, createTailscaleFake, incomingWith } from "../../identity/test-support";
import { createConversationDependencies } from "./dependencies";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class RecordingAgent extends ScriptedAgent {
  messages: { text: string; images: { data: Buffer; mediaType: string }[] }[] = [];
  closedSessions: string[] = [];
  beforeInterrupt?: () => Promise<void>;
  beforeOutputEnd?: () => Promise<void>;
  beforeTurnEnd?: () => Promise<void>;
  beforeSend?: (params: OpenParams) => void;
  override open(params: OpenParams): AgentSession {
    const index = this.opened.length;
    const session = super.open(params);
    const finishOutput = () => this.beforeOutputEnd?.();
    const beforeTurnEnd = () => this.beforeTurnEnd?.();
    return {
      ...session,
      output: {
        async *[Symbol.asyncIterator]() {
          for await (const output of session.output) {
            if (output.kind === "turn_end") await beforeTurnEnd();
            yield output;
          }
          if (index === 0) await finishOutput();
        },
      },
      send: (message) => {
        this.beforeSend?.(params);
        this.messages.push(message);
        session.send(message);
      },
      close: () => {
        this.closedSessions.push(params.sessionId);
        session.close();
      },
      interrupt: async () => {
        await this.beforeInterrupt?.();
        await session.interrupt();
      },
      commands: async () => [{ name: "/dev-spec", description: "設計ループ。手順を進める" }],
    };
  }
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
  "base64",
);
class RunnerClock implements Clock {
  time = 1000;
  private timers = new Map<symbol, { at: number; callback: () => void | Promise<void> }>();
  now = () => this.time;
  setTimeout(callback: () => void | Promise<void>, ms: number): () => void {
    const id = Symbol();
    this.timers.set(id, { at: this.time + ms, callback });
    return () => this.timers.delete(id);
  }
  async advance(ms: number): Promise<void> {
    const until = this.time + ms;
    for (;;) {
      const next = [...this.timers].sort(([, a], [, b]) => a.at - b.at)[0];
      if (!next || next[1].at > until) break;
      const [id, timer] = next;
      this.time = timer.at;
      this.timers.delete(id);
      await timer.callback();
    }
    this.time = until;
  }
}
async function fixture(
  script: AgentScript = { rules: [], fallback: [{ text: "受け取りました" }, { hold: true }] },
  ipcClock?: RunnerClock,
) {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  database.sqlite
    .prepare("INSERT INTO projects (id,name,path,default_branch) VALUES ('p','project',?,'main')")
    .run(home);
  const scriptPath = join(home, "agent.json");
  writeFileSync(scriptPath, JSON.stringify(script));
  const environment = readEnvironment(
    "runner",
    { SUKUNA_HOME: home, SUKUNA_AGENT: "fake", SUKUNA_AGENT_SCRIPT: scriptPath },
    home,
    () => true,
  )._unsafeUnwrap();
  const agent = new RecordingAgent(script);
  const clock = new RunnerClock();
  let runner = await startRunnerApp({ database, agent, environment, clock, log: () => {} });
  const hub = new WsHub(database.sqlite);
  const notices: unknown[] = [];
  const link = new RunnerLink({
    socket: environment.socket,
    clock: ipcClock,
    now: ipcClock?.now,
    log: () => {},
    notice: (notice) => {
      notices.push(notice);
      hub.notice(notice);
    },
    connection: () => {},
  });
  const deps = createConversationDependencies({
    sqlite: database.sqlite,
    home,
    runner: link,
    id: (() => {
      let n = 0;
      return () => `01J0000000000000000000${String(++n).padStart(5, "0")}`;
    })(),
    now: clock.now,
    changed: (id, parts) => hub.notice({ kind: "conversation_parts", conversation_id: id, parts }),
    reopened: (ids) =>
      ids.forEach((id) =>
        hub.notice({ kind: "conversation_parts", conversation_id: id, parts: [] }),
      ),
  });
  const app = createApp({
    build: "test",
    identity: {
      login: "test@example.com",
      devIdentity: "1",
      tailscale: createTailscaleFake().api,
      clock: createClockFake(),
    },
    conversations: deps,
  });
  const request = async <T = unknown>(path: string, method = "GET", input?: unknown) => {
    const response = await app.request(
      `/api${path}`,
      {
        method,
        ...(input === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(input) }),
      },
      incomingWith("127.0.0.1", 1),
    );
    return {
      status: response.status,
      body: (response.status === 204 ? null : await response.json()) as T,
    };
  };
  const start = async () => {
    const response = await request("/conversations", "POST", {
      projectId: "p",
      workspace: { kind: "project" },
    });
    expect(response.status).toBe(201);
    return (response.body as { conversation: { id: string } }).conversation.id;
  };
  const send = (
    id: string,
    text: string,
    clientMessageId = text,
    mode = "send",
    images: string[] = [],
  ) =>
    request<{ result: "delivered" | "queued"; queueItem: ConversationQueueItem | null }>(
      `/conversations/${id}/messages`,
      "POST",
      { text, images, clientMessageId, mode },
    );
  const upload = async (id: string, data = png, mediaType = "image/png") => {
    const response = await app.request(
      `/api/conversations/${id}/images`,
      { method: "POST", headers: { "content-type": mediaType }, body: data },
      incomingWith("127.0.0.1", 1),
    );
    return {
      status: response.status,
      body: (await response.json()) as { image: { id: string; mediaType: string; bytes: number } },
    };
  };
  cleanups.push(async () => {
    link.stop();
    await runner.shutdown();
    database.close();
    removeTempHome(home);
  });
  return {
    home,
    database,
    agent,
    clock,
    hub,
    link,
    notices,
    request,
    snapshot: (id: string) => request<ConversationSnapshot>(`/conversations/${id}`),
    resume: (id: string) => request(`/conversations/${id}/resume`, "POST"),
    start,
    send,
    upload,
    deps,
    runner: () => runner,
    restart: async () => {
      await runner.shutdown();
      runner = await startRunnerApp({ database, agent, environment, clock, log: () => {} });
    },
  };
}
const delivered = { status: 202, body: { result: "delivered", queueItem: null } };
const invalid = {
  status: 400,
  body: { error: { code: "invalid_input", message: "入力を確認してください。" } },
};
async function settled(f: Awaited<ReturnType<typeof fixture>>, id: string, state: string) {
  await expect.poll(() => f.runner().runtime.store.get(id)?.runState).toBe(state);
}

const resumeText = "中断したところから続けてください。";
const resumeAccepted = { status: 202, body: { runState: "working" } };
const resumeConflict = {
  status: 409,
  body: {
    error: { code: "conflict", message: "会話の状態が変わりました。もう一度操作してください。" },
  },
};
const rateLimit = [
  { rate_limit: { status: "rejected", resetsAt: 123 } },
  { end: "error_during_execution" },
] satisfies AgentScript["rules"][number]["steps"];

function limitAfterResume(resetsAt: number | null): AgentScript {
  return {
    rules: [
      {
        match: "^失敗$",
        steps: [{ end: "error_during_execution", terminal_reason: "api_error" }],
      },
      {
        match: `^${resumeText}$`,
        steps: [
          { rate_limit: { status: "rejected", resetsAt } },
          { end: "error_during_execution" },
        ],
      },
    ],
  };
}

function executionSettings(params: OpenParams) {
  return {
    sessionId: params.sessionId,
    resume: params.resume,
    cwd: params.cwd,
    model: params.model,
    permissionMode: params.permissionMode,
    instructions: params.appendSystemPrompt,
    tools: params.appTools.map(({ name, description, alwaysLoad }) => ({
      name,
      description,
      alwaysLoad,
    })),
  };
}

it.each([
  {
    reason: "api_error",
    runState: "failed",
    resetsAt: null,
    steps: [{ end: "error_during_execution", terminal_reason: "api_error" }],
  },
  { reason: "usage_limit", runState: "usage_limited", resetsAt: 123000, steps: rateLimit },
] satisfies {
  reason: string;
  runState: string;
  resetsAt: number | null;
  steps: AgentScript["rules"][number]["steps"];
}[])(
  "$reason を取得し、公開APIから保存済みセッションで再開の文だけを届ける",
  async ({ reason, runState, resetsAt, steps }) => {
    const f = await fixture({
      rules: [{ match: "^最初の指示$", steps }],
      fallback: [{ hold: true }],
    });
    f.database.sqlite
      .prepare("UPDATE projects SET model='sonnet', permission_mode='acceptEdits' WHERE id='p'")
      .run();
    const id = await f.start();
    expect(await f.send(id, "最初の指示")).toEqual(delivered);
    await settled(f, id, runState);
    const stopped = await f.snapshot(id);
    const first = executionSettings(f.agent.opened[0]!);
    expect({
      status: stopped.status,
      runState: stopped.body.conversation.runState,
      stopReason: stopped.body.conversation.stopReason,
      resetsAt: stopped.body.conversation.resetsAt,
      settings: {
        cwd: first.cwd,
        model: first.model,
        permissionMode: first.permissionMode,
        instructions: first.instructions,
        tools: first.tools.map((tool) => tool.name),
      },
    }).toEqual({
      status: 200,
      runState,
      stopReason: reason,
      resetsAt,
      settings: {
        cwd: f.home,
        model: "sonnet",
        permissionMode: "acceptEdits",
        instructions: issueInstructions(),
        tools: ["issue_get", "issue_list", "issue_create", "issue_update", "issue_comment"],
      },
    });
    await f.restart();

    expect(await f.resume(id)).toEqual(resumeAccepted);
    expect(f.agent.opened.map(executionSettings)).toEqual([first, { ...first, resume: true }]);
    expect(f.agent.sent).toEqual([
      { sessionId: first.sessionId, text: "最初の指示" },
      { sessionId: first.sessionId, text: resumeText },
    ]);
    const history = await f.request<ConversationEventsPage>(`/conversations/${id}/events`);
    expect(history.body.events.slice(-2).map(({ type, payload }) => ({ type, payload }))).toEqual([
      { type: "resumed", payload: { by: "developer" } },
      {
        type: "user_message",
        payload: {
          text: resumeText,
          images: [],
          origin: "resume",
          client_ids: [],
          queued_ids: [],
          client_receipts: [],
        },
      },
    ]);
    const current = (await f.snapshot(id)).body.conversation;
    expect({
      state: current.runState,
      reason: current.stopReason,
      resetsAt: current.resetsAt,
    }).toEqual({
      state: "working",
      reason: null,
      resetsAt: null,
    });
  },
);

it("利用枠が戻る1分後に復旧したタイマーが、元の実行設定で再開する", async () => {
  const f = await fixture({
    rules: [{ match: "^利用枠切れ$", steps: rateLimit }],
    fallback: [{ hold: true }],
  });
  f.database.sqlite
    .prepare("UPDATE projects SET model='opus', permission_mode='plan' WHERE id='p'")
    .run();
  const id = await f.start();
  expect(await f.send(id, "利用枠切れ")).toEqual(delivered);
  await settled(f, id, "usage_limited");
  const first = executionSettings(f.agent.opened[0]!);
  await f.restart();

  await f.clock.advance(183000 - f.clock.now() - 1);
  const early = await f.snapshot(id);
  expect({
    state: early.body.conversation.runState,
    resetsAt: early.body.conversation.resetsAt,
    sent: f.agent.sent,
  }).toEqual({
    state: "usage_limited",
    resetsAt: 123000,
    sent: [{ sessionId: first.sessionId, text: "利用枠切れ" }],
  });
  await f.clock.advance(1);

  const current = await f.snapshot(id);
  const history = await f.request<ConversationEventsPage>(`/conversations/${id}/events`);
  expect({
    state: current.body.conversation.runState,
    reason: current.body.conversation.stopReason,
    sent: f.agent.sent,
    opened: f.agent.opened.map(executionSettings),
    resumes: history.body.events
      .filter((event) => event.type === "resumed")
      .map((event) => event.payload),
  }).toEqual({
    state: "working",
    reason: null,
    sent: [
      { sessionId: first.sessionId, text: "利用枠切れ" },
      { sessionId: first.sessionId, text: resumeText },
    ],
    opened: [first, { ...first, resume: true }],
    resumes: [{ by: "usage_limit" }],
  });
});

it.each([
  { beforeReopen: true, resetsAt: 123, deadline: 183000 },
  { beforeReopen: true, resetsAt: null, deadline: 901000 },
  { beforeReopen: false, resetsAt: 123, deadline: 183000 },
])(
  "閉じた会話を再開した番が利用枠切れになったら時刻 $deadline に一度だけ再開する（開き直し前=$beforeReopen）",
  async ({ beforeReopen, resetsAt, deadline }) => {
    const f = await fixture(limitAfterResume(resetsAt));
    const id = await f.start();
    expect(await f.send(id, "失敗")).toEqual(delivered);
    await settled(f, id, "failed");
    f.database.sqlite.prepare("UPDATE conversations SET closed_at=50 WHERE id=?").run(id);
    const endManual = deferred();
    const endAutomatic = deferred();
    f.agent.beforeTurnEnd = () =>
      f.agent.messages.length === 2
        ? beforeReopen
          ? Promise.resolve()
          : endManual.promise
        : endAutomatic.promise;
    const closedAtWhenStopped: (number | null | undefined)[] = [];
    f.runner().runtime.subscribe((signal) => {
      if (
        signal.type === "stopped" &&
        signal.conversationId === id &&
        signal.reason === "usage_limit"
      )
        closedAtWhenStopped.push(f.runner().runtime.store.get(id)?.closedAt);
    });
    try {
      expect(await f.resume(id)).toEqual(resumeAccepted);
      endManual.resolve();
      await settled(f, id, "usage_limited");
      expect(closedAtWhenStopped).toEqual([beforeReopen ? 50 : null]);
      await f.clock.advance(deadline - f.clock.now() - 1);
      const stopped = (await f.snapshot(id)).body.conversation;
      expect({
        state: stopped.runState,
        reason: stopped.stopReason,
        resetsAt: stopped.resetsAt,
        closedAt: stopped.closedAt,
        sent: f.agent.messages.map(({ text }) => text),
      }).toEqual({
        state: "usage_limited",
        reason: "usage_limit",
        resetsAt: resetsAt === null ? null : resetsAt * 1000,
        closedAt: null,
        sent: ["失敗", resumeText],
      });
      await f.clock.advance(1);
      const active = (await f.snapshot(id)).body.conversation;
      const history = (await f.request<ConversationEventsPage>(`/conversations/${id}/events`)).body
        .events;
      expect({
        state: active.runState,
        closedAt: active.closedAt,
        sent: f.agent.messages.map(({ text }) => text),
        resumed: history.filter(({ type }) => type === "resumed").map(({ payload }) => payload),
      }).toEqual({
        state: "working",
        closedAt: null,
        sent: ["失敗", resumeText, resumeText],
        resumed: [{ by: "developer" }, { by: "usage_limit" }],
      });
    } finally {
      endManual.resolve();
      endAutomatic.resolve();
    }
  },
);

it.each(["期限内に開き直す", "応答が失われて待機を打ち切る"] as const)(
  "利用枠の戻りを既に過ぎた番で%s場合、閉じている間は再開しない",
  async (scenario) => {
    const f = await fixture(limitAfterResume(123));
    f.clock.time = 183001;
    const id = await f.start();
    expect(await f.send(id, "失敗")).toEqual(delivered);
    await settled(f, id, "failed");
    f.database.sqlite.prepare("UPDATE conversations SET closed_at=50 WHERE id=?").run(id);
    const allowResponse = deferred();
    const responseReady = deferred();
    f.deps.runner = {
      call: async (method, path, input) => {
        const result = await f.link.call(method, path, input);
        if (method !== "POST" || path !== `/conversations/${id}/resume`) return result;
        responseReady.resolve();
        await allowResponse.promise;
        return scenario === "期限内に開き直す" ? result : err(runnerUnavailable);
      },
    };
    const automaticEnd = deferred();
    f.agent.beforeTurnEnd = () =>
      f.agent.messages.length === 2 ? Promise.resolve() : automaticEnd.promise;
    try {
      const manual = f.resume(id);
      await responseReady.promise;
      await settled(f, id, "usage_limited");
      await f.clock.advance(0);
      expect({
        closedAt: (await f.snapshot(id)).body.conversation.closedAt,
        messages: f.agent.messages.map(({ text }) => text),
      }).toEqual({ closedAt: 50, messages: ["失敗", resumeText] });
      allowResponse.resolve();
      if (scenario === "期限内に開き直す") {
        expect(await manual).toEqual(resumeAccepted);
        await f.clock.advance(1000);
        expect({
          closedAt: (await f.snapshot(id)).body.conversation.closedAt,
          messages: f.agent.messages.map(({ text }) => text),
        }).toEqual({ closedAt: null, messages: ["失敗", resumeText, resumeText] });
      } else {
        expect(await manual).toEqual({ status: 503, body: { error: runnerUnavailable } });
        await f.clock.advance(15_000);
        expect((await f.snapshot(id)).body.conversation.closedAt).toBe(50);
        f.database.sqlite.prepare("UPDATE conversations SET closed_at=NULL WHERE id=?").run(id);
        await f.clock.advance(1000);
        expect({
          state: (await f.snapshot(id)).body.conversation.runState,
          messages: f.agent.messages.map(({ text }) => text),
        }).toEqual({ state: "usage_limited", messages: ["失敗", resumeText] });
      }
    } finally {
      allowResponse.resolve();
      automaticEnd.resolve();
    }
  },
);

it("正常に開き直したあとでも再度閉じた利用枠停止は自動再開しない", async () => {
  const f = await fixture(limitAfterResume(123));
  const id = await f.start();
  expect(await f.send(id, "失敗")).toEqual(delivered);
  await settled(f, id, "failed");
  f.database.sqlite.prepare("UPDATE conversations SET closed_at=50 WHERE id=?").run(id);
  expect(await f.resume(id)).toEqual(resumeAccepted);
  await settled(f, id, "usage_limited");
  expect((await f.snapshot(id)).body.conversation.closedAt).toBeNull();
  const released = await f.link.call("POST", `/conversations/${id}/release`);
  expect(released._unsafeUnwrap()).toEqual({ status: 200, body: { run_state: "usage_limited" } });
  f.database.sqlite.prepare("UPDATE conversations SET closed_at=51 WHERE id=?").run(id);

  await f.clock.advance(183000 - f.clock.now());
  const stopped = (await f.snapshot(id)).body.conversation;
  expect({
    state: stopped.runState,
    reason: stopped.stopReason,
    closedAt: stopped.closedAt,
    messages: f.agent.messages.map(({ text }) => text),
  }).toEqual({
    state: "usage_limited",
    reason: "usage_limit",
    closedAt: 51,
    messages: ["失敗", resumeText],
  });
});

it("作業中のランナーの再起動で履歴を保ち、指示が届いた時点で作業を再開する", async () => {
  const f = await fixture();
  const id = await f.start();
  expect(await f.send(id, "初回の指示")).toEqual(delivered);
  await settled(f, id, "working");
  const before = await f.request<ConversationEventsPage>(`/conversations/${id}/events`);
  const first = executionSettings(f.agent.opened[0]!);
  await f.restart();
  const stopped = await f.snapshot(id);
  const history = await f.request<ConversationEventsPage>(`/conversations/${id}/events`);
  expect({
    state: stopped.body.conversation.runState,
    reason: stopped.body.conversation.stopReason,
    events: history.body.events,
    sent: f.agent.sent,
  }).toEqual({
    state: "stopped",
    reason: "restarted",
    events: [
      ...before.body.events,
      {
        type: "stopped",
        payload: { reason: "restarted", previous_run_state: "working" },
        seq: before.body.lastSeq + 1,
        createdAt: f.clock.now(),
      },
    ],
    sent: [{ sessionId: first.sessionId, text: "初回の指示" }],
  });
  expect(await f.send(id, "続きの指示")).toEqual(delivered);
  expect({
    state: (await f.snapshot(id)).body.conversation.runState,
    sent: f.agent.sent,
    opened: f.agent.opened.map(executionSettings),
  }).toEqual({
    state: "working",
    sent: [
      { sessionId: first.sessionId, text: "初回の指示" },
      { sessionId: first.sessionId, text: "続きの指示" },
    ],
    opened: [first, { ...first, resume: true }],
  });
});

it("待機中の会話は再開できず、通常の指示を送ると作業を始める", async () => {
  const f = await fixture();
  const id = await f.start();
  expect(await f.resume(id)).toEqual(resumeConflict);
  expect((await f.request<ConversationEventsPage>(`/conversations/${id}/events`)).body).toEqual({
    events: [],
    lastSeq: 0,
    hasMore: false,
  });
  expect(await f.send(id, "許可された指示")).toEqual(delivered);
  expect(f.agent.messages).toEqual([{ text: "許可された指示", images: [] }]);
});

it("閉じた失敗会話の再開はflowに断られた間は閉じたまま、受理された後だけ開く", async () => {
  const f = await fixture({
    rules: [{ match: "^失敗する指示$", steps: [{ end: "error_during_execution" }] }],
    fallback: [{ hold: true }],
  });
  const id = await f.start();
  f.database.sqlite
    .prepare(
      "INSERT INTO issues (id,project_id,number,title,state,created_at,updated_at) VALUES ('i','p',1,'設計する','design_review',1,1)",
    )
    .run();
  f.database.sqlite
    .prepare("UPDATE conversations SET kind='design', issue_id='i' WHERE id=?")
    .run(id);
  expect(await f.send(id, "失敗する指示")).toEqual(delivered);
  await settled(f, id, "failed");
  f.database.sqlite.prepare("UPDATE conversations SET closed_at=50 WHERE id=?").run(id);
  const inspections: unknown[] = [];
  let refusal: { code: "conflict" | "worktree_failed"; message: string } | null = null;
  f.runner().runtime.runOptions.registerDeliveryGuard((conversation, input) => {
    inspections.push({
      id: conversation.id,
      issueId: conversation.issueId,
      closedAt: conversation.closedAt,
      input,
    });
    return refusal ? err(refusal) : ok(undefined);
  });
  const before = await f.snapshot(id);
  refusal = { code: "conflict", message: "この issue はいま実装の会話で進んでいます" };
  expect(await f.resume(id)).toEqual({
    status: 409,
    body: { error: refusal },
  });
  expect(await f.snapshot(id)).toEqual(before);
  refusal = { code: "worktree_failed", message: "設計の worktree を作り直せませんでした。" };
  expect(await f.resume(id)).toEqual({
    status: 500,
    body: { error: refusal },
  });
  expect(await f.snapshot(id)).toEqual(before);
  expect(f.agent.messages).toEqual([{ text: "失敗する指示", images: [] }]);

  refusal = null;
  const closedAtWhenSent: (number | null | undefined)[] = [];
  f.agent.beforeSend = () => closedAtWhenSent.push(f.runner().runtime.store.get(id)?.closedAt);
  expect(await f.resume(id)).toEqual(resumeAccepted);
  expect({
    closedAtWhenSent,
    current: (await f.snapshot(id)).body.conversation.closedAt,
    inspections,
    sent: f.agent.messages,
  }).toEqual({
    closedAtWhenSent: [50],
    current: null,
    inspections: Array.from({ length: 3 }, () => ({
      id,
      issueId: "i",
      closedAt: 50,
      input: { text: resumeText, images: [], origin: "resume" },
    })),
    sent: [
      { text: "失敗する指示", images: [] },
      { text: resumeText, images: [] },
    ],
  });
});

it.each(["開き直し前に成功", "開き直し後に成功", "失敗"] as const)(
  "閉じた会話の再開が%sした後は、正常終了した番からだけ預けた指示と画像が届く",
  async (order) => {
    const failed = order === "失敗";
    const f = await fixture({
      rules: [
        {
          match: "^初回$",
          steps: [{ end: "error_during_execution", terminal_reason: "api_error" }],
        },
        {
          match: `^${resumeText}$`,
          steps: [
            failed
              ? { end: "error_during_execution", terminal_reason: "api_error" }
              : { end: "success" },
          ],
        },
      ],
      fallback: [{ hold: true }],
    });
    const id = await f.start();
    const initialEnd = deferred();
    let queued: ConversationQueueItem | null = null;
    f.agent.beforeTurnEnd = () => initialEnd.promise;
    try {
      expect(await f.send(id, "初回")).toEqual(delivered);
      const imageId = (await f.upload(id)).body.image.id;
      const response = await f.send(id, "預けた指示", "queued-image", "send", [imageId]);
      expect(response.body.result).toBe("queued");
      queued = response.body.queueItem;
    } finally {
      initialEnd.resolve();
    }
    await settled(f, id, "failed");
    f.database.sqlite.prepare("UPDATE conversations SET closed_at=50 WHERE id=?").run(id);
    const successfulEnd = deferred();
    f.agent.beforeTurnEnd = order === "開き直し後に成功" ? () => successfulEnd.promise : undefined;
    const closedAtEnd: (number | null | undefined)[] = [];
    f.runner().runtime.subscribe((signal) => {
      if (
        signal.type === "turnEnded" &&
        signal.conversationId === id &&
        signal.subtype === (failed ? "error_during_execution" : "success")
      )
        closedAtEnd.push(f.runner().runtime.store.get(id)?.closedAt);
    });
    try {
      expect(await f.resume(id)).toEqual(resumeAccepted);
    } finally {
      successfulEnd.resolve();
    }
    await expect.poll(() => closedAtEnd).toEqual([order === "開き直し後に成功" ? null : 50]);
    await f.runner().runtime.serial(id, async () => ok(undefined));
    const after = (await f.snapshot(id)).body;
    expect({
      state: after.conversation.runState,
      closedAt: after.conversation.closedAt,
      queue: after.queue,
      messages: f.agent.messages,
    }).toEqual({
      state: failed ? "failed" : "working",
      closedAt: null,
      queue: failed ? [queued] : [],
      messages: [
        { text: "初回", images: [] },
        { text: resumeText, images: [] },
        ...(failed
          ? []
          : [{ text: "預けた指示", images: [{ data: png, mediaType: "image/png" }] }]),
      ],
    });
  },
);

it("明示的に再開していない閉じた会話では、正常終了後も預けた指示が残る", async () => {
  const f = await fixture({ rules: [], fallback: [{ end: "success" }] });
  const id = await f.start();
  const end = deferred();
  f.agent.beforeTurnEnd = () => end.promise;
  try {
    expect(await f.send(id, "初回")).toEqual(delivered);
    expect((await f.send(id, "預けた指示")).body.result).toBe("queued");
    f.database.sqlite.prepare("UPDATE conversations SET closed_at=50 WHERE id=?").run(id);
  } finally {
    end.resolve();
  }
  await settled(f, id, "idle");
  await f.runner().runtime.serial(id, async () => ok(undefined));
  const current = (await f.snapshot(id)).body;
  expect({
    closedAt: current.conversation.closedAt,
    texts: current.queue.map(({ text }) => text),
    messages: f.agent.messages,
  }).toEqual({ closedAt: 50, texts: ["預けた指示"], messages: [{ text: "初回", images: [] }] });
});

it.each([
  { accept: true, reason: "api_error", state: "failed" },
  { accept: true, reason: "usage_limit", state: "usage_limited" },
  { accept: false, reason: null, state: "working" },
] as const)(
  "前の利用枠タイマーは手動再開後の $state を対象にしない（手動受理=$accept）",
  async ({ accept, reason, state }) => {
    const next: AgentScript["rules"][number]["steps"] =
      reason === "api_error"
        ? [{ end: "error_during_execution", terminal_reason: "api_error" }]
        : reason === "usage_limit"
          ? [
              { rate_limit: { status: "rejected", resetsAt: 456 } },
              { end: "error_during_execution" },
            ]
          : [{ hold: true }];
    const f = await fixture({
      rules: [
        { match: "^利用枠切れ$", steps: rateLimit },
        { match: `^${resumeText}$`, steps: next },
      ],
    });
    const id = await f.start();
    expect(await f.send(id, "利用枠切れ")).toEqual(delivered);
    await settled(f, id, "usage_limited");
    const entered = deferred();
    const proceed = deferred();
    f.runner().runtime.runOptions.registerDeliveryGuard(async () => {
      entered.resolve();
      await proceed.promise;
      return accept
        ? ok(undefined)
        : err({ code: "conflict", message: resumeConflict.body.error.message });
    });

    const manual = f.resume(id);
    await entered.promise;
    const untilTurnEnds = f.runner().runtime.serial(id, async () => {
      if (accept) await settled(f, id, state);
      return ok(undefined);
    });
    const oldTimer = f.clock.advance(183000 - f.clock.now());
    proceed.resolve();
    expect(await manual).toEqual(accept ? resumeAccepted : resumeConflict);
    await untilTurnEnds;
    await oldTimer;
    await settled(f, id, state);
    const current = (await f.snapshot(id)).body.conversation;
    const history = (await f.request<ConversationEventsPage>(`/conversations/${id}/events`)).body
      .events;
    expect({
      reason: current.stopReason,
      resetsAt: current.resetsAt,
      sent: f.agent.sent.map(({ text }) => text),
      resumed: history.filter(({ type }) => type === "resumed").map(({ payload }) => payload),
    }).toEqual({
      reason,
      resetsAt: reason === "usage_limit" ? 456000 : null,
      sent: ["利用枠切れ", resumeText],
      resumed: [{ by: accept ? "developer" : "usage_limit" }],
    });
  },
);

it.each(["9999ms", "10000msで接続中", "IPC切断", "古い実行の終了待ち"] as const)(
  "公開再開要求の%sでは、受付結果・会話の閉鎖・配達が一致する",
  async (scenario) => {
    const ipcClock = new RunnerClock();
    const f = await fixture(
      {
        rules: [
          {
            match: "^失敗$",
            steps: [{ end: "error_during_execution", terminal_reason: "api_error" }],
          },
        ],
        fallback: [{ hold: true }],
      },
      ipcClock,
    );
    const id = await f.start();
    expect(await f.send(id, "失敗")).toEqual(delivered);
    await settled(f, id, "failed");
    f.database.sqlite.prepare("UPDATE conversations SET closed_at=50 WHERE id=?").run(id);
    const entered = deferred();
    const proceed = deferred();
    const oldExecution = scenario === "古い実行の終了待ち";
    if (oldExecution) {
      const nextCwd = join(f.home, "new-cwd");
      mkdirSync(nextCwd);
      f.database.sqlite.prepare("UPDATE conversations SET cwd=? WHERE id=?").run(nextCwd, id);
      f.agent.beforeOutputEnd = () => {
        entered.resolve();
        return proceed.promise;
      };
    } else {
      f.runner().runtime.runOptions.registerDeliveryGuard(async () => {
        entered.resolve();
        await proceed.promise;
        return ok(undefined);
      });
    }

    const operation = f.resume(id);
    const beforeDeadline = scenario === "9999ms";
    try {
      await entered.promise;
      if (scenario === "IPC切断") {
        await ipcClock.advance(10000);
        expect(await operation).toEqual({ status: 503, body: { error: runnerUnavailable } });
        await f.link.call("GET", "/health");
      } else if (beforeDeadline) {
        await ipcClock.advance(9999);
        f.clock.time = ipcClock.now();
      } else {
        f.clock.time = ipcClock.now() + 10000;
      }
    } finally {
      proceed.resolve();
    }
    expect(await operation).toEqual(
      beforeDeadline ? resumeAccepted : { status: 503, body: { error: runnerUnavailable } },
    );
    await f.runner().runtime.serial(id, async () => ok(undefined));
    const after = (await f.snapshot(id)).body.conversation;
    const history = (await f.request<ConversationEventsPage>(`/conversations/${id}/events`)).body
      .events;
    expect({
      closedAt: after.closedAt,
      state: after.runState,
      reason: after.stopReason,
      opened: f.agent.opened.length,
      sent: f.agent.sent.map(({ text }) => text),
      resumed: history.filter(({ type }) => type === "resumed").map(({ payload }) => payload),
    }).toEqual(
      beforeDeadline
        ? {
            closedAt: null,
            state: "working",
            reason: null,
            opened: 1,
            sent: ["失敗", resumeText],
            resumed: [{ by: "developer" }],
          }
        : {
            closedAt: 50,
            state: "failed",
            reason: "api_error",
            opened: 1,
            sent: ["失敗"],
            resumed: [],
          },
    );
  },
);

it.each([9999, 10000])(
  "再開の発言をSQLiteに書いた時点で要求から%dms経過していた場合の受理を決める",
  async (elapsed) => {
    const ipcClock = new RunnerClock();
    const f = await fixture(
      {
        rules: [
          {
            match: "^失敗$",
            steps: [{ end: "error_during_execution", terminal_reason: "api_error" }],
          },
        ],
        fallback: [{ hold: true }],
      },
      ipcClock,
    );
    const id = await f.start();
    expect(await f.send(id, "失敗")).toEqual(delivered);
    await settled(f, id, "failed");
    await f.restart();
    const { sqlite } = f.database;
    sqlite.prepare("UPDATE conversations SET closed_at=50 WHERE id=?").run(id);
    const before = (await f.snapshot(id)).body.conversation;
    const eventsPath = `/conversations/${id}/events`;
    const previousEvents = (await f.request<ConversationEventsPage>(eventsPath)).body.events;
    const closedBefore = f.agent.closedSessions.length;
    let writes = 0;
    sqlite.function("advance_resume_clock", () => {
      writes++;
      f.clock.time = ipcClock.now() + elapsed;
    });
    sqlite.exec(`
      CREATE TEMP TRIGGER advance_clock_after_resume
      AFTER UPDATE OF last_seq ON conversations
      WHEN EXISTS (
        SELECT 1 FROM conversation_events
        WHERE conversation_id=NEW.id AND seq=NEW.last_seq AND type='user_message'
          AND json_extract(payload, '$.origin')='resume'
      )
      BEGIN SELECT advance_resume_clock(); END
    `);

    const accepted = elapsed === 9999;
    expect(await f.resume(id)).toEqual(
      accepted ? resumeAccepted : { status: 503, body: { error: runnerUnavailable } },
    );
    const current = (await f.snapshot(id)).body.conversation;
    const events = (await f.request<ConversationEventsPage>(eventsPath)).body.events;
    const newSession = f.agent.opened[1]!;
    expect({
      writes,
      state: current.runState,
      reason: current.stopReason,
      closedAt: current.closedAt,
      seq: current.lastSeq,
      events: events.slice(0, previousEvents.length),
      additions: events.slice(previousEvents.length).map(({ type }) => type),
      sent: f.agent.messages.map(({ text }) => text),
      currentRun: f.runner().runtime.executions.has(id),
      disposed: f.agent.closedSessions.slice(closedBefore),
    }).toEqual({
      writes: 1,
      state: accepted ? "working" : before.runState,
      reason: accepted ? null : before.stopReason,
      closedAt: accepted ? null : before.closedAt,
      seq: accepted ? before.lastSeq + 2 : before.lastSeq,
      events: previousEvents,
      additions: accepted ? ["resumed", "user_message"] : [],
      sent: accepted ? ["失敗", resumeText] : ["失敗"],
      currentRun: accepted,
      disposed: accepted ? [] : [newSession.sessionId],
    });
  },
);

it("プロジェクトの空の会話を開始し、初回指示で題名・発言・実行設定を保存してスキルをそのまま届ける", async () => {
  const f = await fixture();
  f.database.sqlite
    .prepare("UPDATE projects SET model='sonnet', permission_mode='acceptEdits' WHERE id='p'")
    .run();
  f.runner().runtime.runOptions.registerInstructions(() => "追加の指示");
  const id = await f.start();
  expect(await f.snapshot(id)).toEqual({
    status: 200,
    body: {
      conversation: {
        id,
        projectId: "p",
        projectName: "project",
        kind: "chat",
        issueId: null,
        parentConversationId: null,
        title: "新しい会話",
        cwd: f.home,
        worktree: null,
        runState: "idle",
        stopReason: null,
        resetsAt: null,
        lastSeq: 0,
        lastReadSeq: 0,
        lastPosition: null,
        closedAt: null,
      },
      draft: null,
      queue: [],
      pendingAnswers: null,
      pendingPermission: null,
      commands: [],
    },
  });
  expect(f.database.sqlite.prepare("SELECT * FROM worktrees").all()).toEqual([]);
  expect(await f.send(id, "/dev-spec 要件を整理\n次の行")).toEqual(delivered);
  await settled(f, id, "working");
  const opened = f.agent.opened[0]!;
  expect({
    cwd: opened.cwd,
    model: opened.model,
    permissionMode: opened.permissionMode,
    instructions: opened.appendSystemPrompt,
    tools: opened.appTools.map((tool) => tool.name),
    resume: opened.resume,
    sent: f.agent.sent.map((message) => message.text),
  }).toEqual({
    cwd: f.home,
    model: "sonnet",
    permissionMode: "acceptEdits",
    instructions: `${issueInstructions()}\n\n追加の指示`,
    tools: ["issue_get", "issue_list", "issue_create", "issue_update", "issue_comment"],
    resume: false,
    sent: ["/dev-spec 要件を整理\n次の行"],
  });
  const page = await f.request<ConversationEventsPage>(`/conversations/${id}/events?limit=1`);
  expect(page).toEqual({
    status: 200,
    body: {
      events: [
        {
          seq: 1,
          type: "user_message",
          payload: {
            text: "/dev-spec 要件を整理\n次の行",
            images: [],
            origin: "developer",
            client_ids: ["/dev-spec 要件を整理\n次の行"],
            queued_ids: [],
            client_receipts: [
              { client_id: "/dev-spec 要件を整理\n次の行", result: "delivered", received_at: 1000 },
            ],
          },
          createdAt: 1000,
          missingImages: 0,
        },
      ],
      lastSeq: 2,
      hasMore: true,
    },
  });
  expect((await f.snapshot(id)).body.conversation.title).toBe("/dev-spec 要件を整理");
  expect((await f.snapshot(id)).body.commands).toEqual([
    { name: "/dev-spec", description: "設計ループ。手順を進める" },
  ]);
  const sessionId = f.runner().runtime.store.get(id)!.sessionId;
  await f.restart();
  f.runner().runtime.runOptions.registerInstructions(() => "追加の指示");
  expect(await f.send(id, "続き")).toEqual(delivered);
  const reopened = f.agent.opened.at(-1)!;
  expect({
    sessionId: reopened.sessionId,
    resume: reopened.resume,
    cwd: reopened.cwd,
    model: reopened.model,
    permissionMode: reopened.permissionMode,
    instructions: reopened.appendSystemPrompt,
  }).toEqual({
    sessionId,
    resume: true,
    cwd: f.home,
    model: "sonnet",
    permissionMode: "acceptEdits",
    instructions: opened.appendSystemPrompt,
  });
});

it("2つのタブの下書きは新しい編集を残し、別会話から戻っても読み出せて変更が配信される", async () => {
  const f = await fixture();
  const id = await f.start();
  const events: unknown[] = [];
  const client = {
    bufferedAmount: 0,
    send: (text: string) => events.push(JSON.parse(text)),
    close: () => {},
  };
  f.hub.add(client);
  f.hub.receive(client, { op: "subscribe", topic: `conversation:${id}` });
  const save = (text: string, editedAt: number, clientId: string) =>
    f.request(`/conversations/${id}/draft`, "PUT", { text, images: [], editedAt, clientId });
  expect(await save("先", 10, "tab-a")).toEqual({
    status: 200,
    body: { applied: true, draft: { text: "先", images: [], updatedAt: 10, updatedBy: "tab-a" } },
  });
  expect(await save("後", 20, "tab-b")).toEqual({
    status: 200,
    body: { applied: true, draft: { text: "後", images: [], updatedAt: 20, updatedBy: "tab-b" } },
  });
  for (const editedAt of [19, 20])
    expect(await save("古", editedAt, "tab-a")).toEqual({
      status: 200,
      body: {
        applied: false,
        draft: { text: "後", images: [], updatedAt: 20, updatedBy: "tab-b" },
      },
    });
  await f.request(`/conversations/${await f.start()}`);
  expect((await f.snapshot(id)).body.draft).toEqual({
    text: "後",
    images: [],
    updatedAt: 20,
    updatedBy: "tab-b",
  });
  expect(events).toEqual(
    [1, 2].map(() => ({
      topic: `conversation:${id}`,
      seq: 0,
      type: "changed",
      payload: { parts: ["draft"] },
    })),
  );
  expect(await save("", 30, "tab-a")).toEqual({
    status: 200,
    body: { applied: true, draft: null },
  });
  expect(await save("古", 20, "tab-b")).toEqual({
    status: 200,
    body: { applied: false, draft: null },
  });
});

it("画像を保存して順番どおり実データを届け、欠落した画像数をイベントへ返す", async () => {
  const f = await fixture();
  const id = await f.start();
  const first = await f.upload(id);
  const second = await f.upload(id, Buffer.from("GIF89a"), "image/gif");
  expect(first).toEqual({
    status: 201,
    body: { image: { id: first.body.image.id, mediaType: "image/png", bytes: png.length } },
  });
  const images = [first.body.image.id, second.body.image.id];
  expect(await f.send(id, "画像", "images", "send", images)).toEqual(delivered);
  expect(f.agent.messages).toEqual([
    {
      text: "画像",
      images: [
        { data: png, mediaType: "image/png" },
        { data: Buffer.from("GIF89a"), mediaType: "image/gif" },
      ],
    },
  ]);
  rmSync(join(f.home, "images", id, `${images[0]}.png`));
  const page = await f.request<ConversationEventsPage>(`/conversations/${id}/events?limit=1`);
  expect(page.body.events[0]).toEqual({
    seq: 1,
    type: "user_message",
    payload: {
      text: "画像",
      images: [
        { path: `images/${id}/${images[0]}.png`, media_type: "image/png" },
        { path: `images/${id}/${images[1]}.gif`, media_type: "image/gif" },
      ],
      origin: "developer",
      client_ids: ["images"],
      queued_ids: [],
      client_receipts: [{ client_id: "images", result: "delivered", received_at: 1000 }],
    },
    createdAt: 1000,
    missingImages: 1,
  });
  expect(await f.send(id, "欠落", "missing", "send", [images[0]])).toEqual({
    status: 400,
    body: { error: { code: "invalid_input", message: "画像が見つかりません。貼り直してください" } },
  });
});

it("キューの編集・取消しは書きかけとストックへ戻り、停止後も自動配達されず、送信したstockのseqを保存する", async () => {
  const f = await fixture();
  const id = await f.start();
  await f.send(id, "最初");
  const a = await f.send(id, "預ける", "queue-a");
  const item = a.body.queueItem!;
  expect(
    await f.request(`/conversations/${id}/queue/${item.id}`, "PATCH", {
      text: "直した内容",
      images: [],
    }),
  ).toEqual({ status: 200, body: { queueItem: { ...item, text: "直した内容" } } });
  await f.request(`/conversations/${id}/draft`, "PUT", {
    text: "書きかけ",
    images: [],
    editedAt: 20,
    clientId: "tab-a",
  });
  expect(await f.request(`/conversations/${id}/queue/${item.id}`, "DELETE")).toEqual({
    status: 204,
    body: null,
  });
  expect((await f.snapshot(id)).body.draft).toEqual({
    text: "書きかけ\n\n直した内容",
    images: [],
    updatedAt: 1000,
    updatedBy: "tab-a",
  });
  f.database.sqlite
    .prepare(
      "INSERT INTO stock_items (id,conversation_id,kind,text,state,sent_at) VALUES ('s',?,'instruction','元の本文','sent',1000)",
    )
    .run(id);
  f.database.sqlite
    .prepare(
      "INSERT INTO queued_instructions (id,conversation_id,text,images,position,stock_item_id,created_at) VALUES ('stock-q',?,'ストック','[]',1,'s',1000)",
    )
    .run(id);
  expect(await f.request(`/conversations/${id}/queue/stock-q`, "DELETE")).toEqual({
    status: 204,
    body: null,
  });
  expect(
    f.database.sqlite
      .prepare("SELECT state,sent_at,sent_seq,text FROM stock_items WHERE id='s'")
      .get(),
  ).toEqual({ state: "stocked", sent_at: null, sent_seq: null, text: "元の本文" });
  await f.send(id, "残す", "queue-b");
  expect(await f.request(`/conversations/${id}/stop`, "POST")).toEqual({
    status: 202,
    body: { runState: "stopped" },
  });
  expect({
    sent: f.agent.sent.map((m) => m.text),
    queue: f
      .runner()
      .runtime.store.queue(id)
      .map((q) => q.text),
  }).toEqual({ sent: ["最初"], queue: ["残す"] });
  f.database.sqlite.prepare("UPDATE stock_items SET state='sent',sent_at=1000 WHERE id='s'").run();
  f.database.sqlite
    .prepare(
      "INSERT INTO queued_instructions (id,conversation_id,text,images,position,stock_item_id,created_at) VALUES ('stock-q',?,'ストック','[]',2,'s',1000)",
    )
    .run(id);
  expect(await f.send(id, "", "deliver")).toEqual(delivered);
  expect(f.agent.sent.map((m) => m.text)).toEqual(["最初", "残す\n\nストック"]);
  const seq = f
    .runner()
    .runtime.store.events(id)
    .filter((e) => e.type === "user_message")
    .at(-1)!.seq;
  expect(
    f.database.sqlite.prepare("SELECT state,sent_seq FROM stock_items WHERE id='s'").get(),
  ).toEqual({ state: "sent", sent_seq: seq });
  expect(await f.request(`/conversations/${id}/queue/stock-q`, "DELETE")).toEqual({
    status: 404,
    body: { error: { code: "not_found", message: "すでに届きました" } },
  });
});

it.each(["edit", "cancel"])(
  "割り込み停止待ちの間に%sが成功したキューの古い内容を送らない",
  async (operation) => {
    const f = await fixture();
    const id = await f.start();
    await f.send(id, "最初");
    const queued = await f.send(id, "古い指示", "queued");
    const entered = deferred();
    const release = deferred();
    f.agent.beforeInterrupt = async () => {
      entered.resolve();
      await release.promise;
    };
    const interrupted = f.send(id, "割り込み", "interrupt", "interrupt");
    await entered.promise;
    const path = `/conversations/${id}/queue/${queued.body.queueItem!.id}`;
    const edited =
      operation === "edit"
        ? await f.request(path, "PATCH", { text: "新しい指示", images: [] })
        : await f.request(path, "DELETE");
    expect(edited.status).toBe(operation === "edit" ? 200 : 204);
    release.resolve();
    expect(await interrupted).toEqual(delivered);
    expect(f.agent.sent.map((m) => m.text)).toEqual([
      "最初",
      operation === "edit" ? "新しい指示\n\n割り込み" : "割り込み",
    ]);
    expect(f.runner().runtime.store.queue(id)).toEqual([]);
  },
);

const question = (text: string, multi_select = false) => ({
  question: text,
  header: text,
  options: [
    { label: "A", description: "方針A" },
    { label: "B", description: "方針B" },
  ],
  multi_select,
});
it("回答を全問まとめて一度だけAIに返し、確認が必要な未回答は送らない", async () => {
  const f = await fixture({
    rules: [],
    fallback: [{ ask: [question("Q1", true), question("Q2")] }, { text: "続き" }, { hold: true }],
  });
  const id = await f.start();
  await f.send(id, "質問");
  await settled(f, id, "waiting_answer");
  const q = f
    .runner()
    .runtime.store.events(id)
    .find((e) => e.type === "question")!;
  const path = `/conversations/${id}/answers`;
  expect(await f.request(path, "PUT", { questionSeq: q.seq + 1, answers: {} })).toEqual({
    status: 409,
    body: {
      error: { code: "conflict", message: "回答する質問が変わりました。読み直してください。" },
    },
  });
  const partial = { "0": { choices: ["A", "B"], text: "補足" } };
  expect(await f.request(path, "PUT", { questionSeq: q.seq, answers: partial })).toEqual({
    status: 200,
    body: { pendingAnswers: { questionSeq: q.seq, answers: partial } },
  });
  expect(await f.request(`${path}/send`, "POST", { confirmUnanswered: false })).toEqual({
    status: 409,
    body: {
      error: {
        code: "unanswered_questions",
        message: "答えていない質問があります。確認してから送ってください。",
      },
    },
  });
  expect(f.agent.receivedAnswers).toEqual([]);
  const answers = { ...partial, "1": { choices: [], text: "自由回答" } };
  await f.request(path, "PUT", { questionSeq: q.seq, answers });
  expect(await f.request(`${path}/send`, "POST", { confirmUnanswered: false })).toEqual({
    status: 202,
    body: { result: "answered" },
  });
  await expect.poll(() => f.agent.receivedAnswers.length).toBe(1);
  expect(f.agent.receivedAnswers).toEqual([
    {
      requestId: q.type === "question" ? q.payload.request_id : "",
      answers: { Q1: "A、B: 補足", Q2: "自由回答" },
    },
  ]);
  expect({
    pending: (await f.snapshot(id)).body.pendingAnswers,
    questions: f.database.sqlite
      .prepare("SELECT answered FROM questions WHERE conversation_id=? ORDER BY id")
      .all(id),
  }).toEqual({ pending: null, questions: [{ answered: 1 }, { answered: 1 }] });
});
it("同じ番の発言では未回答の質問を保ち、次の番の発言で前の回答を片づける", async () => {
  const f = await fixture({
    rules: [
      {
        match: "^質問$",
        steps: [{ text: "相談があります。" }, { ask: [question("Q1"), question("Q2")] }],
      },
      { match: "^別の指示$", steps: [{ text: "別の指示を受け取りました。" }, { end: "success" }] },
    ],
  });
  const id = await f.start();
  await f.send(id, "質問");
  await settled(f, id, "waiting_answer");
  await expect
    .poll(async () =>
      (await f.request<ConversationEventsPage>(`/conversations/${id}/events`)).body.events.map(
        (event) => event.type,
      ),
    )
    .toContain("assistant_text");
  const { events } = (await f.request<ConversationEventsPage>(`/conversations/${id}/events`)).body;
  const questionSeq = events.find((event) => event.type === "question")!.seq;
  const path = `/conversations/${id}/answers`;
  const pending = { questionSeq, answers: { "0": { choices: ["A"], text: null } } };
  expect(await f.request(path, "PUT", pending)).toEqual({
    status: 200,
    body: { pendingAnswers: pending },
  });

  expect((await f.request(`/conversations/${id}/stop`, "POST")).status).toBe(202);
  expect((await f.snapshot(id)).body.pendingAnswers).toEqual(pending);
  await f.send(id, "別の指示");
  await settled(f, id, "idle");
  expect((await f.snapshot(id)).body.pendingAnswers).toBeNull();
  expect((await f.request(path, "PUT", pending)).status).toBe(409);
});
it("停止した質問への保存済み回答は通常の指示として届けて閉じた会話も開き直す", async () => {
  const f = await fixture({
    rules: [
      { match: "^質問$", steps: [{ ask: [question("Q1"), question("Q2")] }, { hold: true }] },
    ],
    fallback: [{ hold: true }],
  });
  const id = await f.start();
  await f.send(id, "質問");
  await settled(f, id, "waiting_answer");
  const q = f
    .runner()
    .runtime.store.events(id)
    .find((e) => e.type === "question")!;
  await f.request(`/conversations/${id}/answers`, "PUT", {
    questionSeq: q.seq,
    answers: { "0": { choices: ["A"], text: null } },
  });
  await f.request(`/conversations/${id}/stop`, "POST");
  f.database.sqlite.prepare("UPDATE conversations SET closed_at=500 WHERE id=?").run(id);
  expect(
    await f.request(`/conversations/${id}/answers/send`, "POST", { confirmUnanswered: true }),
  ).toEqual({ status: 202, body: { result: "delivered" } });
  expect(f.agent.sent.map((m) => m.text)).toEqual([
    "質問",
    "Q: Q1\nA: A\n\nQ: Q2\nA: (開発者は答えなかった)",
  ]);
  expect((await f.snapshot(id)).body.conversation.closedAt).toBe(null);
});
it.each(["allow", "deny"])("許可の確認に%sを一度返す", async (decision) => {
  const f = await fixture({
    rules: [],
    fallback: [{ permission: { tool_name: "Bash", input: { command: "pwd" } } }, { hold: true }],
  });
  const id = await f.start();
  await f.send(id, "許可");
  await settled(f, id, "waiting_permission");
  const snapshot = (await f.snapshot(id)).body;
  const pending = snapshot.pendingPermission!;
  expect(pending).toEqual({
    requestId: pending.requestId,
    seq: 2,
    toolName: "Bash",
    summary: "pwd",
  });
  const path = `/conversations/${id}/permissions/${pending.requestId}`;
  expect(await f.request(path, "POST", { decision })).toEqual({
    status: 202,
    body: { runState: "working" },
  });
  expect(f.agent.permissionDecisions).toEqual([
    {
      requestId: pending.requestId,
      decision: decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "" },
    },
  ]);
  expect((await f.request(path, "POST", { decision })).status).toBe(409);
});
it("閉じたスレッドと親は受理後だけ開き、ランナー不通やflow拒否では下書きと閉じた状態を保つ", async () => {
  const f = await fixture();
  const parent = await f.start();
  const id = await f.start();
  f.database.sqlite.prepare("UPDATE conversations SET closed_at=50").run();
  f.database.sqlite
    .prepare("UPDATE conversations SET kind='thread',parent_conversation_id=? WHERE id=?")
    .run(parent, id);
  await f.request(`/conversations/${id}/draft`, "PUT", {
    text: "残す",
    images: [],
    editedAt: 20,
    clientId: "tab",
  });
  f.runner().runtime.runOptions.registerDeliveryGuard(() =>
    err({ code: "conflict", message: "担当の会話ではありません" }),
  );
  expect(await f.send(id, "拒否")).toEqual({
    status: 409,
    body: { error: { code: "conflict", message: "担当の会話ではありません" } },
  });
  await f.restart();
  const acceptedStates: (number | null)[] = [];
  f.runner().runtime.runOptions.registerDeliveryGuard((conversation) => {
    acceptedStates.push(conversation.closedAt);
    return ok(undefined);
  });
  expect(await f.send(id, "残す")).toEqual(delivered);
  expect({
    acceptedStates,
    closed: f.database.sqlite.prepare("SELECT closed_at FROM conversations ORDER BY id").all(),
    draft: (await f.snapshot(id)).body.draft,
  }).toEqual({
    acceptedStates: [50],
    closed: [{ closed_at: null }, { closed_at: null }],
    draft: null,
  });
  f.database.sqlite.prepare("UPDATE conversations SET closed_at=70 WHERE id=?").run(id);
  await f.request(`/conversations/${id}/draft`, "PUT", {
    text: "失わない",
    images: [],
    editedAt: 2000,
    clientId: "tab",
  });
  await f.runner().shutdown();
  expect(await f.send(id, "接続失敗")).toEqual({ status: 503, body: { error: runnerUnavailable } });
  const snapshot = (await f.snapshot(id)).body;
  expect({
    closedAt: snapshot.conversation.closedAt,
    draft: snapshot.draft,
    sent: f.agent.sent.map((m) => m.text),
  }).toEqual({
    closedAt: 70,
    draft: { text: "失わない", images: [], updatedAt: 2000, updatedBy: "tab" },
    sent: ["残す"],
  });
});

it("重複したclientMessageIdは最初の受付を返し、リトライで新しい書きかけを消さない", async () => {
  const f = await fixture();
  const id = await f.start();
  expect(await f.send(id, "一度", "same")).toEqual(delivered);
  await f.request(`/conversations/${id}/draft`, "PUT", {
    text: "次の入力",
    images: [],
    editedAt: 2000,
    clientId: "tab",
  });
  expect(await f.send(id, "一度", "same")).toEqual(delivered);
  expect({
    sent: f.agent.sent.map((m) => m.text),
    draft: (await f.snapshot(id)).body.draft,
  }).toEqual({
    sent: ["一度"],
    draft: { text: "次の入力", images: [], updatedAt: 2000, updatedBy: "tab" },
  });
});

it("空・上限・未知の会話・削除済みプロジェクトを入口で検査する", async () => {
  const f = await fixture();
  const id = await f.start();
  expect(await f.send(id, "")).toEqual(invalid);
  expect(await f.send(id, "a".repeat(100001))).toEqual(invalid);
  expect(
    await f.request(`/conversations/${id}/draft`, "PUT", {
      text: "a".repeat(100001),
      images: [],
      editedAt: 1,
      clientId: "t",
    }),
  ).toEqual(invalid);
  expect(await f.upload(id, Buffer.alloc(5 * 1024 * 1024 + 1))).toEqual(invalid);
  expect(await f.upload(id, png, "text/plain")).toEqual(invalid);
  expect((await f.request("/conversations/missing")).status).toBe(404);
  f.database.sqlite.prepare("UPDATE projects SET removed_at=1 WHERE id='p'").run();
  expect(
    await f.request("/conversations", "POST", { projectId: "p", workspace: { kind: "project" } }),
  ).toEqual({
    status: 404,
    body: { error: { code: "not_found", message: "プロジェクトが見つかりません。" } },
  });
});

it("正常終了した番だけが預かった画像付き指示を順に届け、画面が無くても記録と配信が進む", async () => {
  const f = await fixture({
    rules: [
      {
        match: "^初回$",
        steps: [{ tool: "mcp__sukuna__gate", input: {}, result: "ignored" }, { end: "success" }],
      },
    ],
    fallback: [{ text: "配達後の応答" }, { hold: true }],
  });
  const entered = deferred();
  const release = deferred();
  f.runner().runtime.tools.register({
    name: "gate",
    description: "番の完了を待つ",
    input: {},
    alwaysLoad: true,
    handler: async () => {
      entered.resolve();
      await release.promise;
      return { text: "終了", isError: false };
    },
  });
  const id = await f.start();
  const a = await f.upload(id);
  const b = await f.upload(id);
  const frames: unknown[] = [];
  const client = {
    bufferedAmount: 0,
    send: (text: string) => frames.push(JSON.parse(text)),
    close: () => {},
  };
  f.hub.add(client);
  f.hub.receive(client, { op: "subscribe", topic: `conversation:${id}` });
  f.link.start();
  expect(await f.send(id, "初回")).toEqual(delivered);
  await entered.promise;
  const first = await f.send(id, "先の指示", "auto-a", "send", [a.body.image.id]);
  const second = await f.send(id, "後の指示", "auto-b", "send", [b.body.image.id]);
  expect([first.body.result, second.body.result]).toEqual(["queued", "queued"]);
  expect(f.agent.messages).toEqual([{ text: "初回", images: [] }]);
  release.resolve();
  await expect.poll(() => f.agent.messages.length).toBe(2);
  expect(f.agent.messages).toEqual([
    { text: "初回", images: [] },
    {
      text: "先の指示\n\n後の指示",
      images: [
        { data: png, mediaType: "image/png" },
        { data: png, mediaType: "image/png" },
      ],
    },
  ]);
  await expect
    .poll(
      () =>
        f
          .runner()
          .runtime.store.events(id)
          .filter((e) => e.type === "assistant_text").length,
    )
    .toBe(1);
  const page = await f.request<ConversationEventsPage>(`/conversations/${id}/events?after=1`);
  expect(page.body.events.map((e) => e.type)).toEqual([
    "tool_use",
    "tool_result",
    "turn_end",
    "user_message",
    "assistant_text",
  ]);
  expect((await f.snapshot(id)).body.queue).toEqual([]);
  const replay: unknown[] = [];
  const reopenedClient = {
    bufferedAmount: 0,
    send: (text: string) => replay.push(JSON.parse(text)),
    close: () => {},
  };
  f.hub.add(reopenedClient);
  f.hub.receive(reopenedClient, { op: "subscribe", topic: `conversation:${id}`, after: 4 });
  expect(replay).toEqual(
    f
      .runner()
      .runtime.store.events(id)
      .filter((event) => event.seq > 4)
      .map((event) => ({
        topic: `conversation:${id}`,
        seq: event.seq,
        type: "event",
        payload: {
          conversation_id: id,
          seq: event.seq,
          type: event.type,
          payload: event.payload,
          sdk_uuid: event.sdkUuid ?? null,
          created_at: 1000,
        },
      })),
  );
  expect({
    permissionMode: f.agent.opened[0]!.permissionMode,
    decisions: f.agent.permissionDecisions,
  }).toEqual({ permissionMode: "bypassPermissions", decisions: [] });
  await f.snapshot(id);
  expect((await f.snapshot(await f.start())).body.commands).toEqual([
    { name: "/dev-spec", description: "設計ループ。手順を進める" },
  ]);
});

it("自動配達で消えた画像は外して届け、info通知を配信する", async () => {
  const f = await fixture({
    rules: [
      {
        match: "^初回$",
        steps: [{ tool: "mcp__sukuna__gate", input: {}, result: "ignored" }, { end: "success" }],
      },
    ],
    fallback: [{ hold: true }],
  });
  const entered = deferred();
  const release = deferred();
  f.runner().runtime.tools.register({
    name: "gate",
    description: "待つ",
    input: {},
    alwaysLoad: true,
    handler: async () => {
      entered.resolve();
      await release.promise;
      return { text: "完了", isError: false };
    },
  });
  const id = await f.start();
  const uploaded = await f.upload(id);
  await f.send(id, "初回");
  await entered.promise;
  await f.send(id, "画像が無くなる指示", "missing-auto", "send", [uploaded.body.image.id]);
  rmSync(join(f.home, "images", id, `${uploaded.body.image.id}.png`));
  const info = deferred();
  f.runner().changes.subscribe((notice) => {
    if (notice.kind === "notice") {
      f.notices.push(notice);
      info.resolve();
    }
  });
  release.resolve();
  await info.promise;
  expect({ messages: f.agent.messages, notice: f.notices }).toEqual({
    messages: [
      { text: "初回", images: [] },
      { text: "画像が無くなる指示", images: [] },
    ],
    notice: [
      {
        kind: "notice",
        level: "info",
        conversation_id: id,
        message: "画像 1 件が見つからないため、外して届けました",
      },
    ],
  });
});

it("指示の受理待ちに別タブが保存した下書きは成功後も消さない", async () => {
  const f = await fixture();
  const id = await f.start();
  await f.send(id, "最初");
  await f.request(`/conversations/${id}/draft`, "PUT", {
    text: "送る",
    images: [],
    clientId: "tab-a",
    editedAt: 2000,
  });
  const entered = deferred();
  const release = deferred();
  f.agent.beforeInterrupt = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.send(id, "送る", "race", "interrupt");
  await entered.promise;
  await f.request(`/conversations/${id}/draft`, "PUT", {
    text: "別タブの入力",
    images: [],
    clientId: "tab-b",
    editedAt: 3000,
  });
  release.resolve();
  expect(await pending).toEqual(delivered);
  expect((await f.snapshot(id)).body.draft).toEqual({
    text: "別タブの入力",
    images: [],
    updatedBy: "tab-b",
    updatedAt: 3000,
  });
});

it("同時に届く回答の送信は一回だけ受け付け、同じ回答を指示として送り直さない", async () => {
  const f = await fixture({ rules: [], fallback: [{ ask: [question("Q1")] }, { hold: true }] });
  const id = await f.start();
  await f.send(id, "質問");
  await settled(f, id, "waiting_answer");
  const q = f
    .runner()
    .runtime.store.events(id)
    .find((event) => event.type === "question")!;
  await f.request(`/conversations/${id}/answers`, "PUT", {
    questionSeq: q.seq,
    answers: { "0": { choices: ["A"], text: null } },
  });
  const results = await Promise.all([
    f.request(`/conversations/${id}/answers/send`, "POST", { confirmUnanswered: false }),
    f.request(`/conversations/${id}/answers/send`, "POST", { confirmUnanswered: false }),
  ]);
  expect(results).toEqual([
    { status: 202, body: { result: "answered" } },
    {
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: "会話の状態が変わりました。もう一度操作してください。",
        },
      },
    },
  ]);
  expect({
    answers: f.agent.receivedAnswers,
    sent: f.agent.sent.map((message) => message.text),
  }).toEqual({
    answers: [
      { requestId: q.type === "question" ? q.payload.request_id : "", answers: { Q1: "A" } },
    ],
    sent: ["質問"],
  });
});

it("保存前に編集して送った初回の指示も、受理したら古い下書きを消す", async () => {
  const f = await fixture();
  const id = await f.start();
  await f.request(`/conversations/${id}/draft`, "PUT", {
    text: "書きかけ",
    images: [],
    clientId: "tab",
    editedAt: 20,
  });
  expect(await f.send(id, "書きかけを完成させた指示", "fresh")).toEqual(delivered);
  expect({
    draft: (await f.snapshot(id)).body.draft,
    sent: f.agent.sent.map((message) => message.text),
  }).toEqual({ draft: null, sent: ["書きかけを完成させた指示"] });
});

it("キューだけを配達して閉じた会話を開き直しても、未送信の本文と画像の下書きは残る", async () => {
  const f = await fixture();
  const id = await f.start();
  await f.send(id, "最初");
  await f.send(id, "預ける", "queue-only");
  const image = (await f.upload(id)).body.image.id;
  const draft = {
    text: "まだ送らない書きかけ",
    images: [image],
    updatedAt: 4000,
    updatedBy: "tab-a",
  };
  await f.request(`/conversations/${id}/draft`, "PUT", {
    text: draft.text,
    images: draft.images,
    editedAt: draft.updatedAt,
    clientId: draft.updatedBy,
  });
  await f.request(`/conversations/${id}/stop`, "POST");
  f.database.sqlite.prepare("UPDATE conversations SET closed_at=500 WHERE id=?").run(id);
  expect(await f.send(id, "", "deliver-only")).toEqual(delivered);
  const snapshot = (await f.snapshot(id)).body;
  expect({
    draft: snapshot.draft,
    closedAt: snapshot.conversation.closedAt,
    messages: f.agent.messages,
  }).toEqual({
    draft,
    closedAt: null,
    messages: [
      { text: "最初", images: [] },
      { text: "預ける", images: [] },
    ],
  });
});

it.each(["text", "image"])(
  "割り込み待ちの同じミリ秒に%sを取り消した場合も戻した下書きは消さない",
  async (kind) => {
    const f = await fixture();
    const id = await f.start();
    f.clock.time = 4000;
    await f.send(id, "最初");
    const image = (await f.upload(id)).body.image.id;
    const queued = await f.send(
      id,
      kind === "text" ? "取り消して残す内容" : "",
      "returned",
      "send",
      kind === "image" ? [image] : [],
    );
    await f.request(`/conversations/${id}/draft`, "PUT", {
      text: "送る本文",
      images: [],
      clientId: "tab-a",
      editedAt: 4000,
    });
    const entered = deferred();
    const release = deferred();
    f.agent.beforeInterrupt = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = f.send(id, "送る本文", "same-ms", "interrupt");
    await entered.promise;
    expect(
      await f.request(`/conversations/${id}/queue/${queued.body.queueItem!.id}`, "DELETE"),
    ).toEqual({ status: 204, body: null });
    const returned = (await f.snapshot(id)).body.draft;
    const expected = {
      text: kind === "text" ? "送る本文\n\n取り消して残す内容" : "送る本文",
      images: kind === "image" ? [image] : [],
      updatedAt: 4000,
      updatedBy: "tab-a",
    };
    expect(returned).toEqual(expected);
    release.resolve();
    expect(await pending).toEqual(delivered);
    expect({ draft: (await f.snapshot(id)).body.draft, messages: f.agent.messages }).toEqual({
      draft: expected,
      messages: [
        { text: "最初", images: [] },
        { text: "送る本文", images: [] },
      ],
    });
  },
);

it.each(["send", "interrupt"])(
  "配達判定の待機中に番が正常終了した%sは、最新の状態で直接届ける",
  async (mode) => {
    const f = await fixture({
      rules: [
        {
          match: "^最初$",
          steps: [{ tool: "mcp__sukuna__gate", input: {}, result: "ignored" }, { end: "success" }],
        },
      ],
      fallback: [{ hold: true }],
    });
    const turnEntered = deferred();
    const finishTurn = deferred();
    f.runner().runtime.tools.register({
      name: "gate",
      description: "番を終える時点を決める",
      input: {},
      alwaysLoad: true,
      handler: async () => {
        turnEntered.resolve();
        await finishTurn.promise;
        return { text: "完了", isError: false };
      },
    });
    const id = await f.start();
    await f.send(id, "最初");
    await turnEntered.promise;
    const guardEntered = deferred();
    const releaseGuard = deferred();
    let guards = 0;
    let interrupts = 0;
    f.agent.beforeInterrupt = async () => {
      interrupts += 1;
    };
    f.runner().runtime.runOptions.registerDeliveryGuard(async () => {
      guards += 1;
      guardEntered.resolve();
      await releaseGuard.promise;
      return ok(undefined);
    });
    const pending = f.send(id, "次の指示", "guard-race", mode);
    await guardEntered.promise;
    finishTurn.resolve();
    await settled(f, id, "idle");
    releaseGuard.resolve();
    expect(await pending).toEqual(delivered);
    expect({
      state: f.runner().runtime.store.get(id)!.runState,
      queue: f.runner().runtime.store.queue(id),
      sent: f.agent.sent.map((message) => message.text),
      origins: f
        .runner()
        .runtime.store.events(id)
        .flatMap((event) => (event.type === "user_message" ? [event.payload.origin] : [])),
      guards,
      interrupts,
    }).toEqual({
      state: "working",
      queue: [],
      sent: ["最初", "次の指示"],
      origins: ["developer", "developer"],
      guards: 1,
      interrupts: 0,
    });
  },
);

it.each(["draft", "stock"])(
  "空の割り込みを待つ間に最後の%sキューを取り消すと、空文を配達せず戻した内容を保つ",
  async (source) => {
    const f = await fixture();
    const id = await f.start();
    await f.send(id, "最初");
    const queued = await f.send(id, "取り消す内容", "cancel-all");
    const itemId = queued.body.queueItem!.id;
    if (source === "stock") {
      f.database.sqlite
        .prepare(
          "INSERT INTO stock_items (id,conversation_id,kind,text,state,sent_at) VALUES ('return-stock',?,'instruction','取り消す内容','sent',1000)",
        )
        .run(id);
      f.database.sqlite
        .prepare("UPDATE queued_instructions SET stock_item_id='return-stock' WHERE id=?")
        .run(itemId);
    }
    const entered = deferred();
    const release = deferred();
    f.agent.beforeInterrupt = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = f.send(id, "", "empty-interrupt", "interrupt");
    await entered.promise;
    expect(await f.request(`/conversations/${id}/queue/${itemId}`, "DELETE")).toEqual({
      status: 204,
      body: null,
    });
    release.resolve();
    expect(await pending).toEqual(invalid);
    const state = (await f.snapshot(id)).body;
    expect({
      state: state.conversation.runState,
      reason: state.conversation.stopReason,
      queue: state.queue,
      draft: state.draft,
      messages: f.agent.messages,
      events: f
        .runner()
        .runtime.store.events(id)
        .map((event) => event.type),
      stock:
        f.database.sqlite
          .prepare("SELECT state,sent_seq FROM stock_items WHERE id='return-stock'")
          .get() ?? null,
    }).toEqual({
      state: "failed",
      reason: "error",
      queue: [],
      draft:
        source === "draft"
          ? { text: "取り消す内容", images: [], updatedAt: 1000, updatedBy: "cancel-all" }
          : null,
      messages: [{ text: "最初", images: [] }],
      events: ["user_message", "assistant_text", "turn_end", "stopped"],
      stock: source === "stock" ? { state: "stocked", sent_seq: null } : null,
    });
    f.agent.beforeInterrupt = undefined;
    expect(await f.send(id, "次の指示", "empty-interrupt")).toEqual(delivered);
    expect(f.agent.sent.map((message) => message.text)).toEqual(["最初", "次の指示"]);
  },
);

it("明示キュー配達の判定待ちに最後の項目を取り消すと、実IPCは空文の受付を作らない", async () => {
  const f = await fixture();
  const id = await f.start();
  await f.send(id, "最初");
  const queued = await f.send(id, "戻す内容", "manual-cancel");
  await f.request(`/conversations/${id}/stop`, "POST");
  const before = f.runner().runtime.store.events(id);
  const entered = deferred();
  const release = deferred();
  f.runner().runtime.runOptions.registerDeliveryGuard(async () => {
    entered.resolve();
    await release.promise;
    return ok(undefined);
  });
  const pending = f.link.call("POST", `/conversations/${id}/queue/deliver`);
  await entered.promise;
  expect(
    await f.request(`/conversations/${id}/queue/${queued.body.queueItem!.id}`, "DELETE"),
  ).toEqual({ status: 204, body: null });
  release.resolve();
  expect((await pending)._unsafeUnwrap()).toEqual({ status: 400, body: invalid.body });
  const snapshot = (await f.snapshot(id)).body;
  expect({
    state: snapshot.conversation.runState,
    draft: snapshot.draft,
    queue: snapshot.queue,
    messages: f.agent.messages,
    events: f.runner().runtime.store.events(id),
  }).toEqual({
    state: "stopped",
    draft: { text: "戻す内容", images: [], updatedAt: 1000, updatedBy: "manual-cancel" },
    queue: [],
    messages: [{ text: "最初", images: [] }],
    events: before,
  });
});

it.each(["invalid_input", "internal"])(
  "割り込み停止後の画像%sでも未配達の内容を保ち、修正して通常送信すると続けられる",
  async (code) => {
    const f = await fixture();
    const id = await f.start();
    await f.send(id, "最初");
    const image = (await f.upload(id)).body.image.id;
    const queued = await f.send(id, "預ける内容", "image-queue", "send", [image]);
    const itemId = queued.body.queueItem!.id;
    await f.request(`/conversations/${id}/draft`, "PUT", {
      text: "次の指示",
      images: [],
      clientId: "tab",
      editedAt: 1000,
    });
    const original = f.runner().runtime.options.images;
    let fail = false;
    const imageError = {
      code: "internal" as const,
      message: "画像を読み取れませんでした。もう一度操作してください。",
    };
    if (code === "internal")
      f.runner().runtime.options.images = {
        read: (conversationId, imageId) =>
          fail ? err(imageError) : original.read(conversationId, imageId),
      };
    const notices: unknown[] = [];
    f.runner().changes.subscribe((notice) => {
      if (notice.kind === "notice") notices.push(notice);
    });
    const entered = deferred();
    const release = deferred();
    f.agent.beforeInterrupt = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = f.send(id, "次の指示", "image-retry", "interrupt");
    await entered.promise;
    const missing = "01J00000000000000000000999";
    if (code === "invalid_input")
      expect(
        (
          await f.request(`/conversations/${id}/queue/${itemId}`, "PATCH", {
            text: "預ける内容",
            images: [missing],
          })
        ).status,
      ).toBe(200);
    fail = true;
    release.resolve();
    const error =
      code === "invalid_input"
        ? { code, message: "画像が見つかりません。貼り直してください" }
        : imageError;
    expect(await pending).toEqual({
      status: code === "invalid_input" ? 400 : 500,
      body: { error },
    });
    const snapshot = (await f.snapshot(id)).body;
    expect({
      state: snapshot.conversation.runState,
      reason: snapshot.conversation.stopReason,
      draft: snapshot.draft,
      queue: snapshot.queue,
      messages: f.agent.messages,
      stopped: f
        .runner()
        .runtime.store.events(id)
        .filter((event) => event.type === "stopped")
        .map((event) => event.payload),
      receipts: f
        .runner()
        .runtime.store.events(id)
        .flatMap((event) => (event.type === "user_message" ? event.payload.client_ids : [])),
      notices,
    }).toEqual({
      state: "failed",
      reason: "error",
      draft: { text: "次の指示", images: [], updatedAt: 1000, updatedBy: "tab" },
      queue: [
        { ...queued.body.queueItem!, images: code === "invalid_input" ? [missing] : [image] },
      ],
      messages: [{ text: "最初", images: [] }],
      stopped: [{ reason: "error", detail: error.message }],
      receipts: ["最初"],
      notices: [{ kind: "notice", level: "error", conversation_id: id, message: error.message }],
    });
    fail = false;
    f.agent.beforeInterrupt = undefined;
    expect(
      (
        await f.request(`/conversations/${id}/queue/${itemId}`, "PATCH", {
          text: "直した内容",
          images: [],
        })
      ).status,
    ).toBe(200);
    expect(await f.send(id, "次の指示", "image-retry")).toEqual(delivered);
    expect({
      messages: f.agent.messages,
      draft: (await f.snapshot(id)).body.draft,
      queue: f.runner().runtime.store.queue(id),
    }).toEqual({
      messages: [
        { text: "最初", images: [] },
        { text: "直した内容\n\n次の指示", images: [] },
      ],
      draft: null,
      queue: [],
    });
  },
);

it.each(["text", "image"])(
  "空の割り込みの待機中に一部を取り消しても、残る%sの指示だけを届ける",
  async (kind) => {
    const f = await fixture();
    const id = await f.start();
    await f.send(id, "最初");
    const cancelled = await f.send(id, "取り消した指示", "cancel-one");
    const image = (await f.upload(id)).body.image.id;
    await f.send(
      id,
      kind === "text" ? "残る指示" : "",
      "remaining",
      "send",
      kind === "image" ? [image] : [],
    );
    const entered = deferred();
    const release = deferred();
    f.agent.beforeInterrupt = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = f.send(id, "", "remaining-delivery", "interrupt");
    await entered.promise;
    expect(
      await f.request(`/conversations/${id}/queue/${cancelled.body.queueItem!.id}`, "DELETE"),
    ).toEqual({ status: 204, body: null });
    release.resolve();
    expect(await pending).toEqual(delivered);
    expect({
      draft: (await f.snapshot(id)).body.draft,
      messages: f.agent.messages,
      queue: f.runner().runtime.store.queue(id),
      stopped: f
        .runner()
        .runtime.store.events(id)
        .filter((event) => event.type === "stopped"),
    }).toEqual({
      draft: { text: "取り消した指示", images: [], updatedAt: 1000, updatedBy: "cancel-one" },
      messages: [
        { text: "最初", images: [] },
        {
          text: kind === "text" ? "残る指示" : "",
          images: kind === "image" ? [{ data: png, mediaType: "image/png" }] : [],
        },
      ],
      queue: [],
      stopped: [],
    });
  },
);

it.each([
  { text: "", missing: 0 },
  { text: "残る本文", missing: 1 },
  { text: "残る本文", missing: 2 },
  { text: "", missing: 1 },
  { text: "", missing: 2 },
])(
  "自動配達は本文 '$text'・画像の欠落 $missing 件を扱い、全欠落は添付し直して送れる",
  async ({ text, missing }) => {
    const f = await fixture({
      rules: [
        {
          match: "^初回$",
          steps: [
            { tool: "mcp__sukuna__image_gate", input: {}, result: "ignored" },
            { end: "success" },
          ],
        },
      ],
      fallback: [{ hold: true }],
    });
    const entered = deferred();
    const release = deferred();
    f.runner().runtime.tools.register({
      name: "image_gate",
      description: "画像の配達前を待つ",
      input: {},
      alwaysLoad: true,
      handler: async () => {
        entered.resolve();
        await release.promise;
        return { text: "完了", isError: false };
      },
    });
    const id = await f.start();
    const images = [(await f.upload(id)).body.image.id, (await f.upload(id)).body.image.id];
    const draftImage = (await f.upload(id)).body.image.id;
    await f.send(id, "初回");
    await entered.promise;
    const queued = await f.send(id, text, "boundary-queued", "send", images);
    const item = queued.body.queueItem!;
    expect(queued).toEqual({
      status: 202,
      body: {
        result: "queued",
        queueItem: {
          id: item.id,
          text,
          images,
          position: 1,
          stockItemId: null,
          clientId: "boundary-queued",
          createdAt: 1000,
        },
      },
    });
    const draft = {
      text: "未送信の下書き",
      images: [draftImage],
      updatedAt: 2000,
      updatedBy: "tab",
    };
    await f.request(`/conversations/${id}/draft`, "PUT", {
      text: draft.text,
      images: draft.images,
      editedAt: draft.updatedAt,
      clientId: draft.updatedBy,
    });
    for (const image of images.slice(0, missing))
      rmSync(join(f.home, "images", id, `${image}.png`));
    const notices: unknown[] = [];
    f.runner().changes.subscribe((notice) => {
      if (notice.kind === "notice") notices.push(notice);
    });
    const ended = deferred();
    f.runner().runtime.subscribe((signal) => {
      if (signal.type === "turnEnded" && signal.conversationId === id) ended.resolve();
    });
    release.resolve();
    await ended.promise;
    await f.runner().runtime.serial(id, async () => ok(undefined));
    const stalled = !text && missing === 2;
    const expectedError =
      "画像が見つからないため、指示を届けられませんでした。画像を添付し直して、もう一度送ってください。";
    const snapshot = (await f.snapshot(id)).body;
    const messages = f
      .runner()
      .runtime.store.events(id)
      .filter((event) => event.type === "user_message");
    expect({
      sent: f.agent.messages,
      state: snapshot.conversation.runState,
      queue: snapshot.queue,
      draft: snapshot.draft,
      notices,
      deliveredEvents: messages.slice(1).map((event) => event.payload),
    }).toEqual({
      sent: [
        { text: "初回", images: [] },
        ...(stalled
          ? []
          : [
              {
                text,
                images: images.slice(missing).map(() => ({ data: png, mediaType: "image/png" })),
              },
            ]),
      ],
      state: stalled ? "idle" : "working",
      queue: stalled ? [item] : [],
      draft,
      notices: missing
        ? [
            {
              kind: "notice",
              level: stalled ? "error" : "info",
              conversation_id: id,
              message: stalled
                ? expectedError
                : `画像 ${missing} 件が見つからないため、外して届けました`,
            },
          ]
        : [],
      deliveredEvents: stalled
        ? []
        : [
            {
              text,
              images: images
                .slice(missing)
                .map((image) => ({ path: `images/${id}/${image}.png`, media_type: "image/png" })),
              origin: "queued",
              client_ids: ["boundary-queued"],
              queued_ids: [item.id],
              client_receipts: [
                {
                  client_id: "boundary-queued",
                  result: "queued",
                  queued_id: item.id,
                  received_at: 1000,
                },
              ],
            },
          ],
    });
    if (stalled) {
      expect(await f.send(id, text, "boundary-queued", "send", images)).toEqual(queued);
      const replacement = (await f.upload(id)).body.image.id;
      expect(
        await f.request(`/conversations/${id}/queue/${item.id}`, "PATCH", {
          text,
          images: [replacement],
        }),
      ).toEqual({ status: 200, body: { queueItem: { ...item, images: [replacement] } } });
      expect(await f.send(id, "", "repaired-delivery")).toEqual(delivered);
      const last = f
        .runner()
        .runtime.store.events(id)
        .filter((event) => event.type === "user_message")
        .at(-1)!;
      expect({
        sent: f.agent.messages,
        queue: (await f.snapshot(id)).body.queue,
        draft: (await f.snapshot(id)).body.draft,
        delivered: last.payload,
      }).toEqual({
        sent: [
          { text: "初回", images: [] },
          { text: "", images: [{ data: png, mediaType: "image/png" }] },
        ],
        queue: [],
        draft,
        delivered: {
          text: "",
          images: [{ path: `images/${id}/${replacement}.png`, media_type: "image/png" }],
          origin: "developer",
          client_ids: ["boundary-queued", "repaired-delivery"],
          queued_ids: [item.id],
          client_receipts: [
            {
              client_id: "boundary-queued",
              result: "queued",
              queued_id: item.id,
              received_at: 1000,
            },
            { client_id: "repaired-delivery", result: "delivered", received_at: 1000 },
          ],
        },
      });
      const before = f.agent.messages.length;
      expect(await f.send(id, text, "boundary-queued", "send", images)).toEqual({
        status: 202,
        body: { result: "queued", queueItem: null },
      });
      expect(f.agent.messages.length).toBe(before);
    }
  },
);

it.each(["edit", "cancel-all-draft", "cancel-all-stock", "cancel-one"])(
  "作業場所の古い出力を待つ間の %s は、検証済みの作業場所と最新のキューで配達する",
  async (action) => {
    const f = await fixture();
    const id = await f.start();
    const oldCwd = join(f.home, "old-workspace");
    const newCwd = join(f.home, "new-workspace");
    mkdirSync(oldCwd);
    mkdirSync(newCwd);
    const recordWorktree = f.database.sqlite.prepare(
      "INSERT INTO worktrees (id,project_id,path,branch,origin) VALUES (?,'p',?,?,'user')",
    );
    recordWorktree.run("old-worktree", oldCwd, "old");
    recordWorktree.run("verified-worktree", newCwd, "new");
    const activity = createWorktreeActivity(f.database.sqlite.name);
    activity.run((reservation) => {
      reservation.acquire(["old-worktree"]);
      f.database.sqlite
        .prepare("UPDATE conversations SET cwd=?,worktree_id='old-worktree' WHERE id=?")
        .run(oldCwd, id);
    });
    await f.send(id, "最初");
    const originalImage = (await f.upload(id)).body.image.id;
    const changedBytes = Buffer.from("GIF89a");
    const changedImage = (await f.upload(id, changedBytes, "image/gif")).body.image.id;
    const queued = await f.send(id, "古い本文", "old-queued", "send", [originalImage]);
    const item = queued.body.queueItem!;
    const remaining =
      action === "cancel-one"
        ? await f.send(id, "残る本文", "remaining-queued", "send", [changedImage])
        : undefined;
    if (action === "cancel-all-stock") {
      f.database.sqlite
        .prepare(
          "INSERT INTO stock_items (id,conversation_id,kind,text,state,sent_at) VALUES ('close-stock',?,'instruction','古い本文','sent',1000)",
        )
        .run(id);
      f.database.sqlite
        .prepare("UPDATE queued_instructions SET stock_item_id='close-stock' WHERE id=?")
        .run(item.id);
    }
    expect(await f.request(`/conversations/${id}/stop`, "POST")).toEqual({
      status: 202,
      body: { runState: "stopped" },
    });
    const oldEvents = f.runner().runtime.store.events(id);
    activity.run((reservation) => {
      reservation.acquire(["old-worktree", "verified-worktree"]);
      f.database.sqlite
        .prepare("UPDATE conversations SET cwd=?,worktree_id=NULL WHERE id=?")
        .run(newCwd, id);
    });
    const entered = deferred();
    const release = deferred();
    f.agent.beforeOutputEnd = async () => {
      entered.resolve();
      await release.promise;
    };
    let leaseHeldAtSend = false;
    f.agent.beforeSend = (params) => {
      if (params.cwd === newCwd) {
        const lease = activity.acquire(["verified-worktree"]);
        leaseHeldAtSend = lease.isErr();
        if (lease.isOk()) lease.value.release();
      }
    };
    const pending = f.send(id, action === "edit" ? "末尾の指示" : "", "close-delivery");
    try {
      await entered.promise;
      const available = activity.acquire(["old-worktree", "verified-worktree"]);
      expect(available.isOk()).toBe(true);
      available._unsafeUnwrap().release();
      if (action === "edit")
        expect(
          await f.request(`/conversations/${id}/queue/${item.id}`, "PATCH", {
            text: "編集した本文",
            images: [changedImage],
          }),
        ).toEqual({
          status: 200,
          body: { queueItem: { ...item, text: "編集した本文", images: [changedImage] } },
        });
      else
        expect(await f.request(`/conversations/${id}/queue/${item.id}`, "DELETE")).toEqual({
          status: 204,
          body: null,
        });
      const returnedDraft = (await f.snapshot(id)).body.draft;
      release.resolve();
      if (action.startsWith("cancel-all")) {
        expect(await pending).toEqual(invalid);
        expect({
          opened: f.agent.opened.length,
          messages: f.agent.messages,
          events: f.runner().runtime.store.events(id),
          queue: f.runner().runtime.store.queue(id),
          draft: (await f.snapshot(id)).body.draft,
          receipt: f.runner().runtime.store.duplicate(id, "close-delivery", 0),
          stock:
            f.database.sqlite
              .prepare("SELECT state,sent_seq FROM stock_items WHERE id='close-stock'")
              .get() ?? null,
        }).toEqual({
          opened: 1,
          messages: [{ text: "最初", images: [] }],
          events: oldEvents,
          queue: [],
          draft: returnedDraft,
          receipt: null,
          stock: action === "cancel-all-stock" ? { state: "stocked", sent_seq: null } : null,
        });
        expect(returnedDraft).toEqual(
          action === "cancel-all-stock"
            ? null
            : {
                text: "古い本文",
                images: [originalImage],
                updatedAt: 1000,
                updatedBy: "old-queued",
              },
        );
      } else {
        expect(await pending).toEqual(delivered);
        const retained = action === "edit" ? item : remaining!.body.queueItem!;
        const text = action === "edit" ? "編集した本文\n\n末尾の指示" : "残る本文";
        const event = f
          .runner()
          .runtime.store.events(id)
          .filter((event) => event.type === "user_message")
          .at(-1)!;
        expect({
          opened: f.agent.opened.map((params) => ({
            cwd: params.cwd,
            sessionId: params.sessionId,
            resume: params.resume,
          })),
          actualWorktreeId: f.runner().runtime.executions.get(id)?.worktreeId,
          savedWorktreeId: f.runner().runtime.store.get(id)!.worktreeId,
          leaseHeldAtSend,
          sent: f.agent.messages,
          event: event.payload,
          queue: (await f.snapshot(id)).body.queue,
          draft: (await f.snapshot(id)).body.draft,
        }).toEqual({
          opened: [
            { cwd: oldCwd, sessionId: f.agent.opened[0]!.sessionId, resume: false },
            { cwd: newCwd, sessionId: f.agent.opened[0]!.sessionId, resume: true },
          ],
          actualWorktreeId: "verified-worktree",
          savedWorktreeId: null,
          leaseHeldAtSend: true,
          sent: [
            { text: "最初", images: [] },
            { text, images: [{ data: changedBytes, mediaType: "image/gif" }] },
          ],
          event: {
            text,
            images: [{ path: `images/${id}/${changedImage}.gif`, media_type: "image/gif" }],
            origin: "developer",
            client_ids: [retained.clientId, "close-delivery"],
            queued_ids: [retained.id],
            client_receipts: [
              {
                client_id: retained.clientId,
                result: "queued",
                queued_id: retained.id,
                received_at: 1000,
              },
              { client_id: "close-delivery", result: "delivered", received_at: 1000 },
            ],
          },
          queue: [],
          draft: returnedDraft,
        });
      }
    } finally {
      release.resolve();
      await pending;
    }
  },
);

async function queueApiProcess(f: Awaited<ReturnType<typeof fixture>>) {
  const code = `
    import {createServer} from 'vite';
    import {serve} from '@hono/node-server';
    import {Hono} from 'hono';
    import Database from 'better-sqlite3';
    import {err} from 'neverthrow';
    const loader = await createServer({configFile:false,root:process.cwd(),envDir:false,server:{middlewareMode:true,ws:false,watch:null},optimizeDeps:{entries:[]}});
    const {createConversationRoutes} = await loader.ssrLoadModule('/src/server/modules/conversation/adapter/http.ts');
    const {createConversationDependencies} = await loader.ssrLoadModule('/src/server/modules/conversation/adapter/dependencies.ts');
    const sqlite = new Database(process.env.QUEUE_TEST_DATABASE);
    const deps = createConversationDependencies({sqlite,home:process.env.QUEUE_TEST_HOME,runner:{call:async()=>err({code:'runner_unavailable',message:'unused'})},id:()=> 'unused',now:()=>1000,changed:()=>{},reopened:()=>{}});
    const app = new Hono().route('/api',createConversationRoutes(deps));
    const server = serve({fetch:app.fetch,port:0,hostname:'127.0.0.1'},info=>console.log(JSON.stringify({port:info.port})));
    process.on('SIGTERM',()=>server.close(async()=>{sqlite.close();await loader.close();process.exit(0);}));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    cwd: fileURLToPath(new URL("../../../../../", import.meta.url)),
    env: { ...process.env, QUEUE_TEST_DATABASE: f.database.sqlite.name, QUEUE_TEST_HOME: f.home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  cleanups.unshift(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  });
  let errors = "";
  child.stderr.on("data", (data: Buffer) => (errors += data.toString()));
  const lines = createInterface({ input: child.stdout });
  const port = await new Promise<number>((resolve, reject) => {
    lines.on("line", (line) => {
      if (line.startsWith('{"port":')) resolve((JSON.parse(line) as { port: number }).port);
    });
    child.once("exit", () => {
      lines.close();
      reject(new Error(errors));
    });
  });
  return (id: string, item: ConversationQueueItem, action: string, changedImage: string) => {
    const edit = action === "edit";
    const args = [
      "-sS",
      "--max-time",
      "5",
      "-X",
      edit ? "PATCH" : "DELETE",
      "-w",
      "\n%{http_code}",
      `http://127.0.0.1:${port}/api/conversations/${id}/queue/${item.id}`,
    ];
    if (edit)
      args.push(
        "-H",
        "Content-Type: application/json",
        "-d",
        JSON.stringify({ text: "編集した本文", images: [changedImage] }),
      );
    const result = spawnSync("curl", args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    const split = result.stdout.lastIndexOf("\n");
    const body = result.stdout.slice(0, split);
    return { status: Number(result.stdout.slice(split + 1)), body: body ? JSON.parse(body) : null };
  };
}

it.each(
  ["send", "queue", "interrupt", "automatic"].flatMap((delivery) =>
    ["edit", "cancel-all-draft", "cancel-all-stock", "cancel-one"].flatMap((action) =>
      ["before-images", "during-images", "after-delivery"].map((phase) => ({
        delivery,
        action,
        phase,
      })),
    ),
  ),
)(
  "別プロセスのキュー操作と配達は先に確定した方だけを反映する: $delivery / $action / $phase",
  async ({ delivery, action, phase }) => {
    const automatic = delivery === "automatic";
    const f = await fixture(
      automatic
        ? {
            rules: [{ match: "^最初$", steps: [{ end: "success" }] }],
            fallback: [{ hold: true }],
          }
        : undefined,
    );
    const id = await f.start();
    const entered = deferred();
    const advance = deferred();
    f.agent.beforeTurnEnd = async () => {
      if (automatic) {
        entered.resolve();
        await advance.promise;
      }
    };
    await f.send(id, "最初");
    if (automatic) await entered.promise;
    const image = (await f.upload(id)).body.image.id;
    const gif = Buffer.from("GIF89a");
    const changedImage = (await f.upload(id, gif, "image/gif")).body.image.id;
    const queued = await f.send(id, "古い本文", "race-original", "send", [image]);
    const item = queued.body.queueItem!;
    const remaining =
      action === "cancel-one"
        ? (await f.send(id, "残る本文", "race-remaining", "send", [changedImage])).body.queueItem!
        : null;
    const items = [item, ...(remaining ? [remaining] : [])];
    for (const [index, queuedItem] of items.entries()) {
      f.database.sqlite
        .prepare("UPDATE queued_instructions SET timeline_comments=? WHERE id=?")
        .run(
          JSON.stringify([{ task_id: String(index + 1), text: `相談${index + 1}` }]),
          queuedItem.id,
        );
      if (action !== "cancel-all-draft") {
        f.database.sqlite
          .prepare(
            "INSERT INTO stock_items (id,conversation_id,kind,text,state,sent_at) VALUES (?,?,'instruction',?,'sent',1000)",
          )
          .run(`race-stock-${index}`, id, queuedItem.text);
        f.database.sqlite
          .prepare("UPDATE queued_instructions SET stock_item_id=? WHERE id=?")
          .run(`race-stock-${index}`, queuedItem.id);
        queuedItem.stockItemId = `race-stock-${index}`;
      }
    }
    const draft = { text: "書きかけ", images: [changedImage], updatedAt: 1000, updatedBy: "tab" };
    await f.request(`/conversations/${id}/draft`, "PUT", {
      text: draft.text,
      images: draft.images,
      editedAt: draft.updatedAt,
      clientId: draft.updatedBy,
    });
    if (delivery === "send" || delivery === "queue") {
      await f.request(`/conversations/${id}/stop`, "POST");
      await f.restart();
    }
    const operate = await queueApiProcess(f);
    let operation: { status: number; body: unknown } | undefined;
    const change = () => {
      operation = operate(id, item, action, changedImage);
    };
    const imageFiles = f.runner().runtime.options.images;
    let reads = 0;
    const ended = deferred();
    f.runner().runtime.subscribe((signal) => {
      if (signal.type === "turnEnded" && signal.conversationId === id) ended.resolve();
    });
    try {
      if (phase === "before-images") change();
      if (phase === "during-images")
        f.runner().runtime.options.images = {
          read(conversationId, imageId) {
            if (++reads === items.length + 1) change();
            return imageFiles.read(conversationId, imageId);
          },
        };
      const suffix = delivery === "send" || delivery === "interrupt" ? "末尾" : "";
      let result: { status: number; body: unknown } | undefined;
      if (automatic) {
        advance.resolve();
        await ended.promise;
        await f.runner().runtime.serial(id, async () => ok(undefined));
      } else
        result = await f.send(
          id,
          suffix,
          "race-delivery",
          delivery === "interrupt" ? "interrupt" : "send",
        );
      if (phase === "after-delivery") change();
      const deliveredFirst = phase === "after-delivery";
      const allCancelled = action.startsWith("cancel-all") && !deliveredFirst;
      const retained = deliveredFirst
        ? items
        : action === "cancel-one"
          ? [remaining!]
          : allCancelled
            ? []
            : [item];
      const expectedInputs = retained.map((queuedItem) => ({
        text: action === "edit" && !deliveredFirst ? "編集した本文" : queuedItem.text,
        images: [
          {
            data: queuedItem === item && (deliveredFirst || action !== "edit") ? png : gif,
            mediaType:
              queuedItem === item && (deliveredFirst || action !== "edit")
                ? "image/png"
                : "image/gif",
          },
        ],
      }));
      const noDelivery = allCancelled && !suffix;
      const text = [...expectedInputs.map((input) => input.text), ...(suffix ? [suffix] : [])].join(
        "\n\n",
      );
      const messages = f
        .runner()
        .runtime.store.events(id)
        .filter((event) => event.type === "user_message");
      const sent = messages.at(-1)!;
      const expectedDraft =
        !deliveredFirst && action === "cancel-all-draft"
          ? { ...draft, text: "書きかけ\n\n古い本文", images: [changedImage, image] }
          : draft;
      const acceptedDraft =
        suffix && !noDelivery && !(action === "cancel-all-draft" && phase === "during-images")
          ? null
          : expectedDraft;
      expect({
        operation,
        result,
        opened: f.agent.opened.length,
        sent: f.agent.messages,
        event: noDelivery ? null : sent.payload,
        queue: (await f.snapshot(id)).body.queue,
        draft: (await f.snapshot(id)).body.draft,
        receipt: f.runner().runtime.store.duplicate(id, "race-delivery", 0),
        stocks: f.database.sqlite
          .prepare("SELECT id,state,sent_seq AS sentSeq FROM stock_items ORDER BY id")
          .all(),
      }).toEqual({
        operation: deliveredFirst
          ? { status: 404, body: { error: { code: "not_found", message: "すでに届きました" } } }
          : action === "edit"
            ? {
                status: 200,
                body: {
                  queueItem: {
                    ...item,
                    text: "編集した本文",
                    images: [changedImage],
                    timeline_comments: [{ task_id: "1", text: "相談1" }],
                  },
                },
              }
            : { status: 204, body: null },
        result: automatic ? undefined : noDelivery ? invalid : delivered,
        opened: (delivery === "send" || delivery === "queue") && !noDelivery ? 2 : 1,
        sent: [
          { text: "最初", images: [] },
          ...(noDelivery
            ? []
            : [{ text, images: expectedInputs.flatMap((input) => input.images) }]),
        ],
        event: noDelivery
          ? null
          : {
              text,
              images: retained.map((queuedItem) =>
                queuedItem === item && (deliveredFirst || action !== "edit")
                  ? { path: `images/${id}/${image}.png`, media_type: "image/png" }
                  : { path: `images/${id}/${changedImage}.gif`, media_type: "image/gif" },
              ),
              origin: automatic ? "queued" : delivery === "interrupt" ? "interrupt" : "developer",
              ...(retained.length
                ? {
                    timeline_comments: retained.map((queuedItem) => ({
                      task_id: queuedItem === item ? "1" : "2",
                      text: queuedItem === item ? "相談1" : "相談2",
                    })),
                    ...(suffix ? { timeline_legacy_texts: [suffix] } : {}),
                  }
                : {}),
              client_ids: [
                ...retained.map((queuedItem) => queuedItem.clientId),
                ...(automatic ? [] : ["race-delivery"]),
              ],
              queued_ids: retained.map((queuedItem) => queuedItem.id),
              client_receipts: [
                ...retained.map((queuedItem) => ({
                  client_id: queuedItem.clientId,
                  result: "queued",
                  queued_id: queuedItem.id,
                  received_at: 1000,
                })),
                ...(automatic
                  ? []
                  : [{ client_id: "race-delivery", result: "delivered", received_at: 1000 }]),
              ],
            },
        queue: [],
        draft: acceptedDraft,
        receipt: automatic || noDelivery ? null : { result: "delivered", seq: sent.seq },
        stocks:
          action === "cancel-all-draft"
            ? []
            : items.map((queuedItem, index) => ({
                id: `race-stock-${index}`,
                state: retained.includes(queuedItem) ? "sent" : "stocked",
                sentSeq: retained.includes(queuedItem) ? sent.seq : null,
              })),
      });
    } finally {
      advance.resolve();
      f.runner().runtime.options.images = imageFiles;
    }
  },
  20000,
);

it.each(["id", "position", "client_id", "created_at", "timeline_comments", "stock_item_id"])(
  "画像準備中に別接続で変わったキューの %s も照合し、最新の順序と受付情報を記録する",
  async (column) => {
    const f = await fixture();
    const id = await f.start();
    await f.send(id, "最初");
    const image = (await f.upload(id)).body.image.id;
    const first = (await f.send(id, "一つ目", "metadata-first", "send", [image])).body.queueItem!;
    const second = (await f.send(id, "二つ目", "metadata-second", "send", [image])).body.queueItem!;
    const comments = [{ task_id: "original", text: "元の相談" }];
    f.database.sqlite
      .prepare("UPDATE queued_instructions SET timeline_comments=? WHERE id=?")
      .run(JSON.stringify(comments), first.id);
    f.database.sqlite
      .prepare(
        "INSERT INTO stock_items (id,conversation_id,kind,text,state,sent_at) VALUES ('old-stock',?,'instruction','一つ目','sent',1000),('new-stock',?,'instruction','一つ目','sent',1000)",
      )
      .run(id, id);
    f.database.sqlite
      .prepare("UPDATE queued_instructions SET stock_item_id='old-stock' WHERE id=?")
      .run(first.id);
    await f.request(`/conversations/${id}/stop`, "POST");
    await f.restart();
    const sqlite = new Database(f.database.sqlite.name);
    const updates = {
      id: "updated-id",
      position: 3,
      client_id: "updated-client",
      created_at: 2000,
      timeline_comments: JSON.stringify([{ task_id: "updated", text: "新しい相談" }]),
      stock_item_id: "new-stock",
    };
    const imageFiles = f.runner().runtime.options.images;
    let reads = 0;
    f.runner().runtime.options.images = {
      read(conversationId, imageId) {
        if (++reads === 3)
          sqlite
            .transaction(() =>
              sqlite
                .prepare(`UPDATE queued_instructions SET ${column}=? WHERE id=?`)
                .run(updates[column as keyof typeof updates], first.id),
            )
            .immediate();
        return imageFiles.read(conversationId, imageId);
      },
    };
    f.clock.time = 3000;
    try {
      expect(await f.send(id, "", "metadata-delivery")).toEqual(delivered);
      const sent = f
        .runner()
        .runtime.store.events(id)
        .filter((event) => event.type === "user_message")
        .at(-1)!;
      const updatedFirst = {
        ...first,
        id: column === "id" ? "updated-id" : first.id,
        clientId: column === "client_id" ? "updated-client" : first.clientId,
        createdAt: column === "created_at" ? 2000 : first.createdAt,
      };
      const ordered = column === "position" ? [second, updatedFirst] : [updatedFirst, second];
      expect({
        sent: f.agent.messages,
        payload: sent.payload,
        queue: f.runner().runtime.store.queue(id),
        stocks: sqlite.prepare("SELECT id,sent_seq AS sentSeq FROM stock_items ORDER BY id").all(),
      }).toEqual({
        sent: [
          { text: "最初", images: [] },
          {
            text: ordered.map((item) => item.text).join("\n\n"),
            images: ordered.map(() => ({ data: png, mediaType: "image/png" })),
          },
        ],
        payload: {
          text: ordered.map((item) => item.text).join("\n\n"),
          images: ordered.map(() => ({
            path: `images/${id}/${image}.png`,
            media_type: "image/png",
          })),
          origin: "developer",
          timeline_comments:
            column === "timeline_comments"
              ? [{ task_id: "updated", text: "新しい相談" }]
              : comments,
          timeline_legacy_texts: [second.text],
          client_ids: [...ordered.map((item) => item.clientId), "metadata-delivery"],
          queued_ids: ordered.map((item) => item.id),
          client_receipts: [
            ...ordered.map((item) => ({
              client_id: item.clientId,
              result: "queued",
              queued_id: item.id,
              received_at: item.createdAt,
            })),
            { client_id: "metadata-delivery", result: "delivered", received_at: 3000 },
          ],
        },
        queue: [],
        stocks: [
          { id: "new-stock", sentSeq: column === "stock_item_id" ? sent.seq : null },
          { id: "old-stock", sentSeq: column === "stock_item_id" ? null : sent.seq },
        ],
      });
    } finally {
      f.runner().runtime.options.images = imageFiles;
      sqlite.close();
    }
  },
);

it("画像準備中のキュー編集で再試行しても、停止した質問への回答を一度だけ受理する", async () => {
  const f = await fixture({
    rules: [{ match: "^質問$", steps: [{ ask: [question("Q1")] }, { hold: true }] }],
    fallback: [{ hold: true }],
  });
  const id = await f.start();
  await f.send(id, "質問");
  await settled(f, id, "waiting_answer");
  const requested = f
    .runner()
    .runtime.store.events(id)
    .find((event) => event.type === "question")!;
  if (requested.type !== "question") throw new Error("質問がありません。");
  const image = (await f.upload(id)).body.image.id;
  const gif = Buffer.from("GIF89a");
  const replacement = (await f.upload(id, gif, "image/gif")).body.image.id;
  const item = (await f.send(id, "古い相談指示", "answer-queued", "send", [image])).body.queueItem!;
  const answers = { "0": { choices: ["A"], text: null } };
  await f.request(`/conversations/${id}/answers`, "PUT", { questionSeq: requested.seq, answers });
  await f.request(`/conversations/${id}/stop`, "POST");
  const sqlite = new Database(f.database.sqlite.name);
  const imageFiles = f.runner().runtime.options.images;
  let reads = 0;
  f.runner().runtime.options.images = {
    read(conversationId, imageId) {
      if (++reads === 2)
        sqlite
          .transaction(() =>
            sqlite
              .prepare("UPDATE queued_instructions SET text=?,images=? WHERE id=?")
              .run("最新の相談指示", JSON.stringify([replacement]), item.id),
          )
          .immediate();
      return imageFiles.read(conversationId, imageId);
    },
  };
  try {
    expect(
      await f.request(`/conversations/${id}/answers/send`, "POST", { confirmUnanswered: false }),
    ).toEqual({ status: 202, body: { result: "delivered" } });
    expect(
      await f.request(`/conversations/${id}/answers/send`, "POST", { confirmUnanswered: false }),
    ).toEqual({
      status: 409,
      body: {
        error: { code: "conflict", message: "回答する質問が変わりました。読み直してください。" },
      },
    });
    const events = f.runner().runtime.store.events(id);
    expect({
      messages: f.agent.messages,
      answers: events.filter((event) => event.type === "answer").map((event) => event.payload),
      delivered: events.filter((event) => event.type === "user_message").at(-1)!.payload,
      pending: (await f.snapshot(id)).body.pendingAnswers,
      questions: sqlite.prepare("SELECT answered FROM questions WHERE conversation_id=?").all(id),
    }).toEqual({
      messages: [
        { text: "質問", images: [] },
        { text: "最新の相談指示\n\nQ: Q1\nA: A", images: [{ data: gif, mediaType: "image/gif" }] },
      ],
      answers: [{ request_id: requested.payload.request_id, answers, as_message: true }],
      delivered: {
        text: "最新の相談指示\n\nQ: Q1\nA: A",
        images: [{ path: `images/${id}/${replacement}.gif`, media_type: "image/gif" }],
        origin: "answer_text",
        client_ids: ["answer-queued"],
        queued_ids: [item.id],
        client_receipts: [
          { client_id: "answer-queued", result: "queued", queued_id: item.id, received_at: 1000 },
        ],
      },
      pending: null,
      questions: [{ answered: 1 }],
    });
  } finally {
    f.runner().runtime.options.images = imageFiles;
    sqlite.close();
  }
});
