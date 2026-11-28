import { mkdirSync, writeFileSync } from "node:fs";
import { EditorState } from "@codemirror/state";
import { afterEach, expect, it } from "vite-plus/test";
import { ulid } from "ulid";
import { join } from "node:path";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
} from "../../../../shared/db/test-helpers";
import { readEnvironment } from "../../../../shared/env";
import { startRunnerApp } from "../../../../runner/app";
import { ScriptedAgent } from "../../../../runner/modules/conversation/adapter/scripted-agent";
import { createApp } from "../../../app";
import { RunnerLink } from "../../../runner-link";
import { createClockFake, createTailscaleFake, incomingWith } from "../../identity/test-support";
import { createConversationDependencies } from "./dependencies";
import { createConversationApi } from "../../../../front/lib/conversation/api";
import { ConversationSession } from "../../../../front/lib/conversation/session";
import type { ConversationApi } from "../../../../front/lib/conversation/types";
import { BufferController } from "../../../../front/buffer/controller";
import { continueWork } from "../../../../front/lib/work-actions";
import { progressResponseSchema } from "../../../../shared/progress/schema";
import type { ServerMessage } from "../../../../shared/ws";
import { WsHub } from "../../../ws-hub";
import { createProgressRepository } from "./progress-repository";
import { createTimelineFilePort } from "./timeline-file";
import { createTimelineWatch } from "./timeline-watch";
import type { ConversationDraft } from "../../../../shared/conversation/api";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  cleanups.push(async () => {
    database.close();
    removeTempHome(home);
  });
  database.sqlite
    .prepare(
      "INSERT INTO projects (id, name, path, default_branch) VALUES ('project', '会計', ?, 'main')",
    )
    .run(home);
  const agent = new ScriptedAgent({
    rules: [
      {
        match: "^完了を待つ$",
        steps: [
          {
            shell:
              'count=0; while [ ! -f timeline-release ] && [ "$count" -lt 120 ]; do sleep 0.05; count=$((count+1)); done',
          },
          { end: "success" },
        ],
      },
    ],
    fallback: [{ text: "応答開始" }, { hold: true }],
  });
  const runner = await startRunnerApp({
    database,
    agent,
    environment: readEnvironment("runner", { SUKUNA_HOME: home }, home, () => true)._unsafeUnwrap(),
    log: () => {},
  });
  cleanups.push(() => runner.shutdown());
  const link = new RunnerLink({
    socket: join(home, "runner.sock"),
    log: () => {},
    notice: () => {},
    connection: () => {},
  });
  let tick = 1_000;
  const now = () => ++tick;
  const server = createApp({
    build: "test",
    identity: {
      login: "test@example.com",
      devIdentity: "1",
      tailscale: createTailscaleFake().api,
      clock: createClockFake(),
    },
    progress: {
      repository: createProgressRepository(database.db),
      timeline: createTimelineFilePort({ configDir: home, sleep: async () => {} }),
    },
    conversations: createConversationDependencies({
      sqlite: database.sqlite,
      home,
      runner: link,
      id: ulid,
      now,
      changed: () => {},
      reopened: () => {},
    }),
  });
  const id = (
    await runner.runtime.start({ projectId: "project", kind: "chat", title: "会計", cwd: home })
  )._unsafeUnwrap().conversationId;
  const fetcher: typeof fetch = async (input, init) =>
    server.request(input, init, incomingWith("127.0.0.1", 1234));
  const api = createConversationApi(fetcher);
  const client = async (overrides: Partial<ConversationApi> = {}) => {
    const controller = new BufferController();
    const session = new ConversationSession(id, { ...api, ...overrides }, controller, {
      clientId: ulid(),
      id: ulid,
      now,
      schedule: () => () => {},
    });
    await session.load();
    const disconnect = session.connect();
    cleanups.push(async () => disconnect());
    return { session, controller };
  };
  return { api, id, client, agent, database, home, fetcher };
}

it("同じ表示になる別タスクの相談を下書きから別端末へ渡し、本文とIDを失わず送る", async () => {
  const { api, id, client, agent } = await fixture();
  const first = await client();
  first.session.openConsultation({ id: "a「b", title: "c" });
  const visible = "タイムラインのタスク a「b「c」について: ";
  expect(first.controller.promptText()).toBe(visible);
  expect(first.controller.snapshot().mode).toBe("INSERT");
  const draft = first.controller.snapshot().prompt!;
  draft.change?.(visible + "最初の相談  \n");
  first.controller.setPromptDraft(visible + "最初の相談  \n");
  first.session.openConsultation({ id: "a", title: "b「c" });
  const prefilled = visible + "最初の相談  \n\n\n" + visible;
  expect(first.controller.promptText()).toBe(prefilled);
  const text = prefilled + "本文中の同じ見出し\n" + visible + "  \n";
  first.controller.snapshot().prompt!.change?.(text);
  first.controller.setPromptDraft(text);
  expect(await first.session.saveDraft()).toBe(true);
  const second = await client();
  await second.controller.run("prompt.open");
  expect(second.controller.promptText()).toBe(text);
  expect(await second.controller.submitPrompt(text)).toBe(true);
  await expect.poll(() => agent.sent.map((message) => message.text)).toEqual([text]);
  const event = (await api.events(id, 0)).events.find((entry) => entry.type === "user_message");
  expect(event?.payload).toMatchObject({
    text,
    timeline_comments: [
      { task_id: "a「b", text: "最初の相談  \n" },
      { task_id: "a", text: "本文中の同じ見出し\n" + visible + "  \n" },
    ],
  });
  expect((await api.get(id)).draft).toBeNull();
});

it("続きを作業中に二度預けても下書きを保ち、停止後に同じ会話へ指示を再配達する", async () => {
  const { api, id, client, agent } = await fixture();
  const { controller } = await client();
  const input = { text: "開始", images: [], mode: "send" as const, clientMessageId: "start" };
  await api.send(id, input);
  await expect.poll(() => agent.sent.map((message) => message.text)).toEqual(["開始"]);
  const initialSession = agent.sent[0].sessionId;
  await api.saveDraft(id, {
    text: "まだ送らない指示",
    images: [],
    clientId: "other",
    editedAt: 100,
  });
  const send = (text: string) =>
    api.send(id, { text, images: [], mode: "send", clientMessageId: ulid(), preserveDraft: true });
  const notices: string[] = [];
  const deliver = () => continueWork("注文の明細", send, (message) => notices.push(message));
  await deliver();
  await deliver();
  const resume = "タイムラインのタスクツリー「注文の明細」の作業を続けてください。";
  const working = await api.get(id);
  expect(working.queue.map(({ text }) => text)).toEqual([resume, resume]);
  expect(working.draft).toMatchObject<Partial<ConversationDraft>>({ text: "まだ送らない指示" });
  expect(notices).toEqual(["続きの依頼を預けました", "続きの依頼を預けました"]);
  await controller.run("agent.stop", { window: "right", view: "timeline", line: 0 });
  const stopped = await api.get(id);
  expect(stopped.conversation).toMatchObject({ runState: "stopped", stopReason: "user" });
  expect(stopped.queue.map(({ text }) => text)).toEqual([resume, resume]);
  const next = await api.send(id, { ...input, text: "続ける", clientMessageId: "continue" });
  expect(next.result).toBe("delivered");
  await expect
    .poll(() => agent.sent.slice(1))
    .toEqual([{ sessionId: initialSession, text: [resume, resume, "続ける"].join("\n\n") }]);
});

