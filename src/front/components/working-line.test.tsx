import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { BufferController } from "../buffer/controller";
import { ConversationSession } from "../lib/conversation/session";
import { WorkMonitor, WorkingActivity } from "../lib/conversation/work-monitor";
import type { ConversationApi, Event, Snapshot } from "../lib/conversation/types";
import type { ProgressResponse } from "../../shared/progress/schema";
import type { ServerMessage } from "../../shared/ws";
import { WorkingLine } from "./working-line";

const start = 1_764_000_000_000;
const schedule = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};
const disposals: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
});
afterEach(() => {
  cleanup();
  disposals.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
});
const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

const message = (seq: number, at: number): Event => ({
  seq,
  createdAt: at,
  type: "user_message",
  payload: { text: "依頼", images: [], origin: "developer" },
});
const toolUse = (seq: number, at: number): Event => ({
  seq,
  createdAt: at,
  type: "tool_use",
  payload: {
    tool_use_id: "call",
    name: "Bash",
    input: { command: "npm test" },
    parent_tool_use_id: null,
  },
});

async function open({
  events,
  issueStage,
  reducedMotion = false,
}: {
  events: Event[];
  issueStage?: { stageStartedAt: number };
  reducedMotion?: boolean;
}) {
  const snapshot: Snapshot = {
    conversation: {
      id: "c",
      projectId: "p",
      projectName: "shop",
      title: "会話",
      kind: issueStage ? "impl" : "chat",
      issueId: issueStage ? "i" : null,
      parentConversationId: null,
      cwd: "/work",
      worktree: null,
      runState: "working",
      stopReason: null,
      resetsAt: null,
      lastSeq: events.length,
      lastReadSeq: events.length,
      lastPosition: null,
      closedAt: null,
    },
    draft: null,
    queue: [],
    pendingAnswers: null,
    pendingPermission: null,
    commands: [],
  };
  const controller = new BufferController({ url: "/conversations/c" });
  const env = { clientId: "one", id: () => "one", now: () => Date.now(), schedule };
  const session = new ConversationSession(
    "c",
    {
      get: async () => snapshot,
      events: async () => ({ events, lastSeq: events.length, hasMore: false }),
    } as Partial<ConversationApi> as ConversationApi,
    controller,
    env,
  );
  await session.load();
  const progress: ProgressResponse = {
    conversationId: "c",
    activity: issueStage
      ? {
          stage: "implement",
          stageLabel: "実装",
          stageStartedAt: issueStage.stageStartedAt,
          lastAction: "Bash(npm test)",
          lastActionAt: start,
        }
      : {
          stage: "reply",
          stageLabel: "応答",
          stageStartedAt: events[0]!.createdAt,
          lastAction: "応答を作成中",
          lastActionAt: null,
        },
    timeline: null,
    readError: null,
  };
  const monitor = new WorkMonitor(
    session,
    {
      api: async () => progress,
      now: env.now,
      schedule,
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      motion: { subscribe: () => () => {}, snapshot: () => reducedMotion },
    },
    issueStage ? { kind: "issue", id: "i" } : undefined,
  );
  disposals.push(monitor.connect());
  const view = render(<WorkingActivity monitor={monitor} session={session} />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  const receive = (value: Omit<ServerMessage, "topic">) =>
    act(() => session.receive({ topic: "conversation:c", ...value } as ServerMessage));
  const receiveEvent = (event: Event) =>
    receive({
      seq: event.seq,
      type: "event",
      payload: {
        conversation_id: "c",
        seq: event.seq,
        type: event.type,
        payload: event.payload,
        created_at: event.createdAt,
        sdk_uuid: null,
      } as never,
    });
  return {
    snapshot,
    session,
    receive,
    receiveEvent,
    text: () => view.container.textContent,
  };
}

it("印を 120 ミリ秒ごとに替え、✽ まで進んだら同じ形を逆にたどって · に戻る", () => {
  const view = render(
    <WorkingLine
      status={{ action: "考え中", turnStartedAt: start, outputTokens: null, stage: null }}
      still={false}
      now={() => Date.now()}
      schedule={schedule}
    />,
  );
  const marks = [view.container.firstElementChild?.textContent];
  for (let frame = 0; frame < 10; frame++) {
    advance(120);
    marks.push(view.container.firstElementChild?.textContent);
  }
  expect(marks).toEqual(["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢", "·"]);
});

it("番の経過もトークンの数も分からなければ、括弧ごと出さない", () => {
  const view = render(
    <WorkingLine
      status={{ action: "考え中", turnStartedAt: null, outputTokens: null, stage: null }}
      still
      now={() => Date.now()}
      schedule={schedule}
    />,
  );
  expect(view.container.textContent).toBe("✻ 考え中…");
});

it("印を止めていても、番の経過を 1 秒ごとに計算し直す", () => {
  const view = render(
    <WorkingLine
      status={{ action: "考え中", turnStartedAt: start - 59_000, outputTokens: null, stage: null }}
      still
      now={() => Date.now()}
      schedule={schedule}
    />,
  );
  expect(view.container.textContent).toBe("✻ 考え中… (59秒)");
  advance(1000);
  expect(view.container.textContent).toBe("✻ 考え中… (1分0秒)");
});

it("開発者が始めた会話では、動き・番の経過・トークンの数だけを出し、最後にしたことを出さない", async () => {
  const { receive, text } = await open({
    events: [message(1, start - 8000)],
    reducedMotion: true,
  });
  receive({ seq: 1, type: "output_tokens", payload: { tokens: 120 } });
  expect(text()).toBe("✻ 考え中… (8秒 · ↓ 120 トークン)");
});

it("issue では工程とその経過を続け、結果の届いていないツールの実行があるあいだはツールを実行中と出す", async () => {
  const { receive, receiveEvent, text } = await open({
    events: [message(1, start - 125_000), toolUse(2, start - 10_000)],
    issueStage: { stageStartedAt: start - 11 * 60_000 },
    reducedMotion: true,
  });
  receive({ seq: 2, type: "output_tokens", payload: { tokens: 2149 } });
  expect(text()).toBe("✻ ツールを実行中… (2分5秒 · ↓ 2.1k トークン) / 実装 11分");
  receiveEvent({
    seq: 3,
    createdAt: start,
    type: "tool_result",
    payload: { tool_use_id: "call", is_error: false, content: "ok", truncated: false, bytes: 2 },
  });
  expect(text()).toBe("✻ 考え中… (2分5秒 · ↓ 2.1k トークン) / 実装 11分");
});

it.each([
  {
    type: "answer",
    payload: {
      request_id: "q",
      answers: { 方針: { choices: ["A"], text: null } },
      as_message: false,
    },
  },
  { type: "permission_decision", payload: { request_id: "q", behavior: "allow" } },
] as const)("$type を受けると、その時刻から番の経過とトークンの数を数え直す", async (answer) => {
  const { receive, receiveEvent, text } = await open({
    events: [message(1, start - 600_000)],
    reducedMotion: true,
  });
  receive({ seq: 1, type: "output_tokens", payload: { tokens: 120 } });
  receiveEvent({ seq: 2, createdAt: start, ...answer } as Event);
  advance(3000);
  expect(text()).toBe("✻ 考え中… (3秒)");
  receive({ seq: 2, type: "output_tokens", payload: { tokens: 0 } });
  expect(text()).toBe("✻ 考え中… (3秒)");
  receive({ seq: 2, type: "output_tokens", payload: { tokens: 5 } });
  expect(text()).toBe("✻ 考え中… (3秒 · ↓ 5 トークン)");
});

it("動きを減らす設定のときは、タイマーを進めても印を ✻ で止め、経過だけを進める", async () => {
  const { text } = await open({ events: [message(1, start)], reducedMotion: true });
  expect(text()).toBe("✻ 考え中… (0秒)");
  advance(1200);
  expect(text()).toBe("✻ 考え中… (1秒)");
});

it("つながらないあいだは印を ✻ で止め、つなぎ直すと次の知らせまでトークンの数を出さない", async () => {
  const { session, receive, text } = await open({ events: [message(1, start)] });
  receive({ seq: 1, type: "output_tokens", payload: { tokens: 120 } });
  expect(text()).toBe("· 考え中… (0秒 · ↓ 120 トークン)");
  act(() => session.connection(false));
  advance(1200);
  expect(text()).toBe("✻ 考え中… (1秒 · ↓ 120 トークン)");
  act(() => session.connection(true));
  advance(120);
  expect(text()).toBe("✢ 考え中… (1秒)");
});

it("AI が作業中でなくなると、作業中の表示を消す", async () => {
  const { snapshot, receive, text } = await open({
    events: [message(1, start)],
    reducedMotion: true,
  });
  expect(text()).toBe("✻ 考え中… (0秒)");
  snapshot.conversation.runState = "stopped";
  receive({
    seq: 1,
    type: "state",
    payload: { run_state: "stopped", stop_reason: "user", resets_at: null },
  });
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(text()).toBe("");
});
