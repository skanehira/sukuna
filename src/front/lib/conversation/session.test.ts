import { ChangeSet } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import type { ConversationMessage } from "../../../shared/conversation/api";
import type { BufferHandle } from "../../buffer/Buffer";
import { BufferController, type PromptSpec } from "../../buffer/controller";
import type { LineInfo } from "../../buffer/line";
import { Realtime, type RealtimeSocket } from "../realtime";
import { unlocatedConsultationNotice } from "../../../shared/progress/draft";
import { ConversationApiError } from "./api";
import { ConversationSession } from "./session";
import type { ConversationApi, DraftContent, DraftRequest, Event, Snapshot } from "./types";

const event = (seq: number): Event => ({
  seq,
  createdAt: seq,
  type: "assistant_text",
  payload: { text: `発言${seq}`, parent_tool_use_id: null },
});
function fixture(view: "conversation" | "stock-thread" = "conversation") {
  const data: Snapshot = {
    conversation: {
      id: "c1",
      projectId: "p1",
      projectName: "project",
      title: "会話",
      kind: "chat",
      issueId: null,
      parentConversationId: null,
      cwd: "/project",
      worktree: null,
      runState: "idle",
      stopReason: null,
      resetsAt: null,
      lastSeq: 1,
      lastReadSeq: 0,
      lastPosition: null,
      closedAt: null,
    },
    draft: null,
    queue: [],
    pendingAnswers: null,
    pendingPermission: null,
    commands: [],
  };
  const events = [event(1)];
  const afters: number[] = [];
  const api: ConversationApi = {
    get: async () => structuredClone(data),
    events: async (_id, after) => {
      afters.push(after);
      return {
        events: events.filter((event) => event.seq > after),
        lastSeq: data.conversation.lastSeq,
        hasMore: false,
      };
    },
    projects: async () => [],
    start: async () => ({ conversation: data.conversation }),
    send: async () => {
      data.draft = null;
      return { result: "delivered", queueItem: null };
    },
    saveDraft: async (_id, body) => {
      data.draft =
        body.text || body.images.length
          ? {
              text: body.text,
              images: body.images,
              updatedAt: body.editedAt,
              updatedBy: body.clientId,
            }
          : null;
      return { draft: data.draft, applied: true };
    },
    saveAnswers: async () => ({ pendingAnswers: null }),
    sendAnswers: async () => {},
    permission: async () => {},
    stop: async () => {},
    resume: async () => {},
    editQueue: async () => {},
    deleteQueue: async () => {},
    sendStock: async () => {},
    upload: async () => ({ image: { id: "img" } }),
  };
  let committed: LineInfo[] = [];
  let nextId = 0;
  const tail: Record<string, LineInfo[]> = {};
  const handle: BufferHandle = {
    append: (lines, clear = []) => {
      committed.push(...lines);
      clear.forEach((part) => {
        tail[part] = [];
      });
    },
    replace: (from, to, lines) => {
      committed.splice(from, to - from, ...lines);
    },
    replaceAll: (lines) => {
      committed = [...lines];
    },
    setTail: (part, lines) => {
      tail[part] = lines;
    },
    jumpTo: () => {},
    setDisplay: () => {},
    pushJump: () => {},
    findSeq: () => null,
  };
  const session = new ConversationSession(
    "c1",
    api,
    new BufferController(),
    { clientId: "tab", id: () => `message-${++nextId}`, now: () => 0, schedule: () => () => {} },
    { view },
  );
  session.bind(handle);
  return {
    data,
    events,
    afters,
    api,
    session,
    lines: () => [...committed, ...Object.values(tail).flat()],
    shown: () => [...committed, ...Object.values(tail).flat()].map((line) => line.text),
  };
}
class Socket implements RealtimeSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send() {}
  close() {}
  event(value: Event) {
    this.onmessage?.({
      data: JSON.stringify({
        topic: "conversation:c1",
        seq: value.seq,
        type: "event",
        payload: { ...value, conversation_id: "c1", created_at: value.createdAt, sdk_uuid: null },
      }),
    });
  }
}

it.each(["gap", "reconnect", "resync"])(
  "実RealtimeとSessionは%sで欠けたseqを読み直し、1,2,3の順に一度ずつ出す",
  async (path) => {
    const f = fixture();
    await f.session.load();
    const sockets: Socket[] = [];
    const loads: Promise<unknown>[] = [];
    const reload = () => {
      loads.push(f.session.load());
    };
    const realtime = new Realtime({
      connect: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket;
      },
      setTimeout: () => () => {},
      unavailable: () => {},
      reload,
      gap: reload,
      message: (message) => f.session.receive(message),
    });
    realtime.subscribe("conversation:c1", 1);
    realtime.start();
    sockets[0].onopen?.();
    await Promise.all(loads.splice(0));
    f.events.push(event(2), event(3));
    f.data.conversation.lastSeq = 3;
    if (path === "reconnect") {
      realtime.stop();
      realtime.start();
      sockets.at(-1)!.onopen?.();
    }
    if (path === "resync")
      sockets[0].onmessage?.({
        data: JSON.stringify({
          topic: "conversation:c1",
          seq: 3,
          type: "resync",
          payload: { last_seq: 3 },
        }),
      });
    sockets.at(-1)!.event(event(3));
    await Promise.all(loads);
    expect(f.afters.at(-1)).toBe(1);
    expect(f.shown()).toEqual(["AI", "発言1", "AI", "発言2", "AI", "発言3"]);
    sockets.at(-1)!.event(event(3));
    expect(f.shown()).toEqual(["AI", "発言1", "AI", "発言2", "AI", "発言3"]);
    realtime.stop();
  },
);