it("預けた相談の本文を更新し、取り消して保存した下書きから同じ相談先へ再送する", async () => {
  const { api, id, client, agent } = await fixture();
  await api.send(id, { text: "準備", images: [], mode: "send", clientMessageId: "prepare" });
  await expect.poll(() => agent.sent.length).toBe(1);
  const first = await client();
  first.session.openConsultation({ id: "受注の「表」", title: "画面\nとの比較" });
  const prefix = first.controller.promptText();
  const initial = prefix + "確認";
  first.controller.snapshot().prompt!.change?.(initial);
  first.controller.setPromptDraft(initial);
  expect(await first.controller.submitPrompt(initial)).toBe(true);
  const queue = (await api.get(id)).queue;
  expect(queue).toHaveLength(1);
  expect(queue[0]).toMatchObject({
    text: initial,
    timeline_comments: [{ task_id: "受注の「表」", text: "確認" }],
  });
  const edited = prefix + "修正した相談  \n";
  await api.editQueue(id, queue[0].id, {
    text: edited,
    images: [],
    timeline_anchors: [
      { task_id: "受注の「表」", from: 0, bodyFrom: prefix.length, to: edited.length },
    ],
  });
  expect((await api.get(id)).queue[0].timeline_comments).toEqual([
    { task_id: "受注の「表」", text: "修正した相談  \n" },
  ]);
  await api.saveDraft(id, {
    text: "別の普通の指示",
    images: [],
    editedAt: 2_000,
    clientId: "peer",
  });
  await api.deleteQueue(id, queue[0].id);
  const restored = await api.get(id);
  expect(restored.queue).toEqual([]);
  expect(restored.draft?.text).toBe("別の普通の指示\n\n" + edited);
  first.controller.update({ active: "right" });
  await first.controller.run("agent.stop", { window: "right", view: "timeline-task", line: 0 });
  expect((await api.get(id)).conversation.runState).toBe("stopped");
  const second = await client();
  await second.controller.run("prompt.open");
  expect(await second.controller.submitPrompt(restored.draft!.text)).toBe(true);
  await expect.poll(() => agent.sent.at(-1)?.text).toBe(restored.draft!.text);
  const last = (await api.events(id, 0)).events
    .filter(({ type }) => type === "user_message")
    .at(-1);
  expect(last?.payload).toMatchObject({
    text: restored.draft!.text,
    timeline_comments: [{ task_id: "受注の「表」", text: "修正した相談  \n" }],
  });
});

function queueLine(controller: BufferController, id: string) {
  controller.registerWindow("main", {
    focus() {},
    lines: () => [{ kind: "queued", text: "預けた指示", id: "queue:" + id }],
    position: () => ({ line: 0, column: 0, topLine: 0 }),
    place() {},
    view: "conversation",
    name: "会話",
    posKey: "c1",
    url: "/conversations/c1",
    scrollCursor() {},
  });
}

it.each([
  ["同じ前置き", "same"],
  ["異なる前置き", "change"],
  ["本文", "body"],
])("%s を編集し、実際に届く相談先と本文を確かめる", async (_label, mode) => {
  const { api, id, client, agent } = await fixture();
  const { session, controller } = await client();
  session.openConsultation({ id: "task", title: "表示名" });
  const prefix = controller.promptText();
  const apply = (from: number, to: number, insert: string) => {
    const s = EditorState.create({ doc: controller.promptText() });
    const t = s.update({ changes: { from, to, insert } });
    expect(t.docChanged).toBe(true);
    const text = t.state.doc.toString();
    controller.setPromptDraft(text);
    controller.snapshot().prompt!.change?.(text, t.changes);
  };
  apply(prefix.length, prefix.length, "元の相談");
  if (mode === "body") apply(prefix.length, controller.promptText().length, "変更後");
  else apply(0, prefix.length, prefix + (mode === "change" ? "extra " : ""));
  const text = controller.promptText();
  expect(await session.saveDraft()).toBe(true);
  const saved = (await api.get(id)).draft;
  expect(saved?.text).toBe(text);
  expect(await controller.submitPrompt(text)).toBe(true);
  await expect.poll(() => agent.sent.map((m) => m.text)).toEqual([text]);
  const recorded = (await api.events(id, 0)).events.find((event) => event.type === "user_message");
  expect(recorded?.payload).toMatchObject({
    text,
    images: [],
    origin: "developer",
    timeline_comments: mode === "body" ? [{ task_id: "task", text: "変更後" }] : [],
  });
});

