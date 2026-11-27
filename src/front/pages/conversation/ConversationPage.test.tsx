import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { EditorView } from "@codemirror/view";
import { BufferController } from "../../buffer/controller";
import { Layout } from "../../buffer/Layout";
import { ConversationSession } from "../../lib/conversation/session";
import { createConversationApi } from "../../lib/conversation/api";
import type { ConversationApi, Event, Snapshot } from "../../lib/conversation/types";
import { ConversationPage } from "./ConversationPage";

const snapshot: Snapshot = {
  conversation: { id: "c1", projectId: "p1", projectName: "project", title: "予約 API", kind: "chat", issueId: null, parentConversationId: null, cwd: "/project", worktree: null, runState: "idle", stopReason: null, resetsAt: null, lastSeq: 0, lastReadSeq: 0, lastPosition: null, closedAt: null },
  draft: null, queue: [], pendingAnswers: null, pendingPermission: null,
  commands: [{ name: "/dev-spec", description: "設計を進める\n詳細" }, { name: "/review", description: "レビューする" }],
};
const question: Event = { seq: 1, createdAt: 0, type: "question", payload: { request_id: "q1", questions: [
  { question: "戻す方法は?", header: "方法", multi_select: false, options: [{ label: "A", description: "定期処理" }, { label: "B", description: "次の処理" }] },
  { question: "設定で変える?", header: "設定", multi_select: false, options: [{ label: "はい", description: "変えられる" }] },
] } };
function fakeApi(overrides: Partial<ConversationApi> = {}): ConversationApi {
  return {
    get: async () => structuredClone(snapshot), events: async () => ({ events: [], lastSeq: 0, hasMore: false }),
    projects: async () => [], start: async () => ({ conversation: snapshot.conversation }),
    send: vi.fn(async () => ({ result: "delivered", queueItem: null })), saveDraft: vi.fn(async (_id, body) => ({ draft: { text: body.text, images: body.images, updatedAt: body.editedAt, updatedBy: body.clientId }, applied: true })),
    saveAnswers: vi.fn(async (_id, questionSeq, answers) => ({ pendingAnswers: { questionSeq, answers } })), sendAnswers: vi.fn(async () => ({})),
    permission: async () => ({}), stop: async () => ({}), resume: async () => ({}), editQueue: async () => ({}), deleteQueue: vi.fn(async () => {}), sendStock: vi.fn(async () => ({})), upload: async () => ({ image: { id: "image-1" } }), ...overrides,
  };
}
async function mount(api = fakeApi(), events: Event[] = []) {
  const controller = new BufferController({ url: "/conversations/c1" });
  const session = new ConversationSession("c1", api, controller, { clientId: "tab", id: () => "message-id", now: () => 1000, schedule: (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } });
  await session.load();
  events.forEach((event) => session.receiveEvent(event));
  render(<Layout controller={controller} main={<ConversationPage session={session} />} />);
  await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
  return { session, api, controller };
}
function prompt(): EditorView { return EditorView.findFromDOM(screen.getByRole("textbox", { name: "指示" }))!; }
function main(): EditorView { return EditorView.findFromDOM(screen.getByRole("region", { name: "会話: 予約 API" }).querySelector(".cm-editor")!)!; }
function key(view: EditorView, key: string, extra = {}) { act(() => { fireEvent.keyDown(view.contentDOM, { key, ...extra }); }); }
async function flush() { await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); }); }
async function openLine(text: string) {
  await flush();
  const view = main();
  const line = Array.from({ length: view.state.doc.lines }, (_, i) => view.state.doc.line(i + 1)).find((line) => line.text === text || line.text.split("  ")[1] === text)!;
  expect(line).toBeDefined();
  act(() => view.dispatch({ selection: { anchor: line.from } }));
  key(view, "Enter");
  await flush();
}

