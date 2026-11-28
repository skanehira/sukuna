import { expect, it } from "vite-plus/test";
import type { BufferHandle } from "../../buffer/Buffer";
import { BufferController } from "../../buffer/controller";
import type { LineInfo } from "../../buffer/line";
import { Realtime, type RealtimeSocket } from "../realtime";
import { ConversationSession } from "./session";
import type { ConversationApi, DraftRequest, Event, Snapshot } from "./types";

const event = (seq: number): Event => ({
  seq,
  createdAt: seq,
  type: "assistant_text",
  payload: { text: `発言${seq}`, parent_tool_use_id: null },
});
function fixture() {
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
  const session = new ConversationSession("c1", api, new BufferController(), {
    clientId: "tab",
    id: () => `message-${++nextId}`,
    now: () => 0,
    schedule: () => () => {},
  });
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
    expect(f.data.draft).toEqual({
      text,
      images: ["img-one", "img"],
      updatedAt: 10 + (mode === "queue-edit" ? 1 : 0) + (change === "image-saved" ? 1 : 2),
      updatedBy: "tab",
    });
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
    expect(edits).toEqual(mode === "queue-edit" ? [{ text: "送る本文", images: ["img-one"] }] : []);
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
    '⎿ {"issue":{"number":42}}',
    ...Array.from({ length: 26 }, (_, index) => `${index + 1} +line${index + 1}`),
    "Q1. 続ける?",
    "はい  ✓ 送った回答",
    "あなた",
    "Q1: はい",
    "AI",
    "発言6",
  ]);
});

async function answeringFixture() {
  const f = fixture();
  f.data.conversation.lastSeq = 2;
  f.data.conversation.runState = "waiting_answer";
  f.events.push({
    seq: 2,
    createdAt: 2,
    type: "question",
    payload: {
      request_id: "q",
      questions: [{ question: "どちらですか", header: "確認", options: [], multi_select: false }],
    },
  });
  await f.session.load();
  const disconnect = f.session.connect();
  const controller = f.session.controller;
  const openAnswer = () =>
    controller.run("conversation.answer.0", { view: "conversation", window: "main", line: 0 });
  return { f, controller, disconnect, openAnswer };
}

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