it.each([
  { mode: "plain", edit: false },
  { mode: "plain", edit: true },
  { mode: "anchored", edit: false },
  { mode: "anchored", edit: true },
  { mode: "consultation", edit: false },
  { mode: "consultation", edit: true },
  { mode: "legacy consultation", edit: false },
  { mode: "legacy consultation", edit: true },
])("取り消した $mode を戻しても別の相談の下書きが残る (編集: $edit)", async ({ mode, edit }) => {
  const { api, id, client, agent } = await fixture();
  await api.send(id, { text: "現在作業中", images: [], mode: "send", clientMessageId: "start" });
  await expect.poll(() => agent.sent.length).toBe(1);
  const waitingPrefix = "タイムラインのタスク task-b「納入」について: ";
  const body = "別件の確認";
  const assigned = mode === "consultation" || mode === "legacy consultation";
  const queued = mode === "consultation" ? waitingPrefix + body : body;
  await api.send(id, {
    text: queued,
    images: [],
    mode: "send",
    clientMessageId: "next",
    ...(mode === "anchored" ? { timeline_anchors: [], timeline_comments: [] } : {}),
    ...(assigned ? { timeline_comments: [{ task_id: "task-b", text: body }] } : {}),
    ...(mode === "consultation"
      ? {
          timeline_anchors: [
            { task_id: "task-b", from: 0, bodyFrom: waitingPrefix.length, to: queued.length },
          ],
        }
      : {}),
  });
  const [item] = (await api.get(id)).queue;
  const { controller, session } = await client();
  session.openConsultation({ id: "task-a", title: "棚卸" });
  const prefix = controller.promptText();
  const original = prefix + "三月分";
  controller.setPromptDraft(original);
  controller.snapshot().prompt!.change?.(original);
  expect(await session.saveDraft()).toBe(true);
  controller.closePrompt();
  queueLine(controller, item.id);
  controller.update({ active: "main" });
  await controller.run("item.delete");
  const joined = original + "\n\n" + queued;
  expect((await api.get(id)).draft?.text).toBe(joined);
  let desired = original;
  if (edit) {
    await controller.run("prompt.open");
    expect(controller.promptText()).toBe(joined);
    const state = EditorState.create({ doc: joined });
    const change = state.update({
      changes: { from: prefix.length, to: original.length, insert: "四月の棚卸分" },
    });
    const next = change.state.doc.toString();
    desired = prefix + "四月の棚卸分";
    expect(next).toBe(desired + "\n\n" + queued);
    controller.setPromptDraft(next);
    controller.snapshot().prompt!.change?.(next, change.changes);
    expect(await session.saveDraft()).toBe(true);
    controller.closePrompt();
    expect((await api.get(id)).draft?.text).toBe(next);
  }
  await controller.run("item.undo");
  const result = await api.get(id);
  const peer = await client();
  await peer.controller.run("prompt.open");
  expect(peer.controller.promptText()).toBe(desired);
  const draft = result.draft;
  expect(result.queue.map(({ text }) => text)).toEqual([queued]);
  if (assigned)
    expect(result.queue[0].timeline_comments).toEqual([{ task_id: "task-b", text: body }]);
  expect(draft).toMatchObject({
    text: desired,
    timeline_anchors: [{ task_id: "task-a", from: 0, bodyFrom: prefix.length, to: desired.length }],
  });
  await controller.run("item.undo");
  expect((await api.get(id)).queue.map(({ text }) => text)).toEqual([queued]);
  expect(agent.sent).toHaveLength(1);
});

it.each(["pre-migration", "anchored"])(
  "%s の預けた相談を編集すると、配達の本文も変わる",
  async (mode) => {
    const { api, id, client, agent } = await fixture();
    await api.send(id, { text: "開始", images: [], mode: "send", clientMessageId: "start" });
    await expect.poll(() => agent.sent.length).toBe(1);
    const prefix = "タイムラインのタスク task「表示名」について: ";
    const old = "修正前の相談";
    const edited = "修正した相談";
    await api.send(id, {
      text: prefix + old,
      images: [],
      mode: "send",
      clientMessageId: "old",
      timeline_comments: [{ task_id: "task", text: old }],
      ...(mode === "anchored"
        ? {
            timeline_anchors: [
              { task_id: "task", from: 0, bodyFrom: prefix.length, to: prefix.length + old.length },
            ],
          }
        : {}),
    });
    const [item] = (await api.get(id)).queue;
    const { controller } = await client();
    queueLine(controller, item.id);
    await controller.run("item.edit");
    expect(controller.promptText()).toBe(prefix + old);
    controller.setPromptDraft(prefix + edited);
    controller.snapshot().prompt!.change?.(prefix + edited);
    expect(await controller.submitPrompt(prefix + edited)).toBe(true);
    expect((await api.get(id)).queue.map(({ text }) => text)).toEqual([prefix + edited]);
    await api.stop(id);
    await api.send(id, { text: "再開", images: [], mode: "send", clientMessageId: "resume" });
    await expect.poll(() => agent.sent.at(-1)?.text).toBe(prefix + edited + "\n\n再開");
    const delivered = (await api.events(id, 0)).events
      .filter(({ type }) => type === "user_message")
      .at(-1);
    expect(delivered?.payload).toMatchObject({
      timeline_comments: [{ task_id: "task", text: edited }],
    });
  },
);

it.each(["pre-migration", "anchored"])(
  "%s の相談を取り消し、再送しても同じタスクに届く",
  async (mode) => {
    const { api, id, client, agent } = await fixture();
    await api.send(id, { text: "開始", images: [], mode: "send", clientMessageId: "start" });
    await expect.poll(() => agent.sent.length).toBe(1);
    const prefix = "タイムラインのタスク a「b「c」について: ";
    const body = "同じ表示でもa「bへの相談";
    const text = prefix + body;
    const task = "a「b";
    await api.send(id, {
      text,
      images: [],
      mode: "send",
      clientMessageId: "old",
      timeline_comments: [{ task_id: task, text: body }],
      ...(mode === "anchored"
        ? {
            timeline_anchors: [
              { task_id: task, from: 0, bodyFrom: prefix.length, to: text.length },
            ],
          }
        : {}),
    });
    const [item] = (await api.get(id)).queue;
    await api.deleteQueue(id, item.id);
    expect((await api.get(id)).draft?.text).toBe(text);
    expect((await api.get(id)).queue).toEqual([]);
    await api.stop(id);
    const peer = await client();
    await peer.controller.run("prompt.open");
    expect(peer.controller.promptText()).toBe(text);
    expect(await peer.controller.submitPrompt(text)).toBe(true);
    await expect.poll(() => agent.sent.at(-1)?.text).toBe(text);
    const delivered = (await api.events(id, 0)).events
      .filter(({ type }) => type === "user_message")
      .at(-1);
    expect(delivered?.payload).toMatchObject({
      text,
      timeline_comments: [{ task_id: task, text: body }],
    });
  },
);

it("本文の位置が分からない旧相談を保存して改稿を断り、別端末から元の ID と本文を送れる", async () => {
  const { api, id, client, agent } = await fixture();
  const send = (text: string, clientMessageId: string) =>
    api.send(id, { text, images: [], mode: "send", clientMessageId });
  await send("作業を始める", "start");
  await expect.poll(() => agent.sent.length).toBe(1);

  const text = "前置きを特定できない既存の発言";
  const comments = [
    { task_id: "a「b", text: "前の相談\n" },
    { task_id: "a", text: "次の相談  " },
  ];
  await api.send(id, {
    text,
    images: [],
    mode: "send",
    clientMessageId: "legacy",
    timeline_comments: comments,
  });
  const [legacy] = (await api.get(id)).queue;
  const edited = text.replace("既存", "編集済み");
  await expect(api.editQueue(id, legacy.id, { text: edited, images: [] })).rejects.toMatchObject({
    status: 409,
  });
  expect((await api.get(id)).queue[0]).toMatchObject({ text, timeline_comments: comments });

  await api.deleteQueue(id, legacy.id);
  const { controller, session } = await client();
  await controller.run("prompt.open");
  controller.setPromptDraft(edited);
  controller.snapshot().prompt!.change?.(edited);
  expect(await session.saveDraft()).toBe(true);
  expect(await controller.submitPrompt(edited)).toBe(false);
  expect(controller.snapshot().notice?.message).toContain("相談先を選び直してください");
  expect((await api.get(id)).draft?.text).toBe(edited);
  expect(agent.sent).toHaveLength(1);

  const peer = await client();
  await peer.controller.run("prompt.open");
  expect(peer.controller.promptText()).toBe(edited);
  peer.controller.setPromptDraft(text);
  peer.controller.snapshot().prompt!.change?.(text);
  await api.stop(id);
  expect(await peer.controller.submitPrompt(text)).toBe(true);
  await expect.poll(() => agent.sent.at(-1)?.text).toBe(text);
  expect(
    (await api.events(id, 0)).events.filter(({ type }) => type === "user_message").at(-1)?.payload,
  ).toMatchObject({ text, timeline_comments: comments });
});

