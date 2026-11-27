import { expect, it, vi } from "vite-plus/test";
import { BufferController } from "../../buffer/controller";
import type { StockItem } from "../../../shared/stock";
import type { StockApi } from "./api";
import { StockSession } from "./session";

const quote = {
  kind: "file",
  mode: "line",
  text: "first",
  path: "a.ts",
  start: { line: 1, col: 0 },
  end: { line: 1, col: 5 },
} as const;
const saved: StockItem = {
  id: "stock-1",
  conversationId: "c",
  kind: "instruction",
  text: "次を直す",
  quote,
  state: "stocked",
  stale: false,
  sentAt: null,
  sentSeq: null,
  thread: null,
  githubCommentUrl: null,
};
const api = (): StockApi => {
  let items: StockItem[] = [];
  return {
    list: vi.fn(async () => items),
    threads: vi.fn(async () => []),
    add: vi.fn(async () => {
      items = [saved];
      return saved;
    }),
    edit: vi.fn(async () => saved),
    cancel: vi.fn(async () => ({ ...saved, state: "cancelled" as const })),
    restore: vi.fn(async () => saved),
    send: vi.fn(async () => ({ instructions: { count: 0, delivery: null }, questions: [] })),
    propose: vi.fn(async () => null),
    close: vi.fn(async () => ({ id: "t", closedAt: 1 })),
    finish: vi.fn(async () => ({ item: saved, thread: { id: "t", closedAt: 1 } })),
  };
};

it("入力中に›を出し、送信後は選んだ本文と引用を保存して!に切り替える", async () => {
  const controller = new BufferController();
  const port = api();
  const stock = new StockSession("c", port, controller);
  stock.compose("instruction", "会話", quote);
  expect(controller.snapshot().prompt?.quote).toEqual(["first"]);
  expect(stock.snapshot().draft?.quote).toEqual(quote);
  controller.setPromptDraft("次を直す");
  expect(await controller.submitPrompt("次を直す")).toBe(true);
  expect(port.add).toHaveBeenCalledWith("c", { kind: "instruction", text: "次を直す", quote });
  expect(stock.snapshot().draft).toBeUndefined();
  expect(stock.snapshot().items).toEqual([saved]);
  expect(controller.snapshot().notice).toEqual({
    kind: "info",
    message: "指示をストックしました。続けて別の箇所にも書けます",
  });
});

it("入力を閉じると書いた質問を捨てて印を消す", () => {
  const controller = new BufferController();
  const port = api();
  const stock = new StockSession("c", port, controller);
  stock.compose("question", "会話", quote);
  controller.closePrompt("質問の書きかけ");
  expect(controller.snapshot().notice).toEqual({ kind: "info", message: "質問の入力をやめました" });
  expect(stock.snapshot().draft).toBeUndefined();
  expect(port.add).not.toHaveBeenCalled();
});

it("空とAPIの失敗では入力欄と選んだ箇所を残す", async () => {
  const controller = new BufferController();
  const port = api();
  vi.mocked(port.add).mockRejectedValue(new Error("この指示はすでに送っています"));
  const stock = new StockSession("c", port, controller);
  stock.compose("instruction", "会話", quote);
  expect(await controller.submitPrompt(" ")).toBe(false);
  expect(controller.snapshot().notice).toEqual({
    kind: "error",
    message: "内容が空です。書いてからストックしてください",
  });
  expect(await controller.submitPrompt("別のタブも編集中")).toBe(false);
  expect(controller.snapshot().notice).toEqual({
    kind: "error",
    message: "この指示はすでに送っています",
  });
  expect(stock.snapshot().draft?.quote).toEqual(quote);
  expect(controller.snapshot().prompt?.label).toBe("指示");
});

it("送った質問と預けた指示の件数を送り先とともに知らせる", async () => {
  const controller = new BufferController();
  const port = api();
  vi.mocked(port.send).mockResolvedValue({
    questions: [{ ok: true, stockId: "question", threadId: "thread" }],
    instructions: { count: 2, delivery: "queued" },
  });
  const stock = new StockSession("c", port, controller);
  await stock.send("在庫の会話", "all");
  expect(port.send).toHaveBeenCalledWith("c", { kinds: "all" });
  expect(controller.snapshot().notice).toEqual({
    kind: "info",
    message:
      "在庫の会話 に送りました: 質問 1 件 (質問ごとにスレッドが始まります)、指示 2 件 (今の作業が終わると届きます)",
  });
});

it("スレッドを始められなかった質問を残し、サーバーの理由を知らせる", async () => {
  const controller = new BufferController();
  const port = api();
  const question: StockItem = { ...saved, kind: "question", text: "期限は何分ですか" };
  vi.mocked(port.list).mockResolvedValue([question]);
  vi.mocked(port.send).mockResolvedValue({
    questions: [
      {
        ok: false,
        stockId: question.id,
        error: { code: "no_session", message: "会話の応答がありません" },
      },
    ],
    instructions: { count: 0, delivery: null },
  });
  const stock = new StockSession("c", port, controller);
  await stock.send("在庫の会話", "questions");
  expect(port.send).toHaveBeenCalledWith("c", { kinds: "questions" });
  expect(stock.snapshot().items).toEqual([question]);
  expect(controller.snapshot().notice).toEqual({
    kind: "error",
    message:
      "質問 1 件はスレッドを始められませんでした。ストックに残しています: 会話の応答がありません",
  });
});