describe("会話の画面", () => {
  it("（US-025）i で入力を開き、Normal の Esc で閉じても書きかけが残り、Normal の Enter で送れる", async () => {
    const { api, controller } = await mount();
    key(main(), "i");
    act(() => prompt().dispatch({ changes: { from: 0, insert: "作業を頼む" } }));
    key(prompt(), "Escape"); key(prompt(), "Escape");
    await flush();
    expect(api.saveDraft).toHaveBeenCalledWith("c1", { text: "作業を頼む", images: [], clientId: "tab", editedAt: 1000 });
    expect(controller.snapshot().notice).toEqual({ message: "書きかけを残しました。i で続きを書けます", kind: "info" });
    key(main(), "i");
    expect(prompt().state.doc.toString()).toBe("作業を頼む");
    key(prompt(), "Escape"); key(prompt(), "Enter"); await flush();
    expect(api.send).toHaveBeenCalledWith("c1", { text: "作業を頼む", images: [], mode: "send", clientMessageId: "message-id" });
    expect(controller.snapshot().prompt).toBeNull();
  });
  it("（US-046）/ の候補は前方一致と説明の一行目で表示し、Tab で選んだスキルをそのまま送る", async () => {
    const { api } = await mount(); key(main(), "i");
    act(() => prompt().dispatch({ changes: { from: 0, insert: "/de" } }));
    expect(screen.getByLabelText("スキルの候補").textContent).toBe("/dev-spec 設計を進めるTab で選ぶ");
    key(prompt(), "Tab"); key(prompt(), "Escape"); key(prompt(), "Enter"); await flush();
    expect(api.send).toHaveBeenCalledWith("c1", { text: "/dev-spec ", images: [], mode: "send", clientMessageId: "message-id" });
  });
  it("（US-015）503 の送信失敗で本文と未送信の理由が入力欄に残る", async () => {
    const api = fakeApi({ send: createConversationApi(async () => new Response(JSON.stringify({ error: { code: "runner_unavailable", message: "ランナーにつながりません" } }), { status: 503 })).send });
    await mount(api); key(main(), "i");
    act(() => prompt().dispatch({ changes: { from: 0, insert: "残す指示" } }));
    key(prompt(), "Escape"); key(prompt(), "Enter"); await flush();
    expect(prompt().state.doc.toString()).toBe("残す指示");
    expect(screen.getByText("未送信: ランナーにつながりません", { exact: true })).toBeInTheDocument();
  });
  it("（US-014）delta を末尾へ逐次追加し、保存した発言が届くと一度だけ表示し、番の終わりでも消す", async () => {
    const { session } = await mount();
    act(() => { session.delta("調べ"); session.delta("ています"); }); await flush();
    expect(main().state.doc.toString()).toBe("AI\n調べています");
    act(() => session.receiveEvent({ seq: 1, createdAt: 0, type: "assistant_text", payload: { text: "調べました", parent_tool_use_id: null } })); await flush();
    expect(main().state.doc.toString()).toBe("AI\n調べました");
    act(() => session.delta("続き")); await flush();
    expect(main().state.doc.toString()).toBe("AI\n調べました\nAI\n続き");
    act(() => session.receiveEvent({ seq: 2, createdAt: 0, type: "turn_end", payload: { subtype: "success", usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, cost_usd: 0, duration_ms: 0, permission_denials: 0 } })); await flush();
    expect(main().state.doc.toString()).toBe("AI\n調べました");
  });
  it("（US-016）選択は保存だけを行い、もう一度 Enter で外れ、未回答を残して送ると y の確認を出す", async () => {
    const { api, controller } = await mount(fakeApi(), [question]);
    await openLine("A");
    expect(api.saveAnswers).toHaveBeenLastCalledWith("c1", 1, { "0": { choices: ["A"], text: null } });
    expect(main().state.doc.line(2).text).toBe("1  A  ✓ 選んだ (まだ送っていない)");
    expect(api.sendAnswers).toHaveBeenCalledTimes(0);
    await openLine("A");
    expect(api.saveAnswers).toHaveBeenLastCalledWith("c1", 1, { "0": { choices: [], text: null } });
    await openLine("B"); await openLine("回答をまとめて送る (1 / 2 件)");
    expect(screen.getByLabelText("操作の確認").textContent).toBe("答えていない質問が 1 件あります。このまま送りますか? (y / n)");
    key(main(), "y"); await flush();
    expect(api.sendAnswers).toHaveBeenCalledWith("c1", true);
    expect(controller.snapshot().notice).toEqual({ message: "回答 1 件を 1 通にまとめて送りました", kind: "info" });
  });
  it.each([null, "stock-1"])("届く前の指示を dd で取り消し、u で同じ本文か同じストック %s を預け直す", async (stockItemId) => {
    const queued = { id: "queue-1", text: "後の指示", images: [], position: 1, stockItemId, clientId: null, createdAt: 0 };
    const api = fakeApi({ get: async () => ({ ...snapshot, queue: [queued] }) });
    const { controller } = await mount(api);
    const view = main();
    const row = Array.from({ length: view.state.doc.lines }, (_, i) => view.state.doc.line(i + 1)).find((line) => line.text === "届く前の指示: 後の指示")!;
    act(() => view.dispatch({ selection: { anchor: row.from } })); key(view, "d"); key(view, "d"); await flush();
    expect(api.deleteQueue).toHaveBeenCalledWith("c1", "queue-1");
    expect(controller.snapshot().notice).toEqual({ message: "預けた指示を取り消しました。u で戻せます", kind: "info" });
    key(view, "u"); await flush();
    if (stockItemId) expect(api.sendStock).toHaveBeenCalledWith("c1", "stock-1");
    else expect(api.send).toHaveBeenCalledWith("c1", { text: "後の指示", images: [], mode: "send", clientMessageId: "message-id" });
  });
});