it("別端末の相談は預かった段階では表示せず、割り込みや自動配達のあと詳細に反映する", async () => {
  const { api, id, agent, database, home, fetcher } = await fixture();
  const send = (
    text: string,
    clientMessageId: string,
    mode: "send" | "interrupt" = "send",
    timeline_comments?: { task_id: string; text: string }[],
  ) => api.send(id, { text, images: [], mode, clientMessageId, timeline_comments });
  await send("開始", "seed");
  await expect.poll(() => agent.sent.length).toBe(1);
  const directory = join(home, "timeline", "sessions");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, agent.sent[0].sessionId + ".json"),
    JSON.stringify({
      version: 1,
      journal: [{ at: 1, toolUseId: "plan", ops: [{ op: "add", id: "task", title: "集計" }] }],
      reports: [],
    }),
  );
  const getComments = async () => {
    const response = await fetcher(`/api/conversations/${id}/progress`);
    expect(response.status).toBe(200);
    return progressResponseSchema
      .parse(await response.json())
      .timeline?.comments.map(({ text }) => text);
  };
  expect(await getComments()).toEqual([]);

  const topic = `conversation:${id}` as const;
  const watcher = createTimelineWatch({
    database: database.sqlite,
    configDir: home,
    changed: (_id, seq) =>
      hub.publish({ topic, seq, type: "changed", payload: { parts: ["timeline"] } }),
  });
  cleanups.push(async () => watcher.close());
  const hub = new WsHub(database.sqlite, { timeline: watcher });
  const notices: ServerMessage[] = [];
  const peer = {
    bufferedAmount: 0,
    close: () => {},
    send: (data: string) => {
      const message = JSON.parse(data) as ServerMessage;
      notices.push(message);
    },
  };
  hub.add(peer);
  hub.receive(peer, { op: "subscribe", topic });
  let connected = false;
  const link = new RunnerLink({
    socket: join(home, "runner.sock"),
    log: () => {},
    notice: (notice) => hub.notice(notice),
    connection: (value) => {
      connected = value;
    },
  });
  cleanups.push(async () => link.stop());
  link.start();
  await expect.poll(() => connected).toBe(true);

  const queued = { task_id: "task", text: "注文を照合してください" };
  const interrupt = { task_id: "task", text: "取引先も照合してください" };
  const automatically = { task_id: "task", text: "納期も照合してください" };
  const timelineChanges = () =>
    notices.filter(
      (message) => message.type === "changed" && message.payload.parts?.includes("timeline"),
    );
  expect((await send(queued.text, "queued", "send", [queued])).result).toBe("queued");
  expect(await getComments()).toEqual([]);
  expect(timelineChanges()).toEqual([]);

  expect((await send(interrupt.text, "interrupt", "interrupt", [interrupt])).result).toBe(
    "delivered",
  );
  await expect.poll(() => timelineChanges().length).toBe(1);
  expect(await getComments()).toEqual([queued.text, interrupt.text]);

  await send("完了を待つ", "working", "interrupt", []);
  await expect.poll(() => agent.sent.at(-1)?.text).toBe("完了を待つ");
  expect((await send(automatically.text, "auto", "send", [automatically])).result).toBe("queued");
  expect(await getComments()).toEqual([queued.text, interrupt.text]);
  writeFileSync(join(home, "timeline-release"), "");
  await expect.poll(() => timelineChanges().length).toBe(2);
  expect(await getComments()).toEqual([queued.text, interrupt.text, automatically.text]);
}, 15_000);

async function cancelledInstruction(
  initial: string,
  queued: string,
  override?: (api: ConversationApi) => Partial<ConversationApi>,
) {
  const { api, id, client, agent, database } = await fixture();
  await api.send(id, { text: "開始", images: [], mode: "send", clientMessageId: "start" });
  await expect.poll(() => agent.sent.length).toBe(1);
  await api.send(id, { text: queued, images: [], mode: "send", clientMessageId: "next" });
  const [item] = (await api.get(id)).queue;
  await api.saveDraft(id, { text: initial, images: [], editedAt: 10, clientId: "peer" });
  const tab = await client(override?.(api));
  queueLine(tab.controller, item.id);
  await tab.controller.run("item.delete");
  const cancelled = (await api.get(id)).draft!;
  expect(cancelled.text).toBe([initial, queued].filter(Boolean).join("\n\n"));
  return { api, id, agent, cancelled, database, ...tab };
}

async function editOnTab(
  controller: BufferController,
  session: ConversationSession,
  change: { from: number; to?: number; insert: string },
) {
  await controller.run("prompt.open");
  const transaction = EditorState.create({ doc: controller.promptText() }).update({
    changes: change,
  });
  const text = transaction.state.doc.toString();
  controller.setPromptDraft(text);
  controller.snapshot().prompt!.change?.(text, transaction.changes);
  expect(await session.saveDraft()).toBe(true);
  controller.closePrompt();
  return text;
}

it("同じ本文を別の位置に追加したあと取り消しを戻すと、自分で追記した方だけ残る", async () => {
  const initial = "集計";
  const queued = "先に預けていた文";
  const { api, id, controller, session, cancelled } = await cancelledInstruction(initial, queued);
  await editOnTab(controller, session, { from: cancelled.text.length, insert: "\n\n" + queued });
  await controller.run("item.undo");
  const result = await api.get(id);
  expect(result.queue.map(({ text }) => text)).toEqual([queued]);
  expect(result.draft?.text).toBe(initial + "\n\n" + queued);
});

