import { expect, it, vi } from "vite-plus/test";
import { Realtime, type RealtimeSocket } from "./realtime";
import type { ServerMessage } from "../../shared/ws";

class Socket implements RealtimeSocket {
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.onclose?.();
  }
  open() {
    this.onopen?.();
  }
  message(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}
function setup() {
  const sockets: Socket[] = [];
  const states: boolean[] = [];
  const gaps: string[] = [];
  const read: string[] = [];
  const received: unknown[] = [];
  const realtime = new Realtime({
    connect: () => {
      const s = new Socket();
      sockets.push(s);
      return s;
    },
    setTimeout: (callback, ms) => {
      const id = setTimeout(callback, ms);
      return () => clearTimeout(id);
    },
    unavailable: (value) => states.push(value),
    reload: (topic) => read.push(topic),
    gap: (topic) => gaps.push(topic),
    message: (m) => received.push(m),
  });
  return { realtime, sockets, states, gaps, read, received };
}
it.each([0, 1000, 2999])(
  "切断から%dミリ秒で停止して再開しても、次の切断を3秒後に通知する",
  (elapsed) => {
    vi.useFakeTimers();
    const s = setup();
    try {
      s.realtime.start();
      s.sockets[0]?.open();
      s.sockets[0]?.close();
      vi.advanceTimersByTime(elapsed);
      s.realtime.stop();
      s.realtime.start();
      s.sockets.at(-1)?.close();
      vi.advanceTimersByTime(2999);
      expect(s.states).toEqual([false]);
      vi.advanceTimersByTime(1);
      expect(s.states).toEqual([false, true]);
      s.sockets.at(-1)?.open();
      expect(s.states).toEqual([false, true, false]);
    } finally {
      s.realtime.stop();
      vi.useRealTimers();
    }
  },
);
it.each([0, 1000, 2999])(
  "切断から%dミリ秒で停止し再開後に回復すると、古い切断を通知しない",
  (elapsed) => {
    vi.useFakeTimers();
    const s = setup();
    try {
      s.realtime.start();
      s.sockets[0]?.open();
      s.sockets[0]?.close();
      vi.advanceTimersByTime(elapsed);
      s.realtime.stop();
      s.realtime.start();
      s.sockets.at(-1)?.close();
      vi.advanceTimersByTime(1000);
      s.sockets.at(-1)?.open();
      vi.advanceTimersByTime(3000);
      expect(s.states).toEqual([false, false]);
    } finally {
      s.realtime.stop();
      vi.useRealTimers();
    }
  },
);
it.each<ServerMessage>([
  { topic: "conversation:a", seq: 90, type: "delta", payload: { text: "draft" } },
  {
    topic: "conversation:a",
    seq: 90,
    type: "state",
    payload: { run_state: "working", stop_reason: null, resets_at: null },
  },
  { topic: "conversation:a", seq: 90, type: "changed", payload: { parts: ["queue", "answers"] } },
  {
    topic: "inbox",
    seq: 90,
    type: "changed",
    payload: { conversation_ids: ["a"], issue_ids: ["i"], project_ids: ["p"] },
  },
  {
    topic: "app",
    seq: 90,
    type: "notice",
    payload: {
      level: "error",
      message: "再開してください。",
      conversation_id: "a",
      issue_id: "i",
      notification: { tag: "n", url: "/a" },
    },
  },
  { topic: "app", seq: 90, type: "runner", payload: { connected: false } },
  { topic: "app", seq: 90, type: "settings_changed", payload: { keymap: "updated" } },
])("購読した$typeの全体を画面へ渡し、記録の再送位置を進めない: $topic", (message) => {
  vi.useFakeTimers();
  const s = setup();
  try {
    s.realtime.subscribe("conversation:a", 7);
    if (message.topic !== "conversation:a") s.realtime.subscribe(message.topic);
    s.realtime.start();
    s.sockets[0]?.open();
    s.sockets[0]?.message(message);
    expect(s.received).toEqual([message]);
    s.sockets[0]?.close();
    vi.advanceTimersByTime(500);
    s.sockets[1]?.open();
    expect(s.sockets[1]?.sent).toEqual([
      { op: "subscribe", topic: "conversation:a", after: 7 },
      ...(message.topic === "conversation:a" ? [] : [{ op: "subscribe", topic: message.topic }]),
      { op: "shown", topics: [] },
      { op: "visibility", visible: true },
    ]);
  } finally {
    s.realtime.stop();
    vi.useRealTimers();
  }
});
it("続きの番号と表示中の対象を再接続で送り直し、3秒切断したら通知する", () => {
  vi.useFakeTimers();
  try {
    const s = setup();
    s.realtime.subscribe("conversation:a");
    s.realtime.subscribe("inbox");
    s.realtime.shown(["conversation:a"]);
    s.realtime.visibility(false);
    s.realtime.start();
    s.sockets[0]?.open();
    s.sockets[0]?.message({
      topic: "conversation:a",
      seq: 1,
      type: "delta",
      payload: { text: "draft" },
    });
    s.sockets[0]?.message({
      topic: "conversation:a",
      seq: 1,
      type: "event",
      payload: {
        conversation_id: "a",
        seq: 1,
        type: "assistant_text",
        payload: { text: "one", parent_tool_use_id: null },
        sdk_uuid: null,
        created_at: 1,
      },
    });
    s.sockets[0]?.message({
      topic: "conversation:a",
      seq: 1,
      type: "state",
      payload: { run_state: "working", stop_reason: null, resets_at: null },
    });
    s.sockets[0]?.close();
    vi.advanceTimersByTime(499);
    expect(s.sockets.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(s.sockets.length).toBe(2);
    vi.advanceTimersByTime(2499);
    expect(s.states).toEqual([false]);
    vi.advanceTimersByTime(1);
    expect(s.states).toEqual([false, true]);
    s.sockets[1]?.open();
    expect(s.sockets[1]?.sent).toEqual([
      { op: "subscribe", topic: "conversation:a", after: 1 },
      { op: "subscribe", topic: "inbox" },
      { op: "shown", topics: ["conversation:a"] },
      { op: "visibility", visible: false },
    ]);
    expect(s.states).toEqual([false, true, false]);
    expect(s.read).toEqual(["conversation:a", "inbox", "conversation:a", "inbox"]);
    s.realtime.stop();
  } finally {
    vi.useRealTimers();
  }
});
it("イベントの欠番とresyncを読み直しへ渡し、重複を無視して45秒無通信なら再接続する", () => {
  vi.useFakeTimers();
  try {
    const s = setup();
    s.realtime.subscribe("conversation:a", 1);
    s.realtime.start();
    s.sockets[0]?.open();
    const event = {
      topic: "conversation:a",
      seq: 3,
      type: "event",
      payload: {
        conversation_id: "a",
        seq: 3,
        type: "assistant_text",
        payload: { text: "three", parent_tool_use_id: null },
        sdk_uuid: null,
        created_at: 3,
      },
    };
    s.sockets[0]?.message(event);
    s.sockets[0]?.message(event);
    expect(s.gaps).toEqual(["conversation:a"]);
    expect(s.received).toEqual([event]);
    s.sockets[0]?.message({
      topic: "conversation:a",
      seq: 1005,
      type: "resync",
      payload: { last_seq: 1005 },
    });
    expect(s.read).toEqual(["conversation:a", "conversation:a"]);
    vi.advanceTimersByTime(45000);
    vi.advanceTimersByTime(500);
    expect(s.sockets.length).toBe(2);
    s.realtime.stop();
  } finally {
    vi.useRealTimers();
  }
});
it.each([false, true])(
  "appの購読が%sでも20秒pingで接続を保ち、最後の受信から45秒で再接続する",
  (subscribed) => {
    vi.useFakeTimers();
    try {
      const s = setup();
      if (subscribed) s.realtime.subscribe("app");
      s.realtime.start();
      s.sockets[0]?.open();
      for (let seq = 1; seq <= 4; seq++) {
        vi.advanceTimersByTime(20000);
        s.sockets[0]?.message({ topic: "app", seq, type: "ping", payload: {} });
      }
      expect(s.sockets.length).toBe(1);
      expect(s.states).toEqual([false]);
      expect(s.received).toEqual([]);
      expect(s.read).toEqual(subscribed ? ["app"] : []);
      vi.advanceTimersByTime(44999);
      expect(s.sockets.length).toBe(1);
      vi.advanceTimersByTime(1);
      vi.advanceTimersByTime(500);
      expect(s.sockets.length).toBe(2);
      s.realtime.stop();
    } finally {
      vi.useRealTimers();
    }
  },
);
it("同じ会話を2か所が購読すると片方を閉じても残りへ配信し、両方閉じると解除する", () => {
  vi.useFakeTimers();
  try {
    const s = setup();
    const first = s.realtime.subscribe("conversation:a");
    const second = s.realtime.subscribe("conversation:a");
    s.realtime.start();
    s.sockets[0]?.open();
    first();
    const event = {
      topic: "conversation:a",
      seq: 1,
      type: "event",
      payload: {
        conversation_id: "a",
        seq: 1,
        type: "assistant_text",
        payload: { text: "one", parent_tool_use_id: null },
        sdk_uuid: null,
        created_at: 1,
      },
    };
    s.sockets[0]?.message(event);
    expect(s.received).toEqual([event]);
    second();
    s.sockets[0]?.message({ ...event, seq: 2, payload: { ...event.payload, seq: 2 } });
    expect(s.received).toEqual([event]);
    expect(s.sockets[0]?.sent).toEqual([
      { op: "subscribe", topic: "conversation:a", after: 0 },
      { op: "shown", topics: [] },
      { op: "visibility", visible: true },
      { op: "unsubscribe", topic: "conversation:a" },
    ]);
    s.realtime.stop();
  } finally {
    vi.useRealTimers();
  }
});
