import { useMemo, useSyncExternalStore } from "react";
import type { Thread } from "../../../shared/stock";
import { Frame } from "../../buffer/Frame";
import type { LineInfo } from "../../buffer/line";
import type { StockSession } from "../../lib/stock/session";
import { FileBuffer } from "../files/FileBuffer";
import { quotePreview } from "./StockWindow";

export const threadListView = "stock-thread-list";
const states = {
  idle: "指示待ち",
  working: "作業中",
  waiting_answer: "判断待ち",
  waiting_permission: "判断待ち",
  stopped: "止まった",
  failed: "失敗",
  usage_limited: "利用枠切れ",
} satisfies Record<Thread["runState"], string>;
export function ThreadList({
  stock,
  title,
  open,
}: {
  stock: StockSession;
  title: string;
  open(this: void, thread: Thread): void;
}) {
  const state = useSyncExternalStore(stock.subscribe, stock.snapshot, stock.snapshot);
  const lines = useMemo(() => {
    const rows: LineInfo[] = state.threads.flatMap((thread): LineInfo[] => [
      {
        kind: "row",
        id: thread.id,
        text: `${thread.closedAt === null ? "»" : "✓"} ${thread.title ?? "無題"}  ${thread.closedAt === null ? states[thread.runState] : "終了"}`,
        open: () => open(thread),
      },
      ...quotePreview(thread.quote),
    ]);
    if (state.errors.threads)
      rows.push({ kind: "note", text: state.errors.threads.split("\n", 1)[0] });
    else if (!state.loaded.threads) rows.push({ kind: "skeleton", text: "読み込み中" });
    else if (!rows.length) rows.push({ kind: "note", text: "この会話にスレッドはありません。" });
    return rows;
  }, [state, open]);
  return (
    <Frame title={`スレッド: ${title}`} side="right">
      <FileBuffer
        side="right"
        viewName={threadListView}
        lines={lines}
        ready={state.loaded.threads || state.errors.threads !== undefined}
      />
    </Frame>
  );
}