it("取り消した区間を変更したら、編集後の下書きを維持して預け直さない", async () => {
  const initial = "集計";
  const queued = "先に預けていた文";
  const { api, id, controller, session, cancelled } = await cancelledInstruction(initial, queued);
  const edited = await editOnTab(controller, session, {
    from: initial.length + 2,
    to: cancelled.text.length,
    insert: "配達前に直した本文",
  });
  await controller.run("item.undo");
  const result = await api.get(id);
  expect(result.queue).toEqual([]);
  expect(result.draft?.text).toBe(edited);
  expect(controller.snapshot().notice).toMatchObject({ kind: "error" });
});

it("別の端末が同じ本文を保存し直したあとも、元の取消操作で上書きしない", async () => {
  const { api, id, controller, cancelled } = await cancelledInstruction("集計", "先に預けていた文");
  const foreign = await api.saveDraft(id, {
    text: cancelled.text,
    images: cancelled.images,
    clientId: "foreign",
    editedAt: cancelled.updatedAt + 1,
  });
  await controller.run("item.undo");
  const result = await api.get(id);
  expect(result.draft).toEqual(foreign.draft);
  expect(result.queue).toEqual([]);
  expect(controller.snapshot().notice).toMatchObject({ kind: "error" });
});

it.each(["none", "replaced", "same text", "cleared"])(
  "復帰の受付直前に別端末の保存があると預け直さない (競合: $0)",
  async (race) => {
    let interleave = false;
    let peerText: string | undefined;
    let peer: ConversationDraft | null | undefined;
    const queued = "先に預けていた文";
    const { api, id, controller } = await cancelledInstruction(
      "別の書きかけ",
      queued,
      (actual) => ({
        send: async (conversationId, request) => {
          if (interleave && request.restoreDraft) {
            interleave = false;
            const receipt = (await actual.get(conversationId)).draft!;
            const driftedTime = receipt.updatedAt + 1;
            peerText =
              race === "replaced"
                ? "別の端末で追記した新しい相談"
                : race === "same text"
                  ? receipt.text
                  : "";
            expect(request.restoreDraft.replacement.updatedAt).toBeGreaterThan(driftedTime);
            const saved = await actual.saveDraft(conversationId, {
              text: peerText,
              images: [],
              editedAt: driftedTime,
              clientId: "peer-at-write",
            });
            expect(saved.applied).toBe(true);
            peer = saved.draft;
            expect((await actual.get(conversationId)).draft).toEqual(peer);
          }
          return actual.send(conversationId, request);
        },
      }),
    );
    interleave = race !== "none";
    await controller.run("item.undo");
    const result = await api.get(id);
    if (race !== "none") {
      expect(peer?.text ?? "").toBe(peerText);
      expect(controller.snapshot().notice).toMatchObject({ kind: "error" });
      expect({ draft: result.draft, queued: result.queue.map(({ text }) => text) }).toEqual({
        draft: peer,
        queued: [],
      });
    } else {
      expect(result.draft?.text).toBe("別の書きかけ");
      expect(result.queue.map(({ text }) => text)).toEqual([queued]);
    }
  },
);

it.each(["plain", "anchors-empty", "located", "legacy"])(
  "戻した $0 の末行に本文を続けても元の指示を預け直さない",
  async (mode) => {
    const { api, id, client, agent } = await fixture();
    const taskA = "別件の棚卸";
    const queuedPrefix = "タイムラインのタスク task-b「請求」について: ";
    const queuedBody = "請求の資料を読んで";
    const extension = "、内容も照合してください";
    const queued = mode === "located" ? queuedPrefix + queuedBody : queuedBody;
    const metadata =
      mode === "plain"
        ? {}
        : mode === "anchors-empty"
          ? { timeline_anchors: [], timeline_comments: [] }
          : {
              timeline_comments: [{ task_id: "task-b", text: queuedBody }],
              ...(mode === "located"
                ? {
                    timeline_anchors: [
                      {
                        task_id: "task-b",
                        from: 0,
                        bodyFrom: queuedPrefix.length,
                        to: queued.length,
                      },
                    ],
                  }
                : {}),
            };
    await api.send(id, { text: "開始", images: [], mode: "send", clientMessageId: "start" });
    await expect.poll(() => agent.sent.length).toBe(1);
    await api.send(id, {
      text: queued,
      images: [],
      mode: "send",
      clientMessageId: "next",
      ...metadata,
    });
    const [item] = (await api.get(id)).queue;
    const { controller, session } = await client();
    session.openConsultation({ id: "task-a", title: "棚卸" });
    const prefix = controller.promptText();
    const original = prefix + taskA;
    controller.setPromptDraft(original);
    controller.snapshot().prompt!.change?.(original);
    expect(await session.saveDraft()).toBe(true);
    controller.closePrompt();
    queueLine(controller, item.id);
    controller.update({ active: "main" });
    await controller.run("item.delete");
    const cancelled = (await api.get(id)).draft!;
    expect(cancelled.text).toBe(original + "\n\n" + queued);
    const edited = await editOnTab(controller, session, {
      from: cancelled.text.length,
      insert: extension,
    });
    const beforeUndo = (await api.get(id)).draft!;
    expect(beforeUndo.text).toBe(edited);
    if (mode === "located")
      expect(beforeUndo.timeline_anchors?.at(-1)).toMatchObject({
        task_id: "task-b",
        to: edited.length,
      });
    if (mode === "legacy")
      expect(beforeUndo.timeline_anchors?.at(-1)).toMatchObject({
        to: edited.length,
        originalText: queuedBody,
        comments: [{ task_id: "task-b", text: queuedBody }],
      });
    await controller.run("item.undo");
    const result = await api.get(id);
    expect({ draft: result.draft, queued: result.queue.map(({ text }) => text) }).toEqual({
      draft: beforeUndo,
      queued: [],
    });
  },
);

it.each(["別の書きかけ", ""])(
  "復帰の応答が途切れても同じ識別子で一度だけ戻す (初期本文: %s)",
  async (initial) => {
    const requests: Parameters<ConversationApi["send"]>[1][] = [];
    const queued = "先に預けていた文";
    const { api, id, controller } = await cancelledInstruction(initial, queued, (actual) => ({
      send: async (conversationId, body) => {
        const result = await actual.send(conversationId, body);
        if (body.restoreDraft) {
          requests.push(body);
          if (requests.length === 1) throw new Error("復帰の応答が届きませんでした");
        }
        return result;
      },
    }));
    await controller.run("item.undo");
    const stored = await api.get(id);
    expect(stored.queue.map(({ text }) => text)).toEqual([queued]);
    expect(stored.draft?.text ?? "").toBe(initial);
    expect(controller.snapshot().notice).toMatchObject({ kind: "error" });
    if (initial) {
      const written = await api.saveDraft(id, {
        text: "別の端末で保存",
        images: [],
        clientId: "peer-after-undo",
        editedAt: stored.draft!.updatedAt + 1,
      });
      expect(written.applied).toBe(true);
    }
    await controller.run("item.undo");
    expect(requests).toEqual([requests[0], requests[0]]);
    const retried = await api.get(id);
    expect(retried.queue).toEqual(stored.queue);
    expect(retried.draft?.text ?? "").toBe(initial ? "別の端末で保存" : "");
  },
);