it("初回のページ取得中に後続seqが届いても、取得した前の記録を先に出す", async () => {
  const f = fixture();
  let pageReady = () => {};
  const started = new Promise<void>((resolve) => {
    pageReady = resolve;
  });
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.api.events = async (_id, after) => {
    if (after === 0) {
      pageReady();
      await pending;
      return { events: [event(1)], lastSeq: 3, hasMore: true };
    }
    return { events: [event(2), event(3)], lastSeq: 3, hasMore: false };
  };
  const loading = f.session.load();
  await started;
  f.session.receiveEvent(event(3));
  release();
  await loading;
  expect(f.shown()).toEqual(["AI", "発言1", "AI", "発言2", "AI", "発言3"]);
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("ファイルを読んでいる間に別タブで保存した指示を、相談の入力欄に残す", async () => {
  const f = fixture();
  await f.session.load();
  f.data.draft = { text: "別タブで残した指示", images: [], updatedAt: 10, updatedBy: "other" };

  await f.session.consultTimeline({ id: "csv", title: "注文 CSV" }, () => true);

  expect(f.session.controller.promptText()).toBe(
    "別タブで残した指示\n\nタイムラインのタスク csv「注文 CSV」について: ",
  );
});

it("相談のために下書きを取得している間に右を閉じたら、入力欄を開かない", async () => {
  const f = fixture();
  await f.session.load();
  const gate = deferred();
  const get = f.api.get;
  f.api.get = async (id) => {
    await gate.promise;
    return get(id);
  };
  let visible = true;
  const opening = f.session.consultTimeline({ id: "csv", title: "注文 CSV" }, () => visible);
  visible = false;
  gate.resolve();
  await opening;

  expect(f.session.controller.snapshot().prompt).toBeNull();
  expect(f.data.draft).toBeNull();
});

it.each(
  ["send", "interrupt", "queue-edit", "queue-only"].flatMap((mode) =>
    [false, true].flatMap((delayedGet) =>
      ["edited", "saved", "image-saved", "late-save"].map((change) => ({
        mode,
        delayedGet,
        change,
      })),
    ),
  ),
)(
  "$mode : 古いGET=$delayedGet / $change の未送信本文と画像、最新の会話状態を保つ",
  async ({ mode, delayedGet, change }) => {
    const f = fixture();
    f.data.draft = { text: "送る本文", images: ["img-one"], updatedAt: 10, updatedBy: "other" };
    f.data.queue = [
      {
        id: "q1",
        text: "送る本文",
        images: ["img-one"],
        position: 1,
        stockItemId: null,
        clientId: null,
        createdAt: 0,
      },
    ];
    const controller = f.session.controller;
    controller.registerWindow("main", {
      focus() {},
      lines: () => [{ kind: "queued", text: "送る本文", id: "queue:q1" }],
      position: () => ({ line: 0, column: 0, topLine: 0 }),
      place() {},
      view: "conversation",
      name: "会話",
      posKey: "c1",
      url: "/conversations/c1",
      scrollCursor() {},
    });
    const oldGet = deferred();
    const sent = deferred();
    const saved = deferred();
    let gets = 0;
    f.api.get = async () => {
      const data = structuredClone(f.data);
      if (++gets === 2 && delayedGet) await oldGet.promise;
      return data;
    };
    const sends: Parameters<ConversationApi["send"]>[1][] = [];
    const edits: Parameters<ConversationApi["editQueue"]>[2][] = [];
    f.api.send = async (_id, body) => {
      sends.push(body);
      if (body.text || body.images.length) f.data.draft = null;
      await sent.promise;
      f.data.conversation.runState = "working";
      f.data.queue = [];
      return { result: "delivered", queueItem: null };
    };
    f.api.editQueue = async (_id, _queueId, body) => {
      edits.push(body);
      await sent.promise;
      f.data.conversation.runState = "working";
      f.data.queue = [];
    };
    const save = f.api.saveDraft;
    let saves = 0;
    f.api.saveDraft = async (id, body) => {
      const result = await save(id, body);
      if (++saves === 1 && change === "late-save") await saved.promise;
      return result;
    };
    await f.session.load();
    const disconnect = f.session.connect();
    if (mode === "queue-edit") await controller.run("item.edit");
    else if (mode !== "queue-only") controller.openPrompt(controller.options.prompt!()!);
    const sending =
      mode === "queue-only"
        ? controller.run("conversation.queue.send")
        : controller.submitPrompt(controller.promptText(), mode === "interrupt");
    const refreshing = delayedGet ? f.session.refresh() : Promise.resolve();
    if (mode === "queue-only") controller.openPrompt(controller.options.prompt!()!);
    const text = change === "image-saved" ? "送る本文" : "送る本文に追記";
    if (change !== "image-saved") {
      controller.setPromptDraft(text);
      controller.snapshot().prompt!.change!(text);
    }
    controller.snapshot().prompt!.paste!([new File(["image"], "image.png", { type: "image/png" })]);
    await Promise.resolve();
    await Promise.resolve();
    const saving = change === "edited" ? Promise.resolve() : f.session.saveDraft();
    if (change !== "late-save") await saving;
    sent.resolve();
    await sending;
    await Promise.resolve();
    await Promise.resolve();
    oldGet.resolve();
    await refreshing;
    saved.resolve();
    await saving;
    expect({ text: controller.promptText(), images: controller.snapshot().prompt?.images }).toEqual(
      { text, images: 2 },
    );
    expect(f.session.snapshot().data).toEqual(f.data);
    await f.session.saveDraft();
    expect(f.data.draft).toEqual(
      mode === "queue-edit"
        ? { text: "送る本文", images: ["img-one"], updatedAt: 10, updatedBy: "other" }
        : {
            text,
            images: ["img-one", "img"],
            updatedAt: 10 + (change === "image-saved" ? 1 : 2),
            updatedBy: "tab",
          },
    );
    expect(sends).toEqual(
      mode === "queue-edit"
        ? []
        : [
            {
              text: mode === "queue-only" ? "" : "送る本文",
              images: mode === "queue-only" ? [] : ["img-one"],
              mode: mode === "interrupt" ? "interrupt" : "send",
              clientMessageId: "message-1",
            },
          ],
    );
    expect(edits).toEqual([]);
    disconnect();
  },
);

it.each(["refresh", "load"] as const)(
  "%s中の保存完了後は、古い空の下書きだけを除き会話とキューを更新する",
  async (read) => {
    const f = fixture();
    await f.session.load();
    const disconnect = f.session.connect();
    const controller = f.session.controller;
    controller.openPrompt(controller.options.prompt!()!);
    controller.setPromptDraft("保存する本文");
    controller.snapshot().prompt!.change!("保存する本文");
    const gate = deferred();
    const incoming = structuredClone(f.data);
    incoming.conversation.runState = "working";
    incoming.queue = [
      {
        id: "q2",
        text: "別タブの指示",
        images: [],
        position: 1,
        stockItemId: null,
        clientId: null,
        createdAt: 0,
      },
    ];
    f.api.get = async () => {
      await gate.promise;
      return incoming;
    };
    const reading = f.session[read]();
    await f.session.saveDraft();
    gate.resolve();
    await reading;
    expect(controller.promptText()).toBe("保存する本文");
    expect(f.session.snapshot().data).toEqual(incoming);
    disconnect();
  },
);

it("同時に始めたGETが順に届くときは、後の別タブ更新も入力欄へ反映する", async () => {
  const f = fixture();
  await f.session.load();
  const disconnect = f.session.connect();
  const controller = f.session.controller;
  controller.openPrompt(controller.options.prompt!()!);
  const first = deferred();
  const second = deferred();
  const changes = [first, second].map((gate, index) => ({
    gate,
    data: {
      ...structuredClone(f.data),
      draft: {
        text: `別タブの本文${index + 1}`,
        images: [`img${index + 1}`],
        updatedAt: (index + 1) * 10,
        updatedBy: "other",
      },
    },
  }));
  let next = 0;
  f.api.get = async () => {
    const { gate, data } = changes[next++];
    await gate.promise;
    return data;
  };
  const readingFirst = f.session.refresh();
  const readingSecond = f.session.refresh();
  first.resolve();
  await readingFirst;
  expect(controller.promptText()).toBe("別タブの本文1");
  second.resolve();
  await readingSecond;
  expect({ text: controller.promptText(), images: controller.snapshot().prompt?.images }).toEqual({
    text: "別タブの本文2",
    images: 1,
  });
  disconnect();
});

it("新しいGETが先に完了した後に届く古い下書き・会話・キューを適用しない", async () => {
  const f = fixture();
  f.data.draft = { text: "最初の本文", images: [], updatedAt: 10, updatedBy: "other" };
  await f.session.load();
  const disconnect = f.session.connect();
  const controller = f.session.controller;
  controller.openPrompt(controller.options.prompt!()!);
  const old = structuredClone(f.data);
  old.draft = null;
  const gate = deferred();
  f.api.get = async () => {
    await gate.promise;
    return old;
  };
  const reading = f.session.refresh();
  f.data.draft = { text: "別タブの新版", images: ["new-img"], updatedAt: 20, updatedBy: "other" };
  f.data.conversation.runState = "working";
  f.data.queue = [
    {
      id: "q2",
      text: "別タブの指示",
      images: [],
      position: 1,
      stockItemId: null,
      clientId: null,
      createdAt: 0,
    },
  ];
  f.api.get = async () => structuredClone(f.data);
  await f.session.refresh();
  gate.resolve();
  await reading;
  expect({ text: controller.promptText(), images: controller.snapshot().prompt?.images }).toEqual({
    text: "別タブの新版",
    images: 1,
  });
  expect(f.session.snapshot().data).toEqual(f.data);
  f.data.draft = null;
  await f.session.refresh();
  expect({ text: controller.promptText(), images: controller.snapshot().prompt?.images }).toEqual({
    text: "",
    images: 0,
  });
  expect(controller.snapshot().notice?.message).toBe("別の端末で書いた内容に置き換わりました");
  disconnect();
});

it("送信待ちに本文を消して保存し、新しく開いた入力も旧送信の完了で消さない", async () => {
  const f = fixture();
  await f.session.load();
  const disconnect = f.session.connect();
  let finish = () => {};
  f.api.send = async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { result: "delivered", queueItem: null };
  };
  const saved: DraftRequest[] = [];
  f.api.saveDraft = async (_id, body) => {
    saved.push(body);
    f.data.draft =
      body.text || body.images.length
        ? {
            text: body.text,
            images: body.images,
            updatedAt: body.editedAt,
            updatedBy: body.clientId,
          }
        : null;
    return { draft: f.data.draft, applied: true };
  };
  const controller = f.session.controller;
  const open = (text: string) => {
    controller.openPrompt(controller.options.prompt!()!);
    controller.setPromptDraft(text);
    controller.snapshot().prompt!.change!(text);
  };
  open("送る本文");
  const sending = controller.submitPrompt("送る本文");
  controller.setPromptDraft("");
  controller.snapshot().prompt!.change!("");
  await f.session.saveDraft();
  controller.closePrompt();
  await Promise.resolve();
  open("新しい本文");
  finish();
  await sending;
  await f.session.saveDraft();
  expect(saved.map(({ text, images }) => ({ text, images }))).toEqual([
    { text: "", images: [] },
    { text: "新しい本文", images: [] },
  ]);
  expect({ prompt: controller.snapshot().prompt?.label, text: controller.promptText() }).toEqual({
    prompt: "指示",
    text: "新しい本文",
  });
  disconnect();
});

it("送信前の保存結果が遅れて返っても、次の入力を保存できる", async () => {
  const f = fixture();
  await f.session.load();
  const disconnect = f.session.connect();
  const controller = f.session.controller;
  const saved: DraftRequest[] = [];
  let finish = () => {};
  f.api.saveDraft = async (_id, body) => {
    saved.push(body);
    if (saved.length === 1)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return {
      draft: {
        text: body.text,
        images: body.images,
        updatedAt: body.editedAt,
        updatedBy: body.clientId,
      },
      applied: true,
    };
  };
  const open = (text: string) => {
    controller.openPrompt(controller.options.prompt!()!);
    controller.setPromptDraft(text);
    controller.snapshot().prompt!.change!(text);
  };
  open("送る本文");
  const saving = f.session.saveDraft();
  await controller.submitPrompt("送る本文");
  finish();
  await saving;
  open("次の本文");
  await f.session.saveDraft();
  expect(saved).toEqual([
    { text: "送る本文", images: [], clientId: "tab", editedAt: 1 },
    { text: "次の本文", images: [], clientId: "tab", editedAt: 1 },
  ]);
  disconnect();
});

it.each(
  ["send", "interrupt"].flatMap((mode) =>
    [false, true].map((delayedGet) => ({ mode, delayedGet })),
  ),
)(
  "$mode / 古いGET=$delayedGet : 失敗後は同じIDで再送し、送った版は復活せず次の指示に新しいIDを使う",
  async ({ mode, delayedGet }) => {
    const f = fixture();
    f.data.draft = { text: "送る本文", images: ["img"], updatedAt: 10, updatedBy: "other" };
    await f.session.load();
    const disconnect = f.session.connect();
    const controller = f.session.controller;
    const ids: string[] = [];
    f.api.send = async (_id, body) => {
      ids.push(body.clientMessageId);
      if (ids.length === 1) throw new Error("一時的な失敗");
      f.data.draft = null;
      return { result: "delivered", queueItem: null };
    };
    controller.openPrompt(controller.options.prompt!()!);
    const old = structuredClone(f.data);
    const gate = deferred();
    f.api.get = async () => {
      await gate.promise;
      return old;
    };
    const reading = delayedGet ? f.session.refresh() : Promise.resolve();
    expect(await controller.submitPrompt("送る本文", mode === "interrupt")).toBe(false);
    f.api.get = async () => structuredClone(f.data);
    expect(await controller.submitPrompt("送る本文", mode === "interrupt")).toBe(true);
    await Promise.resolve();
    gate.resolve();
    await reading;
    controller.openPrompt(controller.options.prompt!()!);
    expect({ text: controller.promptText(), images: controller.snapshot().prompt?.images }).toEqual(
      { text: "", images: 0 },
    );
    controller.setPromptDraft("次の本文");
    controller.snapshot().prompt!.change!("次の本文");
    await controller.submitPrompt("次の本文");
    expect(ids).toEqual(["message-1", "message-1", "message-2"]);
    disconnect();
  },
);

it("旧欄の送信成功が、新しい欄で失敗した送信の再送IDを消さない", async () => {
  const f = fixture();
  await f.session.load();
  const disconnect = f.session.connect();
  const controller = f.session.controller;
  let finish = () => {};
  const ids: string[] = [];
  f.api.send = async (_id, body) => {
    ids.push(body.clientMessageId);
    if (ids.length === 1)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    else if (ids.length === 2) throw new Error("一時的な失敗");
    return { result: "delivered", queueItem: null };
  };
  const open = (text: string) => {
    controller.openPrompt(controller.options.prompt!()!);
    controller.setPromptDraft(text);
    controller.snapshot().prompt!.change!(text);
  };
  open("最初の本文");
  const old = controller.submitPrompt("最初の本文");
  controller.closePrompt();
  await Promise.resolve();
  open("新しい本文");
  expect(await controller.submitPrompt("新しい本文")).toBe(false);
  finish();
  await old;
  expect(await controller.submitPrompt("新しい本文")).toBe(true);
  expect(ids).toEqual(["message-1", "message-2", "message-2"]);
  disconnect();
});

it("欠番回復後もツールの行先、質問の回答と展開済みの差分を保つ", async () => {
  const f = fixture();
  f.events.splice(0, 1, {
    seq: 1,
    createdAt: 1,
    type: "tool_use",
    payload: {
      tool_use_id: "tool",
      name: "mcp__sukuna__issue_create",
      input: {},
      parent_tool_use_id: null,
    },
  });
  await f.session.load();
  const result: Event = {
    seq: 2,
    createdAt: 2,
    type: "tool_result",
    payload: {
      tool_use_id: "tool",
      content: '{"issue":{"number":42}}',
      is_error: false,
      truncated: false,
      bytes: 23,
    },
  };
  const question: Event = {
    seq: 3,
    createdAt: 3,
    type: "question",
    payload: {
      request_id: "q",
      questions: [
        {
          question: "続ける?",
          header: "続行",
          multi_select: false,
          options: [{ label: "はい", description: "続ける" }],
        },
      ],
    },
  };
  const diff: Event = {
    seq: 4,
    createdAt: 4,
    type: "diff",
    payload: {
      tool_use_id: "tool",
      change: "create",
      path: "new.ts",
      hunks: [],
      content: Array.from({ length: 26 }, (_, index) => `line${index + 1}`).join("\n"),
      truncated: false,
    },
  };
  f.events.push(result, question, diff);
  f.session.receiveEvent(diff);
  await f.session.load();
  await f.session.controller.run("conversation.diff.4", {
    view: "conversation",
    window: "main",
    line: 0,
  });
  const answer: Event = {
    seq: 5,
    createdAt: 5,
    type: "answer",
    payload: {
      request_id: "q",
      as_message: false,
      answers: { "0": { choices: ["はい"], text: null } },
    },
  };
  f.events.push(answer, event(6));
  f.session.receiveEvent(event(6));
  await f.session.load();
  expect(f.lines().filter((line) => line.target)).toEqual([
    { kind: "tool", text: "● issue_create()", seq: 1, seqLine: 0, target: { url: "/issues/42" } },
  ]);
  expect(f.shown()).toEqual([
    "● issue_create()",
    '  ⎿  {"issue":{"number":42}}',
    ...Array.from({ length: 26 }, (_, index) => `${index + 1} +line${index + 1}`),
    "Q1. 続ける?",
    "はい  ✓ 送った回答",
    "あなた",
    "Q1: はい",
    "AI",
    "発言6",
  ]);
});

async function answeringFixture(
  questions: Extract<Event, { type: "question" }>["payload"]["questions"] = [
    { question: "どちらですか", header: "確認", options: [], multi_select: false },
  ],
  view: "conversation" | "stock-thread" = "conversation",
) {
  const f = fixture(view);
  f.data.conversation.lastSeq = 2;
  f.data.conversation.runState = "waiting_answer";
  f.events.push({
    seq: 2,
    createdAt: 2,
    type: "question",
    payload: {
      request_id: "q",
      questions,
    },
  });
  await f.session.load();
  const close = f.session.connect();
  const controller = f.session.controller;
  const window = view === "conversation" ? "main" : "right";
  const unregister = controller.registerWindow(window, {
    focus() {},
    lines: f.lines,
    position: () => ({ line: 0, column: 0, topLine: 0 }),
    place() {},
    view,
    name: "会話",
    posKey: "c1",
    url: "/conversations/c1",
    scrollCursor() {},
  });
  controller.focus(window);
  const disconnect = () => {
    close();
    unregister();
  };
  const context = { view, window, line: 0 };
  const openAnswer = () => controller.run("conversation.answer.0", context);
  return { f, controller, disconnect, openAnswer, context };
}

it("別の指示を受け付けても回答を残し、ツール実行が届いたら過去の質問として表示する", async () => {
  const { f, disconnect } = await answeringFixture();
  const instruction: Event = {
    seq: 3,
    createdAt: 3,
    type: "user_message",
    payload: { text: "別の指示", images: [], origin: "developer", client_ids: [], queued_ids: [] },
  };
  const tool: Event = {
    seq: 4,
    createdAt: 4,
    type: "tool_use",
    payload: {
      tool_use_id: "read",
      name: "Read",
      input: { file_path: "notes.txt" },
      parent_tool_use_id: null,
    },
  };
  f.data.pendingAnswers = { questionSeq: 2, answers: { "0": { choices: [], text: "こちらです" } } };
  await f.session.refresh();

  try {
    f.session.receiveEvent(instruction);
    expect(f.shown()).toEqual([
      "AI",
      "発言1",
      "あなた",
      "別の指示",
      "Q1. どちらですか",
      "Q1 に文章で答える",
      "→ あなたの回答 (まだ送っていない): こちらです",
      "回答をまとめて送る (1 / 1 件)  1 通にまとめて AI に届く",
    ]);
    f.session.receiveEvent(tool);
    expect(f.shown()).toEqual([
      "AI",
      "発言1",
      "Q1. どちらですか",
      "あなた",
      "別の指示",
      "● Read(notes.txt)",
    ]);
  } finally {
    disconnect();
  }
});

it("質問が差し替わったときは前の入力欄から保存せず、新しく開いた入力欄からだけ回答を保存する", async () => {
  const { f, controller, disconnect, openAnswer } = await answeringFixture();
  const saves: NonNullable<Snapshot["pendingAnswers"]>[] = [];
  f.api.saveAnswers = async (_id, questionSeq, answers) => {
    const pendingAnswers = { questionSeq, answers };
    saves.push(pendingAnswers);
    return { pendingAnswers };
  };

  try {
    await openAnswer();
    controller.setPromptDraft("最初の質問への答え");
    f.session.receiveEvent({
      seq: 3,
      createdAt: 3,
      type: "user_message",
      payload: {
        text: "別の指示",
        images: [],
        origin: "developer",
        client_ids: [],
        queued_ids: [],
      },
    });
    f.session.receiveEvent({
      seq: 4,
      createdAt: 4,
      type: "question",
      payload: {
        request_id: "new-question",
        questions: [
          { question: "新しい質問です", header: "新しい確認", options: [], multi_select: false },
        ],
      },
    });

    const oldSubmission = await controller.submitPrompt(controller.promptText());
    controller.closePrompt();
    await openAnswer();
    controller.setPromptDraft("新しい質問への答え");
    await controller.submitPrompt(controller.promptText());
    expect(saves).toEqual([
      { questionSeq: 4, answers: { "0": { choices: [], text: "新しい質問への答え" } } },
    ]);
    expect(oldSubmission).toBe(false);
  } finally {
    disconnect();
  }
});

const firstQuestion = {
  question: "最初の質問",
  header: "最初の確認",
  options: [
    { label: "方式A", description: "方式Aを使う" },
    { label: "方式B", description: "方式Bを使う" },
  ],
  multi_select: false,
};
const anotherQuestion = { ...firstQuestion, question: "新しい質問", header: "新しい確認" };
const answerContext = { view: "conversation", window: "main", line: 0 };
const nextInstruction: Event = {
  seq: 3,
  createdAt: 3,
  type: "user_message",
  payload: { text: "別の指示", images: [], origin: "developer", client_ids: [], queued_ids: [] },
};
const confirmYes = { key: "y", isComposing: false, ctrlKey: false, altKey: false, metaKey: false };

it("前の質問の送信確認で y を押しても、別端末の新しい回答を送らない", async () => {
  const { f, controller, disconnect } = await answeringFixture([firstQuestion, anotherQuestion]);
  const sends: unknown[][] = [];
  f.api.sendAnswers = async (...args) => {
    sends.push(args);
  };
  f.data.pendingAnswers = { questionSeq: 2, answers: { "0": { choices: ["方式A"], text: null } } };
  await f.session.refresh();

  try {
    await controller.run("conversation.answers.send", answerContext);
    expect(controller.snapshot().confirmation?.text).toBe(
      "答えていない質問が 1 件あります。このまま送りますか?",
    );
    f.session.receiveEvent(nextInstruction);
    f.session.receiveEvent({
      seq: 4,
      createdAt: 4,
      type: "question",
      payload: { request_id: "new-q", questions: [anotherQuestion] },
    });
    f.data.pendingAnswers = {
      questionSeq: 4,
      answers: { "0": { choices: ["方式B"], text: null } },
    };
    await f.session.refresh();

    controller.answer(confirmYes);
    await controller.run("conversation.answers.send", answerContext);
    expect(sends).toEqual([["c1", { confirmUnanswered: false, questionSeq: 4 }]]);
  } finally {
    disconnect();
  }
});

it("前の送信確認を n で閉じたあと、割り当て済みの操作で新しい質問に回答する", async () => {
  const { f, controller, disconnect } = await answeringFixture([firstQuestion, anotherQuestion]);
  const sends: unknown[][] = [];
  f.api.sendAnswers = async (...args) => {
    sends.push(args);
  };
  f.data.pendingAnswers = { questionSeq: 2, answers: { "0": { choices: ["方式A"], text: null } } };
  await f.session.refresh();

  try {
    await controller.run("conversation.answers.send", answerContext);
    expect(controller.answer({ ...confirmYes, key: "n" })).toBe(true);
    f.session.receiveEvent(nextInstruction);
    f.session.receiveEvent({
      seq: 4,
      createdAt: 4,
      type: "question",
      payload: { request_id: "new-q", questions: [anotherQuestion] },
    });
    f.data.pendingAnswers = {
      questionSeq: 4,
      answers: { "0": { choices: ["方式B"], text: null } },
    };
    await f.session.refresh();
    await controller.run("conversation.answers.confirm", answerContext);
    expect({ sends, confirmation: controller.snapshot().confirmation }).toEqual({
      sends: [["c1", { confirmUnanswered: false, questionSeq: 4 }]],
      confirmation: null,
    });
  } finally {
    disconnect();
  }
});

it("右のスレッドは未回答の確認を表示し、y を押してからその質問へ送る", async () => {
  const { f, controller, disconnect, context } = await answeringFixture(
    [firstQuestion, anotherQuestion],
    "stock-thread",
  );
  const sends: unknown[][] = [];
  f.api.sendAnswers = async (...args) => {
    sends.push(args);
  };
  f.data.pendingAnswers = { questionSeq: 2, answers: { "0": { choices: ["方式A"], text: null } } };
  await f.session.refresh();

  try {
    await controller.run("conversation.answers.send", context);
    expect({ sends, confirmation: controller.snapshot().confirmation?.context }).toEqual({
      sends: [],
      confirmation: context,
    });
    expect(controller.answer(confirmYes)).toBe(true);
    expect(sends).toEqual([
      [
        "c1",
        {
          confirmUnanswered: true,
          questionSeq: 2,
          confirmedAnswers: f.data.pendingAnswers?.answers,
        },
      ],
    ]);
  } finally {
    disconnect();
  }
});

it("右のスレッドで確認中に回答を受信しても、y は確認を開いた時点の内容にだけ同意する", async () => {
  const { f, controller, disconnect, context } = await answeringFixture(
    [firstQuestion, anotherQuestion, firstQuestion],
    "stock-thread",
  );
  const first = {
    questionSeq: 2,
    answers: { "0": { choices: ["方式A"], text: null }, "1": { choices: ["方式B"], text: null } },
  };
  const latest = { questionSeq: 2, answers: { "0": { choices: ["方式B"], text: null } } };
  f.data.pendingAnswers = first;
  await f.session.refresh();

  const sends: Parameters<ConversationApi["sendAnswers"]>[] = [];
  const rejected = deferred();
  f.api.sendAnswers = async (...args) => {
    sends.push(args);
    if (sends.length !== 1) return;
    await rejected.promise;
    throw new ConversationApiError(
      409,
      "answers_changed",
      "回答が変わりました。内容を確認してからもう一度送ってください。",
    );
  };

  try {
    await controller.run("conversation.answers.send", context);
    expect(controller.snapshot().confirmation?.text).toBe(
      "答えていない質問が 1 件あります。このまま送りますか?",
    );
    f.data.pendingAnswers = latest;
    await f.session.refresh();
    expect(controller.answer(confirmYes)).toBe(true);
    expect(sends).toEqual([
      ["c1", { questionSeq: 2, confirmUnanswered: true, confirmedAnswers: first.answers }],
    ]);

    rejected.resolve();
    await expect
      .poll(() => controller.snapshot().notice)
      .toEqual({
        kind: "error",
        message: "回答が変わりました。内容を確認してからもう一度送ってください。",
      });
    await controller.run("conversation.answers.send", context);
    expect(controller.snapshot().confirmation?.text).toBe(
      "答えていない質問が 2 件あります。このまま送りますか?",
    );
    expect(controller.answer(confirmYes)).toBe(true);
    expect(sends[1]).toEqual([
      "c1",
      { questionSeq: 2, confirmUnanswered: true, confirmedAnswers: latest.answers },
    ]);
  } finally {
    rejected.resolve();
    disconnect();
  }
});

it.each([false, true])(
  "質問の画面を閉じるとき別操作の確認の有無 %s に応じて自分の確認だけ取り消す",
  async (otherConfirmation) => {
    const { f, controller, disconnect, context } = await answeringFixture(
      [firstQuestion, anotherQuestion],
      "stock-thread",
    );
    const sends: unknown[][] = [];
    f.api.sendAnswers = async (...args) => {
      sends.push(args);
    };
    f.data.pendingAnswers = {
      questionSeq: 2,
      answers: { "0": { choices: ["方式A"], text: null } },
    };
    await f.session.refresh();

    await controller.run("conversation.answers.send", context);
    expect(controller.snapshot().confirmation?.text).toBe(
      "答えていない質問が 1 件あります。このまま送りますか?",
    );
    let confirmed = false;
    if (otherConfirmation)
      controller.confirm("別の操作を続けますか?", answerContext, () => {
        confirmed = true;
      });
    disconnect();
    expect(controller.answer(confirmYes)).toBe(otherConfirmation);
    expect({ confirmed, sends }).toEqual({ confirmed: otherConfirmation, sends: [] });
  },
);

it.each([false, true])(
  "右のスレッドで開き直し=%s のとき、遅い未回答エラーの後も別操作の確認と正しい回答の送り直しを保つ",
  async (reopen) => {
    const { f, controller, disconnect, context } = await answeringFixture(
      [firstQuestion, anotherQuestion],
      "stock-thread",
    );
    const allAnswered = {
      questionSeq: 2,
      answers: { "0": { choices: ["方式A"], text: null }, "1": { choices: ["方式B"], text: null } },
    };
    const partial = { questionSeq: 2, answers: { "0": { choices: ["方式A"], text: null } } };
    f.data.pendingAnswers = allAnswered;
    await f.session.refresh();
    const arrived = deferred();
    const fail = deferred();
    const sends: Parameters<ConversationApi["sendAnswers"]>[] = [];
    f.api.sendAnswers = async (...args) => {
      sends.push(args);
      if (sends.length !== 1) return;
      arrived.resolve();
      await fail.promise;
      throw new ConversationApiError(
        409,
        "unanswered_questions",
        "答えていない質問があります。確認してから送ってください。",
      );
    };

    const original = controller.run("conversation.answers.send", context);
    await arrived.promise;
    f.data.pendingAnswers = partial;
    let close = disconnect;
    if (reopen) {
      disconnect();
      close = f.session.connect();
      await f.session.refresh();
    }
    let otherAccepted = 0;
    let gets = 0;
    const get = f.api.get;
    f.api.get = async (id) => {
      gets++;
      return get(id);
    };

    try {
      controller.confirm("本体の操作を続けますか?", answerContext, () => {
        otherAccepted++;
      });
      fail.resolve();
      await original;

      expect({
        confirmation: controller.snapshot().confirmation?.text,
        pendingAnswers: f.session.snapshot().data?.pendingAnswers,
        gets,
      }).toEqual({
        confirmation: "本体の操作を続けますか?",
        pendingAnswers: partial,
        gets: reopen ? 0 : 1,
      });
      if (!reopen)
        expect(controller.snapshot().notice).toEqual({
          kind: "error",
          message: "回答が変わりました。内容を確認してからもう一度送ってください。",
        });
      expect(controller.answer(confirmYes)).toBe(true);
      expect({ otherAccepted, sends }).toEqual({
        otherAccepted: 1,
        sends: [["c1", { confirmUnanswered: false, questionSeq: 2 }]],
      });

      await controller.run("conversation.answers.send", context);
      expect(controller.snapshot().confirmation?.text).toBe(
        "答えていない質問が 1 件あります。このまま送りますか?",
      );
      expect(controller.answer(confirmYes)).toBe(true);
      expect(sends).toEqual([
        ["c1", { confirmUnanswered: false, questionSeq: 2 }],
        [
          "c1",
          {
            confirmUnanswered: true,
            questionSeq: 2,
            confirmedAnswers: f.data.pendingAnswers?.answers,
          },
        ],
      ]);
    } finally {
      fail.resolve();
      close();
    }
  },
);

it.each([
  { name: "右スレッドを閉じた後は別画面の完了通知を保つ", leave: true },
  { name: "右スレッドを表示中なら再読込の失敗を通知する", leave: false },
])("回答の再読込に失敗したとき、$name", async ({ leave }) => {
  const { f, controller, disconnect, context } = await answeringFixture(
    [firstQuestion],
    "stock-thread",
  );
  f.data.pendingAnswers = { questionSeq: 2, answers: { "0": { choices: ["方式A"], text: null } } };
  await f.session.refresh();
  f.api.sendAnswers = async () => {
    throw new ConversationApiError(
      409,
      "unanswered_questions",
      "答えていない質問があります。確認してから送ってください。",
    );
  };

  const getStarted = deferred();
  const failRead = deferred();
  f.api.get = async () => {
    getStarted.resolve();
    await failRead.promise;
    throw new Error("会話の読み込みに失敗しました");
  };

  const submit = controller.run("conversation.answers.send", context);
  await getStarted.promise;
  if (leave) {
    disconnect();
    controller.notify("別の画面の操作が完了しました");
  }
  try {
    failRead.resolve();
    await submit;
    expect(controller.snapshot().notice).toEqual(
      leave
        ? { kind: "info", message: "別の画面の操作が完了しました" }
        : { kind: "error", message: "会話の読み込みに失敗しました" },
    );
  } finally {
    if (!leave) disconnect();
  }
});

it("次の番が出力なしで終わった場合、前の質問の送信確認で回答を送れる", async () => {
  const { f, controller, disconnect } = await answeringFixture([firstQuestion, anotherQuestion]);
  const sends: unknown[][] = [];
  f.api.sendAnswers = async (...args) => {
    sends.push(args);
  };
  f.data.pendingAnswers = { questionSeq: 2, answers: { "0": { choices: ["方式A"], text: null } } };
  await f.session.refresh();

  try {
    await controller.run("conversation.answers.send", answerContext);
    f.session.receiveEvent(nextInstruction);
    f.session.receiveEvent({
      seq: 4,
      createdAt: 4,
      type: "turn_end",
      payload: {
        subtype: "success",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        cost_usd: 0,
        duration_ms: 0,
        permission_denials: 0,
      },
    });
    expect(controller.answer(confirmYes)).toBe(true);
    expect(sends).toEqual([
      [
        "c1",
        {
          confirmUnanswered: true,
          questionSeq: 2,
          confirmedAnswers: f.data.pendingAnswers?.answers,
        },
      ],
    ]);
  } finally {
    disconnect();
  }
});

it("履歴では未送信のまま片づけた選択肢を表示だけにし、送信した回答には送信済みの操作を出す", async () => {
  const { f, disconnect } = await answeringFixture([firstQuestion]);
  f.data.pendingAnswers = { questionSeq: 2, answers: { "0": { choices: ["方式A"], text: null } } };
  await f.session.refresh();

  try {
    f.session.receiveEvent(nextInstruction);
    f.session.receiveEvent({
      seq: 4,
      createdAt: 4,
      type: "question",
      payload: { request_id: "new-q", questions: [anotherQuestion] },
    });
    f.session.receiveEvent({
      seq: 5,
      createdAt: 5,
      type: "answer",
      payload: {
        request_id: "new-q",
        as_message: false,
        answers: { "0": { choices: ["方式B"], text: "続けてください" } },
      },
    });
    expect(
      f
        .lines()
        .filter((line) => line.seq === 2 || line.seq === 4)
        .map(({ kind, text, action }) => ({ kind, text, action })),
    ).toEqual([
      { kind: "ask", text: "Q1. 最初の質問", action: undefined },
      { kind: "text", text: "方式A", action: undefined },
      { kind: "text", text: "方式B", action: undefined },
      { kind: "ask", text: "Q1. 新しい質問", action: undefined },
      { kind: "menu", text: "方式A  この選択肢を選ぶ", action: "conversation.answered" },
      { kind: "menu", text: "方式B  ✓ 送った回答", action: "conversation.answered" },
      { kind: "text", text: "→ あなたの回答: 続けてください", action: undefined },
    ]);
  } finally {
    disconnect();
  }
});

it("別の端末から届いた指示の下書きは回答欄に反映せず、次の指示入力で使う", async () => {
  const { f, controller, disconnect, openAnswer } = await answeringFixture();
  const answers: unknown[] = [];
  f.api.saveAnswers = async (_id, seq, value) => {
    answers.push({ seq, value });
    return { pendingAnswers: null };
  };
  try {
    await openAnswer();
    controller.setPromptDraft("この質問への答え");
    f.data.draft = {
      text: "別端末の指示",
      images: ["other-image"],
      updatedAt: 10,
      updatedBy: "other",
    };
    await f.session.refresh();
    expect({ text: controller.promptText(), images: controller.snapshot().prompt?.images }).toEqual(
      {
        text: "この質問への答え",
        images: undefined,
      },
    );
    await controller.submitPrompt(controller.promptText());
    expect(answers).toEqual([
      { seq: 2, value: { "0": { choices: [], text: "この質問への答え" } } },
    ]);
    controller.openPrompt(controller.options.prompt!()!);
    expect({ text: controller.promptText(), images: controller.snapshot().prompt?.images }).toEqual(
      {
        text: "別端末の指示",
        images: 1,
      },
    );
  } finally {
    disconnect();
  }
});

it("指示の保存応答が遅れて他端末の下書きを返しても、後から開いた回答欄を変更しない", async () => {
  const { f, controller, disconnect, openAnswer } = await answeringFixture();
  const gate = deferred();
  try {
    f.api.saveDraft = async () => {
      await gate.promise;
      return {
        draft: { text: "別端末の指示", images: [], updatedAt: 10, updatedBy: "other" },
        applied: false,
      };
    };
    controller.openPrompt(controller.options.prompt!()!);
    controller.setPromptDraft("保存を待つ指示");
    controller.snapshot().prompt!.change!("保存を待つ指示");
    const saving = f.session.saveDraft();
    controller.update({ active: "main" });
    await openAnswer();
    expect(controller.snapshot().prompt?.label).toBe("Q1 への回答");
    controller.setPromptDraft("保存中に書いた回答");
    gate.resolve();
    expect(await saving).toBe(true);
    expect(controller.promptText()).toBe("保存中に書いた回答");
  } finally {
    gate.resolve();
    disconnect();
  }
});

it("確定事項の編集欄は同じスレッドの共有下書きを受け取っても編集中の文章を保つ", async () => {
  const f = fixture();
  f.data.draft = { text: "先に用意した確定事項", images: [], updatedAt: 1, updatedBy: "other" };
  await f.session.load();
  const disconnect = f.session.connect();
  const controller = f.session.controller;
  try {
    f.session.proposeFinish("AIの案", async () => {});
    f.data.draft = {
      text: "別端末の返信",
      images: ["other-image"],
      updatedAt: 10,
      updatedBy: "other",
    };
    await f.session.refresh();
    expect({ text: controller.promptText(), images: controller.snapshot().prompt?.images }).toEqual(
      {
        text: "先に用意した確定事項",
        images: undefined,
      },
    );
  } finally {
    disconnect();
  }
});

describe("届く前の指示を入力欄で直す", () => {
  const queued = (id: string, text: string, position: number): Snapshot["queue"][number] => ({
    id,
    text,
    images: [],
    position,
    stockItemId: null,
    clientId: null,
    createdAt: position,
  });
  async function editing({ working = true, draft = "書きかけ" } = {}) {
    const f = fixture();
    f.data.conversation.runState = working ? "working" : "idle";
    f.data.queue = [
      queued("q1", "BOM 付きのときも確かめて", 1),
      queued("q2", "終わったらテストの件数を教えて", 2),
    ];
    const edits: [string, DraftContent][] = [];
    const sends: ConversationMessage[] = [];
    f.api.editQueue = async (_id, itemId, body) => {
      edits.push([itemId, body]);
      const item = f.data.queue.find((value) => value.id === itemId);
      if (!item) throw new ConversationApiError(404, "not_found", "預かった指示が見つかりません");
      Object.assign(item, body);
      return { queueItem: structuredClone(item) };
    };
    f.api.send = async (_id, body) => {
      sends.push(body);
      return { result: "delivered", queueItem: null };
    };
    await f.session.load();
    const disconnect = f.session.connect();
    const controller = f.session.controller;
    controller.openPrompt(controller.options.prompt!()!);
    const prompt = () => controller.snapshot().prompt!;
    const type = (text: string) => {
      controller.setPromptDraft(text);
      prompt().change!(text);
    };
    if (draft) type(draft);
    const up = () => prompt().prev!(controller.promptText());
    const down = () => prompt().next!(controller.promptText());
    return { f, controller, edits, sends, disconnect, prompt, type, up, down };
  }
  const chrome = (spec: PromptSpec | null) => ({
    label: spec?.label,
    verb: spec?.verb,
    escHint: spec?.escHint,
    interruptVerb: spec?.interruptVerb,
    prevHint: spec?.prevHint,
    prev: typeof spec?.prev,
  });

  it.each([
    {
      name: "作業中の書きかけ",
      working: true,
      ups: 0,
      expected: {
        label: "指示",
        verb: "送る",
        escHint: undefined,
        interruptVerb: "AI を止めてすぐ送る",
        prevHint: "届く前の指示を直す",
        prev: "function",
      },
    },
    {
      name: "作業中のいちばん新しい指示",
      working: true,
      ups: 1,
      expected: {
        label: "預けた指示を直す (2 / 2 件目)",
        verb: "直す",
        escHint: "閉じる (直した内容は残る)",
        interruptVerb: "AI を止めて届く前の指示をすぐ送る",
        prevHint: "前の指示へ",
        prev: "function",
      },
    },
    {
      name: "作業中でないいちばん古い指示",
      working: false,
      ups: 2,
      expected: {
        label: "預けた指示を直す (1 / 2 件目)",
        verb: "直す",
        escHint: "閉じる (直した内容は残る)",
        interruptVerb: "届く前の指示をすぐ送る",
        prevHint: undefined,
        prev: "undefined",
      },
    },
  ])(
    "$name では、欄の名前・動詞・ヒントをその項目に合わせる",
    async ({ working, ups, expected }) => {
      const e = await editing({ working });
      for (let i = 0; i < ups; i++) await e.up();
      expect(chrome(e.prompt())).toEqual(expected);
      e.disconnect();
    },
  );

  it("届く前の指示が無いと、↑ で呼び出せず、ヒントも出さない", async () => {
    const f = fixture();
    await f.session.load();
    const disconnect = f.session.connect();
    const controller = f.session.controller;
    controller.openPrompt(controller.options.prompt!()!);
    expect(chrome(controller.snapshot().prompt)).toEqual({
      label: "指示",
      verb: "送る",
      escHint: undefined,
      interruptVerb: undefined,
      prevHint: undefined,
      prev: "undefined",
    });
    disconnect();
  });

  it("直しているあいだ、入力欄の内容を書きかけとして保存しない", async () => {
    const e = await editing();
    await e.up();
    e.type("件数と所要時間を教えて");
    await e.f.session.saveDraft();
    expect(e.f.data.draft).toEqual({
      text: "書きかけ",
      images: [],
      updatedAt: 1,
      updatedBy: "tab",
    });
    e.disconnect();
  });

  it("Normal の Enter で直した内容を保存して閉じ、次に開くと書きかけが出る", async () => {
    const e = await editing();
    await e.up();
    e.type("件数と所要時間を教えて");
    await e.controller.submitPrompt(e.controller.promptText());
    e.controller.openPrompt(e.controller.options.prompt!()!);
    expect({
      edits: e.edits,
      notice: e.controller.snapshot().notice,
      label: e.prompt().label,
      text: e.controller.promptText(),
      sends: e.sends,
      queued: e.f.shown().filter((line) => line.startsWith("届く前の指示: ")),
    }).toEqual({
      edits: [["q2", { text: "件数と所要時間を教えて", images: [] }]],
      notice: { message: "預けた指示を直しました", kind: "info" },
      label: "指示",
      text: "書きかけ",
      sends: [],
      queued: ["届く前の指示: BOM 付きのときも確かめて", "届く前の指示: 件数と所要時間を教えて"],
    });
    e.disconnect();
  });

  it("Esc で直した内容を保存して閉じ、次に開くと書きかけが出る", async () => {
    const e = await editing();
    await e.up();
    e.type("件数と所要時間を教えて");
    e.controller.closePrompt(e.controller.promptText());
    await Promise.resolve();
    e.controller.openPrompt(e.controller.options.prompt!()!);
    expect({ edits: e.edits, label: e.prompt().label, text: e.controller.promptText() }).toEqual({
      edits: [["q2", { text: "件数と所要時間を教えて", images: [] }]],
      label: "指示",
      text: "書きかけ",
    });
    e.disconnect();
  });

  it.each([
    {
      name: "作業中",
      working: true,
      notice: "AI を止めて、届く前の指示 2 件をすぐに送りました",
    },
    { name: "作業中でない", working: false, notice: "届く前の指示 2 件を送りました" },
  ])(
    "$name に直して Ctrl+Enter を押すと、保存してから届く前の指示をすぐに送る",
    async ({ working, notice }) => {
      const e = await editing({ working });
      await e.up();
      e.type("件数と所要時間を教えて");
      const closed = await e.controller.submitPrompt(e.controller.promptText(), true);
      expect({
        closed,
        prompt: e.controller.snapshot().prompt,
        edits: e.edits,
        sends: e.sends,
        notice: e.controller.snapshot().notice,
      }).toEqual({
        closed: true,
        prompt: null,
        edits: [["q2", { text: "件数と所要時間を教えて", images: [] }]],
        sends: [{ text: "", images: [], mode: "interrupt", clientMessageId: "message-1" }],
        notice: { message: notice, kind: "info" },
      });
      e.disconnect();
    },
  );

  it("届けるのに失敗すると、直している指示に留まって未送信を出し、もう一度 Ctrl+Enter で送れる", async () => {
    const e = await editing();
    await e.up();
    e.type("件数と所要時間を教えて");
    const send = e.f.api.send;
    e.f.api.send = async () => {
      throw new ConversationApiError(503, "runner_unavailable", "ランナーにつながりません");
    };
    await e.controller.submitPrompt(e.controller.promptText(), true);
    const failed = {
      label: e.prompt().label,
      unsent: e.prompt().unsent,
      text: e.controller.promptText(),
    };
    e.f.api.send = send;
    await e.controller.submitPrompt(e.controller.promptText(), true);
    expect({ failed, edits: e.edits.length, sends: e.sends }).toEqual({
      failed: {
        label: "預けた指示を直す (2 / 2 件目)",
        unsent: "ランナーにつながりません",
        text: "件数と所要時間を教えて",
      },
      edits: 1,
      sends: [{ text: "", images: [], mode: "interrupt", clientMessageId: "message-1" }],
    });
    e.disconnect();
  });

  it("保存に失敗すると、移らずに今の指示に留まり、理由を出す", async () => {
    const e = await editing();
    await e.up();
    e.type("件数と所要時間を教えて");
    e.f.api.editQueue = async () => {
      throw new ConversationApiError(500, "internal", "保存できませんでした");
    };
    await expect(e.down()).rejects.toThrow("保存できませんでした");
    expect({ label: e.prompt().label, text: e.controller.promptText() }).toEqual({
      label: "預けた指示を直す (2 / 2 件目)",
      text: "件数と所要時間を教えて",
    });
    e.disconnect();
  });

  it("本文を空にして保存しようとすると、保存せずに留まり、取り消し方を案内する", async () => {
    const e = await editing();
    await e.up();
    e.type("");
    await e.controller.submitPrompt("");
    expect({
      edits: e.edits,
      label: e.prompt().label,
      notice: e.controller.snapshot().notice,
    }).toEqual({
      edits: [],
      label: "預けた指示を直す (2 / 2 件目)",
      notice: {
        message: "内容が空です。取り消すときは、届く前の指示の行で dd を押してください",
        kind: "error",
      },
    });
    e.disconnect();
  });

  it("書きかけを保存できないときは移らず、理由を出す", async () => {
    const e = await editing();
    e.f.session.connection(false);
    await expect(e.up()).rejects.toThrow("サーバーにつながりません");
    expect({ label: e.prompt().label, text: e.controller.promptText() }).toEqual({
      label: "指示",
      text: "書きかけ",
    });
    e.disconnect();
  });

  it("直しているあいだに貼った画像は直している指示に付き、:images clear も指示の画像に効く", async () => {
    const e = await editing();
    await e.up();
    e.prompt().paste!([new File(["image"], "image.png", { type: "image/png" })]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pasted = e.prompt().images;
    await e.controller.submitPrompt(e.controller.promptText());
    e.controller.openPrompt(e.controller.options.prompt!()!);
    await e.up();
    await e.controller.command("images clear");
    expect({
      pasted,
      cleared: e.prompt().images,
      edits: e.edits,
      draft: e.f.data.draft?.images,
    }).toEqual({
      pasted: 1,
      cleared: 0,
      edits: [["q2", { text: "終わったらテストの件数を教えて", images: ["img"] }]],
      draft: [],
    });
    e.disconnect();
  });

  it("別のタブで届く前の指示が増えると、件数を数え直す", async () => {
    const e = await editing();
    await e.up();
    e.f.data.queue.push(queued("q3", "別のタブの指示", 3));
    await e.f.session.refresh();
    expect(e.prompt().label).toBe("預けた指示を直す (2 / 3 件目)");
    e.disconnect();
  });

  it("書きかけに戻るときは、脇に置いているあいだに別のタブが書いた書きかけを出す", async () => {
    const e = await editing();
    await e.up();
    e.f.data.draft = { text: "別のタブの書きかけ", images: [], updatedAt: 50, updatedBy: "other" };
    await e.down();
    expect({
      label: e.prompt().label,
      text: e.controller.promptText(),
      notice: e.controller.snapshot().notice,
    }).toEqual({
      label: "指示",
      text: "別のタブの書きかけ",
      notice: { message: "別の端末で書いた内容に置き換わりました", kind: "info" },
    });
    e.disconnect();
  });

  it.each([
    {
      name: "変えていない指示が消えた",
      change: false,
      delivered: false,
      draft: null,
      text: "書きかけ",
      notice: "この指示は、もう届く前の指示にありません",
    },
    {
      name: "直した指示が届いていた",
      change: true,
      delivered: true,
      draft: null,
      text: "書きかけ\n\n件数と所要時間を教えて",
      notice: "この指示はもう届いていました。直した内容を書きかけの後ろに足しました",
    },
    {
      name: "直した指示が取り消された",
      change: true,
      delivered: false,
      draft: "書きかけ\n\n終わったらテストの件数を教えて",
      text: "書きかけ\n\n件数と所要時間を教えて",
      notice: "この指示は取り消されました。直した内容を書きかけに戻しました",
    },
    {
      name: "直した指示が取り消され、書きかけに元の本文が見つからない",
      change: true,
      delivered: false,
      draft: "別の書きかけ",
      text: "別の書きかけ\n\n件数と所要時間を教えて",
      notice: "この指示は取り消されました。直した内容を書きかけに戻しました",
    },
  ])("$name ときは、書きかけに戻る", async ({ change, delivered, draft, text, notice }) => {
    const e = await editing();
    await e.up();
    if (change) e.type("件数と所要時間を教えて");
    e.f.data.queue = e.f.data.queue.filter((item) => item.id !== "q2");
    if (draft !== null)
      e.f.data.draft = { text: draft, images: [], updatedAt: 50, updatedBy: "other" };
    if (delivered)
      e.f.session.receiveEvent({
        seq: 2,
        createdAt: 2,
        type: "user_message",
        payload: {
          text: "BOM 付きのときも確かめて\n\n終わったらテストの件数を教えて",
          images: [],
          origin: "developer",
          queued_ids: ["q1", "q2"],
        },
      });
    await e.f.session.refresh();
    expect({
      label: e.prompt().label,
      text: e.controller.promptText(),
      notice: e.controller.snapshot().notice,
    }).toEqual({ label: "指示", text, notice: { message: notice, kind: "info" } });
    e.disconnect();
  });

  it("書きかけが空で届く前の指示があると、Ctrl+Enter で届く前の指示だけをすぐに送ったと知らせる", async () => {
    const e = await editing({ draft: "" });
    await e.controller.submitPrompt("", true);
    expect(e.controller.snapshot().notice).toEqual({
      message: "AI を止めて、届く前の指示 2 件をすぐに送りました",
      kind: "info",
    });
    e.disconnect();
  });

  it("保存の応答を待つあいだに書き足した内容と画像は、入力欄に残り、次の Enter で保存する", async () => {
    const e = await editing();
    await e.up();
    e.type("件数と所要時間を教えて");
    const gate = deferred();
    const editQueue = e.f.api.editQueue;
    e.f.api.editQueue = async (...args) => {
      await gate.promise;
      return editQueue(...args);
    };
    const first = e.controller.submitPrompt(e.controller.promptText());
    await Promise.resolve();
    e.type("件数と所要時間とメモリを教えて");
    e.prompt().paste!([new File(["image"], "image.png", { type: "image/png" })]);
    gate.resolve();
    await first;
    const during = {
      label: e.prompt().label,
      text: e.controller.promptText(),
      images: e.prompt().images,
    };
    await e.controller.submitPrompt(e.controller.promptText());
    expect({ during, edits: e.edits, prompt: e.controller.snapshot().prompt }).toEqual({
      during: {
        label: "預けた指示を直す (2 / 2 件目)",
        text: "件数と所要時間とメモリを教えて",
        images: 1,
      },
      edits: [
        ["q2", { text: "件数と所要時間を教えて", images: [] }],
        ["q2", { text: "件数と所要時間とメモリを教えて", images: ["img"] }],
      ],
      prompt: null,
    });
    e.disconnect();
  });

  it("Esc で閉じたときに保存できなければ、直した内容のまま入力欄を開き直す", async () => {
    const e = await editing();
    await e.up();
    e.type("件数と所要時間を教えて");
    e.f.api.editQueue = async () => {
      throw new ConversationApiError(500, "internal", "保存できませんでした");
    };
    e.controller.closePrompt(e.controller.promptText());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect({
      label: e.prompt().label,
      text: e.controller.promptText(),
      notice: e.controller.snapshot().notice,
    }).toEqual({
      label: "預けた指示を直す (2 / 2 件目)",
      text: "件数と所要時間を教えて",
      notice: { message: "保存できませんでした", kind: "error" },
    });
    e.disconnect();
  });

  it("書きかけの保存に失敗すると、↑ で移らない", async () => {
    const e = await editing();
    e.f.api.saveDraft = async () => {
      throw new ConversationApiError(500, "internal", "書きかけを保存できませんでした");
    };
    await e.up();
    expect({
      label: e.prompt().label,
      text: e.controller.promptText(),
      notice: e.controller.snapshot().notice,
    }).toEqual({
      label: "指示",
      text: "書きかけ",
      notice: { message: "書きかけを保存できませんでした", kind: "error" },
    });
    e.disconnect();
  });

  it("取り消しの復帰を待っているあいだは、↑ で指示を呼び出さない", async () => {
    const e = await editing({ draft: "" });
    e.controller.closePrompt("");
    e.f.api.deleteQueue = async (_id, itemId) => {
      const item = e.f.data.queue.find((value) => value.id === itemId)!;
      e.f.data.queue = e.f.data.queue.filter((value) => value.id !== itemId);
      e.f.data.draft = { text: item.text, images: [], updatedAt: 5, updatedBy: "tab" };
    };
    const gate = deferred();
    e.f.api.send = async () => {
      await gate.promise;
      return { result: "delivered", queueItem: null };
    };
    e.controller.registerWindow("main", {
      focus() {},
      lines: () => [{ kind: "queued", text: "届く前の指示: BOM", id: "queue:q1" }],
      position: () => ({ line: 0, column: 0, topLine: 0 }),
      place() {},
      view: "conversation",
      name: "会話",
      posKey: "c1",
      url: "/conversations/c1",
      scrollCursor() {},
    });
    e.controller.focus("main");
    await e.controller.run("item.delete");
    const undoing = e.controller.run("item.undo");
    await new Promise((resolve) => setTimeout(resolve, 0));
    e.controller.openPrompt(e.controller.options.prompt!()!);
    await expect(e.up()).rejects.toThrow(
      "預けた指示を戻しています。対象の編集や送信は、復帰の結果が出てから行ってください。",
    );
    expect(e.prompt().label).toBe("指示");
    gate.resolve();
    await undoing;
    e.disconnect();
  });

  it("直した指示が取り消されたときは、元の本文の画像を直した指示の画像に置き換える", async () => {
    const e = await editing();
    e.f.data.queue[1].images = ["old-image"];
    await e.f.session.refresh();
    await e.up();
    e.prompt().paste!([new File(["image"], "image.png", { type: "image/png" })]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    e.f.data.queue = e.f.data.queue.filter((item) => item.id !== "q2");
    e.f.data.draft = {
      text: "書きかけ\n\n終わったらテストの件数を教えて",
      images: ["draft-image", "old-image"],
      updatedAt: 50,
      updatedBy: "other",
    };
    await e.f.session.refresh();
    await e.f.session.saveDraft();
    expect(e.f.data.draft).toEqual({
      text: "書きかけ\n\n終わったらテストの件数を教えて",
      images: ["draft-image", "old-image", "img"],
      updatedAt: 51,
      updatedBy: "tab",
    });
    e.disconnect();
  });

  it("ストックの指示と一緒に送る入力欄では、↑ で届く前の指示を呼び出さない", async () => {
    const e = await editing();
    e.controller.closePrompt(e.controller.promptText());
    e.f.session.openReviewPrompt(["s1"]);
    expect({ prev: typeof e.prompt().prev, prevHint: e.prompt().prevHint }).toEqual({
      prev: "undefined",
      prevHint: undefined,
    });
    e.disconnect();
  });

  it("届けるあいだに書き足すと、直している指示に留まり、次の Ctrl+Enter を別の送信として送る", async () => {
    const e = await editing();
    await e.up();
    const gate = deferred();
    const send = e.f.api.send;
    e.f.api.send = async (...args) => {
      await gate.promise;
      return send(...args);
    };
    const first = e.controller.submitPrompt(e.controller.promptText(), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    e.type("終わったらテストの件数と所要時間を教えて");
    gate.resolve();
    await first;
    const label = e.prompt().label;
    e.f.api.send = send;
    await e.controller.submitPrompt(e.controller.promptText(), true);
    expect({ label, edits: e.edits, sends: e.sends }).toEqual({
      label: "預けた指示を直す (2 / 2 件目)",
      edits: [["q2", { text: "終わったらテストの件数と所要時間を教えて", images: [] }]],
      sends: [
        { text: "", images: [], mode: "interrupt", clientMessageId: "message-1" },
        { text: "", images: [], mode: "interrupt", clientMessageId: "message-2" },
      ],
    });
    e.disconnect();
  });

  it("画面を離れるときに直した内容を保存できなくても、入力欄を開き直さない", async () => {
    const e = await editing();
    await e.up();
    e.type("件数と所要時間を教えて");
    e.f.api.editQueue = async () => {
      throw new ConversationApiError(500, "internal", "保存できませんでした");
    };
    e.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect({
      prompt: e.controller.snapshot().prompt,
      notice: e.controller.snapshot().notice,
    }).toEqual({ prompt: null, notice: { message: "保存できませんでした", kind: "error" } });
  });

  it("直しているあいだに別のタブが書きかけを変えても、入力欄の内容は直している指示のまま", async () => {
    const e = await editing();
    await e.up();
    e.type("件数と所要時間を教えて");
    e.f.data.draft = { text: "別のタブの書きかけ", images: [], updatedAt: 50, updatedBy: "other" };
    await e.f.session.refresh();
    expect({ label: e.prompt().label, text: e.controller.promptText() }).toEqual({
      label: "預けた指示を直す (2 / 2 件目)",
      text: "件数と所要時間を教えて",
    });
    e.disconnect();
  });

  it("書きかけを保存しているあいだに入力欄を開き直したら、新しい入力欄では指示を呼び出さない", async () => {
    const e = await editing();
    const gate = deferred();
    const saveDraft = e.f.api.saveDraft;
    e.f.api.saveDraft = async (...args) => {
      await gate.promise;
      return saveDraft(...args);
    };
    const moving = e.up();
    e.controller.closePrompt(e.controller.promptText());
    e.controller.openPrompt(e.controller.options.prompt!()!);
    gate.resolve();
    await moving;
    expect({ label: e.prompt().label, text: e.controller.promptText() }).toEqual({
      label: "指示",
      text: "書きかけ",
    });
    e.disconnect();
  });

  it("別の指示の取り消しを戻しているあいだも、直している指示は書き換えられる", async () => {
    const e = await editing();
    await e.up();
    e.f.api.deleteQueue = async (_id, itemId) => {
      const item = e.f.data.queue.find((value) => value.id === itemId)!;
      e.f.data.queue = e.f.data.queue.filter((value) => value.id !== itemId);
      e.f.data.draft = {
        text: `書きかけ\n\n${item.text}`,
        images: [],
        updatedAt: 5,
        updatedBy: "tab",
      };
    };
    const gate = deferred();
    e.f.api.send = async () => {
      await gate.promise;
      return { result: "delivered", queueItem: null };
    };
    e.controller.registerWindow("main", {
      focus() {},
      lines: () => [{ kind: "queued", text: "届く前の指示: BOM", id: "queue:q1" }],
      position: () => ({ line: 0, column: 0, topLine: 0 }),
      place() {},
      view: "conversation",
      name: "会話",
      posKey: "c1",
      url: "/conversations/c1",
      scrollCursor() {},
    });
    e.controller.focus("main");
    await e.controller.run("item.delete");
    const undoing = e.controller.run("item.undo");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const text = e.controller.promptText();
    const allowed = e.prompt().allowChange!(
      `${text}と所要時間`,
      ChangeSet.of([{ from: text.length, insert: "と所要時間" }], text.length).desc,
    );
    expect({ allowed, notice: e.controller.snapshot().notice?.kind }).toEqual({
      allowed: true,
      notice: "info",
    });
    gate.resolve();
    await undoing;
    e.disconnect();
  });

  it("Ctrl+Enter で保存した指示がもう無いと、届けずに書きかけに戻る", async () => {
    const e = await editing();
    await e.up();
    e.type("件数と所要時間を教えて");
    e.f.data.queue = e.f.data.queue.filter((item) => item.id !== "q2");
    await e.controller.submitPrompt(e.controller.promptText(), true);
    expect({ sends: e.sends, label: e.prompt().label }).toEqual({ sends: [], label: "指示" });
    e.disconnect();
  });

  it.each([
    { name: "Enter", exit: "submit" },
    { name: "Ctrl+Enter", exit: "interrupt" },
    { name: "Esc", exit: "close" },
    { name: "↑", exit: "prev" },
  ])("画像を上げているあいだに $name を押しても、画像を付けて保存する", async ({ exit }) => {
    const e = await editing();
    await e.up();
    await e.up();
    await e.down();
    const gate = deferred();
    const upload = e.f.api.upload;
    e.f.api.upload = async (...args) => {
      await gate.promise;
      return upload(...args);
    };
    e.prompt().paste!([new File(["image"], "image.png", { type: "image/png" })]);
    const text = e.controller.promptText();
    const leaving =
      exit === "submit"
        ? e.controller.submitPrompt(text)
        : exit === "interrupt"
          ? e.controller.submitPrompt(text, true)
          : exit === "close"
            ? Promise.resolve(e.controller.closePrompt(text))
            : e.up();
    gate.resolve();
    await leaving;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(e.edits).toEqual([["q2", { text: "終わったらテストの件数を教えて", images: ["img"] }]]);
    e.disconnect();
  });

  it("届けるあいだに貼った画像は、届いたあとも直している指示に残る", async () => {
    const e = await editing();
    await e.up();
    const sending = deferred();
    const uploading = deferred();
    const send = e.f.api.send;
    e.f.api.send = async (...args) => {
      await sending.promise;
      return send(...args);
    };
    const upload = e.f.api.upload;
    e.f.api.upload = async (...args) => {
      await uploading.promise;
      return upload(...args);
    };
    const first = e.controller.submitPrompt(e.controller.promptText(), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    e.prompt().paste!([new File(["image"], "image.png", { type: "image/png" })]);
    sending.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    uploading.resolve();
    await first;
    expect({ label: e.prompt().label, images: e.prompt().images }).toEqual({
      label: "預けた指示を直す (2 / 2 件目)",
      images: 1,
    });
    e.disconnect();
  });

  it("前の指示へ移る保存のあいだに入力欄を閉じると、次に開く入力欄は書きかけになる", async () => {
    const e = await editing();
    await e.up();
    e.type("件数と所要時間を教えて");
    const gate = deferred();
    const editQueue = e.f.api.editQueue;
    e.f.api.editQueue = async (...args) => {
      await gate.promise;
      return editQueue(...args);
    };
    const moving = e.up();
    e.controller.closePrompt(e.controller.promptText());
    gate.resolve();
    await moving;
    await new Promise((resolve) => setTimeout(resolve, 0));
    e.controller.openPrompt(e.controller.options.prompt!()!);
    expect({ label: e.prompt().label, text: e.controller.promptText() }).toEqual({
      label: "指示",
      text: "書きかけ",
    });
    e.disconnect();
  });

  it("書きかけを読み直すあいだに別の入力欄を開くと、その入力欄を書きかけに差し替えない", async () => {
    const e = await editing();
    await e.up();
    const gate = deferred();
    const get = e.f.api.get;
    e.f.api.get = async (...args) => {
      await gate.promise;
      return get(...args);
    };
    const moving = e.down();
    await new Promise((resolve) => setTimeout(resolve, 0));
    e.controller.closePrompt(e.controller.promptText());
    e.f.session.openReviewPrompt(["s1"]);
    gate.resolve();
    await moving;
    expect({ label: e.prompt().label, prevHint: e.prompt().prevHint }).toEqual({
      label: "指示",
      prevHint: undefined,
    });
    e.disconnect();
  });

  it("閉じたあとに直した指示が取り消されていたと分かると、開いている入力欄に戻した書きかけを出す", async () => {
    const e = await editing();
    await e.up();
    e.type("件数と所要時間を教えて");
    const gate = deferred();
    e.f.api.editQueue = async () => {
      await gate.promise;
      throw new ConversationApiError(404, "not_found", "預かった指示が見つかりません");
    };
    e.controller.closePrompt(e.controller.promptText());
    e.f.session.openReviewPrompt(["s1"]);
    e.f.api.get = () => new Promise(() => {});
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect({ text: e.controller.promptText(), prevHint: e.prompt().prevHint }).toEqual({
      text: "書きかけ\n\n件数と所要時間を教えて",
      prevHint: undefined,
    });
    e.disconnect();
  });

  it("書きかけを書いているあいだに AI が作業を始めて指示が預けられると、↑ の案内とすぐ送る動詞を出す", async () => {
    const f = fixture();
    await f.session.load();
    const disconnect = f.session.connect();
    const controller = f.session.controller;
    controller.openPrompt(controller.options.prompt!()!);
    f.data.conversation.runState = "working";
    f.data.queue = [queued("q1", "別のタブの指示", 1)];
    await f.session.refresh();
    expect({
      prevHint: controller.snapshot().prompt?.prevHint,
      interruptVerb: controller.snapshot().prompt?.interruptVerb,
    }).toEqual({ prevHint: "届く前の指示を直す", interruptVerb: "AI を止めてすぐ送る" });
    disconnect();
  });

  it("直している指示に画像が 20 枚あると、それ以上は貼れない", async () => {
    const e = await editing();
    e.f.data.queue[1].images = Array.from({ length: 20 }, (_, index) => `image-${index}`);
    await e.f.session.refresh();
    await e.up();
    e.prompt().paste!([new File(["image"], "image.png", { type: "image/png" })]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect({ images: e.prompt().images, notice: e.controller.snapshot().notice }).toEqual({
      images: 20,
      notice: { message: "画像は 1 通に 20 枚までです", kind: "error" },
    });
    e.disconnect();
  });

  it("以前の相談の本文の位置が分からなくなる直し方では、保存せずに理由を出す", async () => {
    const e = await editing();
    e.f.data.queue[1] = {
      ...queued("q2", "旧形式の相談", 2),
      timeline_anchors: [
        {
          from: 0,
          to: 6,
          originalText: "旧形式の相談",
          comments: [{ task_id: "t1", text: "旧形式の相談" }],
        },
      ],
    };
    await e.f.session.refresh();
    await e.up();
    e.type("旧形式を直した相談");
    await e.controller.submitPrompt(e.controller.promptText());
    expect({ edits: e.edits, notice: e.controller.snapshot().notice }).toEqual({
      edits: [],
      notice: { message: unlocatedConsultationNotice, kind: "error" },
    });
    e.disconnect();
  });

  it("相談を直すと、相談の範囲を直した本文に合わせて保存する", async () => {
    const e = await editing();
    const text = "タイムラインのタスク t1「書き出し」について: 文字コードを確かめて";
    const bodyFrom = text.indexOf("文字コード");
    e.f.data.queue[1] = {
      ...queued("q2", text, 2),
      timeline_anchors: [{ task_id: "t1", from: 0, bodyFrom, to: text.length }],
    };
    await e.f.session.refresh();
    await e.up();
    e.type(`${text}と改行も`);
    await e.controller.submitPrompt(e.controller.promptText());
    expect(e.edits).toEqual([
      [
        "q2",
        {
          text: `${text}と改行も`,
          images: [],
          timeline_anchors: [{ task_id: "t1", from: 0, bodyFrom, to: text.length + 4 }],
        },
      ],
    ]);
    e.disconnect();
  });

  it.each([
    {
      name: "ストックとまとめて預けた指示",
      head: "ストックした指示が 1 件あります。順に対応してください。\n\n1. この会話の発言から\n> 引用した行\n指摘の本文\n\n",
      item: (head: string) => ({
        deliveryContext: {
          stockIds: ["s1"],
          original: { text: "開発者の本文", images: [] },
          originalRanges: [{ from: head.length, to: head.length + 6 }],
        },
      }),
    },
    {
      name: "本文の範囲を持たないまとめた指示",
      head: "ストックした指示が 1 件あります。順に対応してください。\n\n1. この会話の発言から\n> 引用した行\n指摘の本文\n\n",
      item: () => ({
        deliveryContext: { stockIds: ["s1"], original: { text: "開発者の本文", images: [] } },
      }),
    },
    {
      name: "ストックから預けた指示",
      head: "src/a.ts 1〜2 行目\n> 一行目\n> 二行目\n",
      item: () => ({ stockItemId: "s1" }),
    },
  ])("$name は、前置きと引用を入力欄に出さず、保つ", async ({ head, item }) => {
    const e = await editing();
    e.f.data.queue[1] = {
      ...queued("q2", `${head}開発者の本文`, 2),
      images: ["developer-image"],
      ...item(head),
    };
    await e.f.session.refresh();
    await e.up();
    const shown = e.controller.promptText();
    e.type("直した本文");
    await e.controller.submitPrompt(e.controller.promptText());
    expect({ shown, edits: e.edits }).toEqual({
      shown: "開発者の本文",
      edits: [["q2", { text: `${head}直した本文`, images: ["developer-image"] }]],
    });
    e.disconnect();
  });

  it.each([
    {
      name: "本文が複数の範囲に分かれた指示",
      ranges: [
        { from: 10, to: 16 },
        { from: 27, to: 33 },
      ],
    },
    { name: "本文の範囲が分からない指示", ranges: undefined },
  ])("$name は、前置きを含めた全文を入力欄に出す", async ({ ranges }) => {
    const e = await editing();
    const text = "差し戻しの前置き\n\n一つ目の本文\n\nストックの引用\n\n二つ目の本文";
    e.f.data.queue[1] = {
      ...queued("q2", text, 2),
      deliveryContext: {
        stockIds: ["s1"],
        original: { text: "一つ目の本文\n\n二つ目の本文", images: [] },
        ...(ranges ? { originalRanges: ranges } : {}),
      },
    };
    await e.f.session.refresh();
    await e.up();
    expect(e.controller.promptText()).toBe(text);
    e.disconnect();
  });

  it("届く前の指示の行の cc でも、書きかけを脇に置いて指示を直せる", async () => {
    const e = await editing();
    e.controller.closePrompt(e.controller.promptText());
    e.controller.registerWindow("main", {
      focus() {},
      lines: () => [{ kind: "queued", text: "届く前の指示: BOM", id: "queue:q1" }],
      position: () => ({ line: 0, column: 0, topLine: 0 }),
      place() {},
      view: "conversation",
      name: "会話",
      posKey: "c1",
      url: "/conversations/c1",
      scrollCursor() {},
    });
    e.controller.focus("main");
    await e.controller.run("item.edit");
    e.type("BOM 付きと改行コードも確かめて");
    await e.f.session.saveDraft();
    expect({
      label: e.prompt().label,
      text: e.controller.promptText(),
      draft: e.f.data.draft?.text,
    }).toEqual({
      label: "預けた指示を直す (1 / 2 件目)",
      text: "BOM 付きと改行コードも確かめて",
      draft: "書きかけ",
    });
    e.disconnect();
  });
});