it("復帰の受付では、時刻と書き手が同じでも相談の範囲が変わったら書きかけを保つ", async () => {
  const { api, id, database } = await fixture();
  const text = "前置きと本文";
  await api.saveDraft(id, {
    text,
    images: [],
    clientId: "tab",
    editedAt: 100,
    timeline_anchors: [{ task_id: "task-a", from: 0, bodyFrom: 3, to: text.length }],
  });
  const expectedDraft = (await api.get(id)).draft;
  const anchors = [{ task_id: "task-b", from: 0, bodyFrom: 3, to: text.length }];
  database.sqlite
    .prepare("UPDATE drafts SET timeline_anchors=? WHERE conversation_id=?")
    .run(JSON.stringify(anchors), id);
  await expect(
    api.send(id, {
      text: "預け直す指示",
      images: [],
      clientMessageId: "restoring",
      mode: "send",
      preserveDraft: true,
      restoreDraft: {
        expected: expectedDraft,
        replacement: { text: "書き換え", images: [], updatedAt: 101, updatedBy: "tab" },
      },
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect((await api.get(id)).draft).toEqual({ ...expectedDraft, timeline_anchors: anchors });
});

it.each([
  { initial: "", waitForChanged: true },
  { initial: "", waitForChanged: false },
  { initial: "別の書きかけ", waitForChanged: true },
])("復帰の通知と応答の順序 $initial $waitForChanged", async ({ initial, waitForChanged }) => {
  const queued = "先に預けていた文";
  let session: ConversationSession;
  const outcomes: unknown[] = [];
  const tab = await cancelledInstruction(initial, queued, (actual) => ({
    send: async (conversationId, body) => {
      const result = await actual.send(conversationId, body);
      if (body.restoreDraft) {
        outcomes.push(result);
        if (waitForChanged) {
          session.receive({
            type: "changed",
            topic: `conversation:${conversationId}`,
            seq: session.snapshot().data!.conversation.lastSeq,
            payload: { parts: ["draft", "queue"] },
          });
          await expect.poll(() => session.snapshot().data?.draft?.text ?? "").toBe(initial);
        }
      }
      return result;
    },
  }));
  session = tab.session;
  const { api, id, controller } = tab;
  expect(await session.saveDraft()).toBe(true);
  await session.refresh();
  expect(session.snapshot().data?.draft?.text).toBe([initial, queued].filter(Boolean).join("\n\n"));
  await controller.run("prompt.open");
  expect(controller.promptText()).toBe([initial, queued].filter(Boolean).join("\n\n"));
  controller.closePrompt();
  await session.saveDraft();
  const beforeUndo = (await api.get(id)).draft;
  expect(beforeUndo?.updatedBy).not.toBe("peer");
  expect(beforeUndo?.text).toBe([initial, queued].filter(Boolean).join("\n\n"));
  await controller.run("item.undo");
  const result = await api.get(id);
  expect(outcomes).toHaveLength(1);
  expect({ draft: result.draft?.text ?? "", queue: result.queue.map(({ text }) => text) }).toEqual({
    draft: initial,
    queue: [queued],
  });
});

it.each([
  { insert: "追記します。", shouldUndo: false },
  { insert: "別の独立段落\n\n", shouldUndo: true },
])("戻した文の先頭を編集して復帰する $shouldUndo", async ({ insert, shouldUndo }) => {
  const queued = "先に預けていた文";
  const { api, id, controller, session } = await cancelledInstruction("", queued);
  const edited = await editOnTab(controller, session, { from: 0, insert });
  expect(edited).toEqual(insert + queued);
  await controller.run("item.undo");
  const result = await api.get(id);
  expect({ draft: result.draft?.text, queue: result.queue.map(({ text }) => text) }).toEqual({
    draft: shouldUndo ? insert : edited,
    queue: shouldUndo ? [queued] : [],
  });
});

it.each(["plain", "anchors-empty", "located", "legacy"])(
  "戻した $0 の先頭に同じ行で本文を書いても元の指示を預け直さない",
  async (mode) => {
    const { api, id, client, agent } = await fixture();
    const queuedPrefix = "タイムラインのタスク task-b「請求」について: ";
    const queuedBody = "請求の資料を読んで";
    const extension = "急ぎのお願いです。";
    const queued = mode === "located" ? queuedPrefix + queuedBody : queuedBody;
    const metadata =
      mode === "plain"
        ? {}
        : mode === "anchors-empty"
          ? { timeline_anchors: [], timeline_comments: [] }
          : {
              timeline_comments: [{ task_id: "task-b", text: queuedBody }],
              ...(mode === "located"
                ? {
                    timeline_anchors: [
                      {
                        task_id: "task-b",
                        from: 0,
                        bodyFrom: queuedPrefix.length,
                        to: queued.length,
                      },
                    ],
                  }
                : {}),
            };
    await api.send(id, { text: "開始", images: [], mode: "send", clientMessageId: "start" });
    await expect.poll(() => agent.sent.length).toBe(1);
    await api.send(id, {
      text: queued,
      images: [],
      mode: "send",
      clientMessageId: "next",
      ...metadata,
    });
    const [item] = (await api.get(id)).queue;
    const { controller, session } = await client();
    queueLine(controller, item.id);
    controller.update({ active: "main" });
    await controller.run("item.delete");
    const cancelled = (await api.get(id)).draft!;
    expect(cancelled.text).toBe(queued);
    const edited = await editOnTab(controller, session, {
      from: 0,
      insert: extension,
    });
    const beforeUndo = (await api.get(id)).draft!;
    expect(beforeUndo.text).toBe(edited);
    expect(edited).toBe(extension + queued);
    if (mode === "located")
      expect(beforeUndo.timeline_anchors?.at(-1)).toMatchObject({
        task_id: "task-b",
        to: edited.length,
      });
    if (mode === "legacy")
      expect(beforeUndo.timeline_anchors?.at(-1)).toMatchObject({
        to: edited.length,
        originalText: queuedBody,
        comments: [{ task_id: "task-b", text: queuedBody }],
      });
    await controller.run("item.undo");
    const result = await api.get(id);
    expect({ draft: result.draft, queued: result.queue.map(({ text }) => text) }).toEqual({
      draft: beforeUndo,
      queued: [],
    });
  },
);

it.each(["working", "stopped"])(
  "復帰の受付が失敗したら書きかけと元の待ち行列を保つ (%s)",
  async (state) => {
    const { api, id, controller, database, cancelled, agent } = await cancelledInstruction(
      "",
      "預け直す",
    );
    if (state === "stopped") await api.stop(id);
    const target = state === "working" ? "queued_instructions" : "conversation_events";
    const predicate = state === "working" ? "NEW.text='預け直す'" : "NEW.type='user_message'";
    database.sqlite.exec(`CREATE TRIGGER deny_restore BEFORE INSERT ON ${target} WHEN ${predicate}
    BEGIN SELECT RAISE(ABORT,'復帰の受付を中止する'); END;`);
    await controller.run("item.undo");
    const failed = await api.get(id);
    expect(failed.draft).toEqual(cancelled);
    expect(failed.queue).toEqual([]);
    expect(agent.sent).toHaveLength(1);
    expect(controller.snapshot().notice).toMatchObject({ kind: "error" });

    database.sqlite.exec("DROP TRIGGER deny_restore");
    await controller.run("item.undo");
    const restored = await api.get(id);
    expect(restored.draft).toBeNull();
    if (state === "working") {
      expect(restored.queue.map(({ text }) => text)).toEqual(["預け直す"]);
      expect(agent.sent).toHaveLength(1);
    } else {
      expect(restored.queue).toEqual([]);
      await expect.poll(() => agent.sent.map(({ text }) => text)).toEqual(["開始", "預け直す"]);
    }
  },
);

it.each([
  { phase: "転送前", close: false },
  { phase: "転送前", close: true },
  { phase: "サーバー受付後", close: false },
  { phase: "サーバー受付後", close: true },
])(
  "復帰の$phaseに別件を書き足したとき、元指示だけを戻す (応答前に閉じる: $close)",
  async ({ phase, close }) => {
    const queued = "元の指示";
    const initial = "元からある書きかけ";
    const other = "別件の指示";
    const started = deferred();
    const release = deferred();
    const { api, id, controller } = await cancelledInstruction(initial, queued, (actual) => ({
      send: async (id, request) => {
        if (!request.restoreDraft) return actual.send(id, request);
        const accepted = phase === "サーバー受付後" ? await actual.send(id, request) : null;
        started.resolve();
        await release.promise;
        return accepted ?? (await actual.send(id, request));
      },
    }));
    const undo = controller.run("item.undo");
    try {
      await started.promise;
      await controller.run("prompt.open");
      const transaction = EditorState.create({ doc: controller.promptText() }).update({
        changes: { from: 0, insert: other + "\n\n" },
      });
      const text = transaction.state.doc.toString();
      controller.setPromptDraft(text);
      controller.snapshot().prompt!.change?.(text, transaction.changes);
      if (close) controller.closePrompt();
    } finally {
      release.resolve();
    }
    await undo;
    if (!close) {
      expect(controller.promptText()).toBe(other + "\n\n" + initial);
      controller.closePrompt();
    }
    const result = await api.get(id);
    expect(result.draft?.text).toBe(other + "\n\n" + initial);
    expect(result.queue.map(({ text }) => text)).toEqual([queued]);
  },
);

it("復帰待ちの間は元の行と送信を保護し、別相談の改稿と添付は保存する", async () => {
  const { api, id, client, agent } = await fixture();
  const started = deferred();
  const release = deferred();
  const png = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const attachment = (name: string) => new File([png], name, { type: "image/png" });
  const priorImage = (await api.upload(id, attachment("before.png"))).image.id;
  const queuedImage = (await api.upload(id, attachment("queued.png"))).image.id;
  const prefix = "タイムラインのタスク first「既存相談」について: ";
  const initial = prefix + "変更前";
  const queued = "元の指示";
  await api.send(id, { text: "開始", images: [], mode: "send", clientMessageId: "start" });
  await expect.poll(() => agent.sent.length).toBe(1);
  await api.send(id, {
    text: queued,
    images: [queuedImage],
    mode: "send",
    clientMessageId: "next",
  });
  await api.saveDraft(id, {
    text: initial,
    images: [priorImage],
    clientId: "peer",
    editedAt: 500,
    timeline_anchors: [{ task_id: "first", from: 0, bodyFrom: prefix.length, to: initial.length }],
  });
  let appendedImage = "";
  let sends = 0;
  const { controller } = await client({
    send: async (id, body) => {
      sends++;
      started.resolve();
      await release.promise;
      return api.send(id, body);
    },
    upload: async (id, file) => {
      const uploaded = await api.upload(id, file);
      appendedImage = uploaded.image.id;
      return uploaded;
    },
  });
  queueLine(controller, (await api.get(id)).queue[0].id);
  await controller.run("item.delete");
  const undo = controller.run("item.undo");
  const desired = prefix + "変更後の書きかけ";
  try {
    await started.promise;
    await controller.run("prompt.open");
    const prompt = controller.snapshot().prompt!;
    const state = EditorState.create({ doc: controller.promptText() });
    const touched = state.update({ changes: { from: state.doc.length, insert: "を変更" } });
    expect(prompt.allowChange?.(touched.newDoc.toString(), touched.changes)).toBe(false);
    expect(await controller.submitPrompt(state.doc.toString())).toBe(false);
    expect(await controller.submitPrompt(state.doc.toString(), true)).toBe(false);
    const edited = state.update({
      changes: { from: prefix.length, to: initial.length, insert: "変更後の書きかけ" },
    });
    expect(prompt.allowChange?.(edited.newDoc.toString(), edited.changes)).toBe(true);
    controller.setPromptDraft(edited.newDoc.toString());
    prompt.change?.(edited.newDoc.toString(), edited.changes);
    prompt.paste?.([attachment("appended.png")]);
    await expect.poll(() => controller.snapshot().prompt?.images).toBe(3);
    controller.closePrompt();
  } finally {
    release.resolve();
  }
  await undo;
  const result = await api.get(id);
  expect(result.draft).toMatchObject({
    text: desired,
    images: [priorImage, appendedImage],
    timeline_anchors: [{ task_id: "first", from: 0, bodyFrom: prefix.length, to: desired.length }],
  });
  expect(result.queue.map(({ text, images }) => ({ text, images }))).toEqual([
    { text: queued, images: [queuedImage] },
  ]);
  expect(sends).toBe(1);
});

it("復帰のあと別端末が保存していたら、自動保存で上書きせずこの端末の編集も入力欄に残す", async () => {
  const started = deferred();
  const release = deferred();
  const queued = "元の指示";
  const { api, id, controller } = await cancelledInstruction("", queued, (actual) => ({
    send: async (id, body) => {
      const result = await actual.send(id, body);
      const peer = await actual.saveDraft(id, {
        text: "別の端末で書いた内容",
        images: [],
        clientId: "later-peer",
        editedAt: body.restoreDraft!.replacement.updatedAt + 1,
      });
      expect(peer.applied).toBe(true);
      started.resolve();
      await release.promise;
      return result;
    },
  }));
  const undo = controller.run("item.undo");
  try {
    await started.promise;
    await controller.run("prompt.open");
    const change = EditorState.create({ doc: controller.promptText() }).update({
      changes: { from: 0, insert: "この端末の入力\n\n" },
    });
    controller.setPromptDraft(change.newDoc.toString());
    controller.snapshot().prompt!.change?.(change.newDoc.toString(), change.changes);
    controller.closePrompt();
  } finally {
    release.resolve();
  }
  await undo;
  const result = await api.get(id);
  expect(result.draft?.text).toBe("別の端末で書いた内容");
  expect(result.queue.map(({ text }) => text)).toEqual([queued]);
  await controller.run("prompt.open");
  expect(controller.promptText()).toBe("この端末の入力\n\n");
});

it("応答が途切れてからの別件の追記も、同じ復帰の結果を受け取って保存する", async () => {
  const requests: string[] = [];
  const queued = "元の指示";
  const { api, id, controller } = await cancelledInstruction("", queued, (actual) => ({
    send: async (id, body) => {
      const result = await actual.send(id, body);
      requests.push(body.clientMessageId);
      if (requests.length === 1) throw new Error("復帰の応答が届きませんでした");
      return result;
    },
  }));
  await controller.run("item.undo");
  await controller.run("prompt.open");
  const change = EditorState.create({ doc: controller.promptText() }).update({
    changes: { from: 0, insert: "応答を待つ間の追記\n\n" },
  });
  controller.setPromptDraft(change.newDoc.toString());
  controller.snapshot().prompt!.change?.(change.newDoc.toString(), change.changes);
  controller.closePrompt();
  await controller.run("item.undo");
  const result = await api.get(id);
  expect(result.draft?.text).toBe("応答を待つ間の追記\n\n");
  expect(result.queue.map(({ text }) => text)).toEqual([queued]);
  expect(requests).toEqual([requests[0], requests[0]]);
});

it.each([
  { response: "received", added: true, close: true },
  { response: "lost", added: false, close: true },
  { response: "lost", added: true, close: true },
  { response: "lost", added: true, close: false },
  { response: "competing save", added: true, close: true },
  { response: "lost twice", added: true, close: true },
])(
  "復帰後の保存結果 $response と後続編集 $added を順に確定する (閉じる: $close)",
  async ({ response, added, close }) => {
    const postStarted = deferred();
    const postRelease = deferred();
    const firstSaved = deferred();
    const firstRelease = deferred();
    const requests: Parameters<ConversationApi["saveDraft"]>[1][] = [];
    const queued = "元の指示";
    const first = "別件の指示\n\n";
    const second = "続けて追記した段落";
    const { api, id, controller, session } = await cancelledInstruction("", queued, (actual) => ({
      send: async (id, body) => {
        postStarted.resolve();
        await postRelease.promise;
        return actual.send(id, body);
      },
      saveDraft: async (id, request) => {
        if (!request.expectedDraft) return actual.saveDraft(id, request);
        requests.push(structuredClone(request));
        const result = await actual.saveDraft(id, request);
        if (requests.length === 1) {
          firstSaved.resolve();
          await firstRelease.promise;
          if (response !== "received") throw new TypeError("保存の応答を受け取れませんでした");
        }
        if (requests.length === 2 && response === "lost twice")
          throw new TypeError("再試行の応答を受け取れませんでした");
        return result;
      },
    }));
    function insert(from: number, text: string) {
      const next = EditorState.create({ doc: controller.promptText() }).update({
        changes: { from, insert: text },
      });
      controller.setPromptDraft(next.newDoc.toString());
      controller.snapshot().prompt!.change?.(next.newDoc.toString(), next.changes);
    }
    const undo = controller.run("item.undo");
    let scheduled: Promise<boolean> | undefined;
    try {
      await postStarted.promise;
      await controller.run("prompt.open");
      insert(0, first);
      postRelease.resolve();
      await firstSaved.promise;
      expect((await api.get(id)).draft?.text).toBe(first);
      expect(controller.promptText()).toBe(first);
      if (added) insert(first.length, second);
      if (response === "competing save") {
        const foreign = await api.saveDraft(id, {
          text: "別の端末が保存した内容",
          images: [],
          clientId: "other-tab",
          editedAt: requests[0].editedAt + 1,
        });
        expect(foreign.applied).toBe(true);
      }
      if (close) controller.closePrompt();
      else scheduled = session.saveDraft();
    } finally {
      postRelease.resolve();
      firstRelease.resolve();
    }
    await undo;
    if (scheduled) await scheduled;
    if (response === "lost twice") {
      expect(requests).toEqual([requests[0], requests[0]]);
      expect((await api.get(id)).draft?.text).toBe(first);
      expect(await session.saveDraft()).toBe(true);
    }
    const result = await api.get(id);
    expect(result.queue.map(({ text }) => text)).toEqual([queued]);
    if (response === "competing save") {
      expect(result.draft?.text).toBe("別の端末が保存した内容");
      expect(requests).toEqual([requests[0], requests[0]]);
      await controller.run("prompt.open");
      expect(controller.promptText()).toBe(first + second);
    } else {
      expect(result.draft?.text).toBe(first + (added ? second : ""));
      if (response === "lost" || response === "lost twice")
        expect(requests[1]).toEqual(requests[0]);
      if (response === "lost twice") expect(requests[2]).toEqual(requests[0]);
      expect(requests).toHaveLength(
        response === "lost twice" ? 4 : response === "lost" && added ? 3 : 2,
      );
      if (added)
        expect(requests.at(-1)?.expectedDraft).toMatchObject({
          text: first,
          updatedAt: requests[0].editedAt,
          updatedBy: requests[0].clientId,
        });
      const peer = await clientForReload();
      await peer.controller.run("prompt.open");
      expect(peer.controller.promptText()).toBe(first + (added ? second : ""));
    }

    async function clientForReload() {
      const reloaded = new BufferController();
      const connection = new ConversationSession(id, api, reloaded, {
        clientId: "test-reload",
        id: ulid,
        now: () => 4000,
        schedule: () => () => {},
      });
      await connection.load();
      const disconnect = connection.connect();
      cleanups.push(async () => disconnect());
      return { controller: reloaded };
    }
  },
);
