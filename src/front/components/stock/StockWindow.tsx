import { useMemo, useSyncExternalStore } from "react";
import type { Quote, StockItem } from "../../../shared/stock";
import { Frame } from "../../buffer/Frame";
import type { LineInfo } from "../../buffer/line";
import type { StockSession } from "../../lib/stock/session";
import { FileBuffer } from "../files/FileBuffer";

export const stockView = "stock-list";

const firstLine = (value: string) => value.split(/\r?\n/, 1)[0];

export function quoteSummary(quote: Quote): string {
  switch (quote.kind) {
    case "conversation":
      return "会話";
    case "file":
      return `${quote.path}:${quote.start.line}`;
    case "design_diff":
      return `設計 ${quote.path}:${quote.start.line}`;
    case "pr_diff":
      return `PR ${quote.path}:${quote.start.line}`;
    case "terminal":
      return "ターミナル";
  }
}

export function quotePreview(quote: Quote): LineInfo[] {
  return quote.text
    .split("\n")
    .slice(0, 2)
    .map((value) => ({ kind: "note", text: `    > ${value}` }));
}

export function StockWindow({
  stock,
  title,
  jump,
}: {
  stock: StockSession;
  title: string;
  jump(this: void, item: StockItem): void | Promise<void>;
}) {
  const state = useSyncExternalStore(stock.subscribe, stock.snapshot, stock.snapshot);
  const lines = useMemo(() => {
    const items = state.items.filter((item) => item.state === "stocked");
    const questions = items.filter((item) => item.kind === "question").length;
    const rows: LineInfo[] = items.flatMap((item): LineInfo[] => [
      {
        kind: "row",
        id: item.id,
        text: `${item.kind === "instruction" ? "!" : "?"} ${quoteSummary(item.quote)} ${firstLine(item.text)}${item.githubCommentUrl ? "  GitHub に投稿済み" : ""}`,
        open: () => jump(item),
      },
      ...quotePreview(item.quote),
      ...(item.stale
        ? [
            {
              kind: "note" as const,
              text: "    箇所が古くなっています (保存した引用の文を出しています)",
            },
          ]
        : []),
    ]);
    if (state.errors.stock) rows.push({ kind: "note", text: firstLine(state.errors.stock) });
    else if (!state.loaded.stock) rows.push({ kind: "skeleton", text: "読み込み中" });
    else if (!items.length)
      rows.push(
        { kind: "note", text: "この会話のストックはありません。" },
        { kind: "note", text: "箇所を選び、Space q で質問、Space c で指示を書きます。" },
      );
    if (items.length)
      rows.push(
        { kind: "section", text: `送る (送り先: ${title})` },
        {
          kind: "menu",
          text: `全部送る (${items.length} 件)`,
          open: () => stock.send(title, "all"),
          main: true,
        },
        {
          kind: "menu",
          text: `質問だけ送る (${questions} 件)`,
          open: () => stock.send(title, "questions"),
        },
        {
          kind: "menu",
          text: `指示だけ送る (${items.length - questions} 件)`,
          open: () => stock.send(title, "instructions"),
        },
      );
    return rows;
  }, [state, stock, title, jump]);
  return (
    <Frame title={`ストック: ${title}`} side="right">
      <FileBuffer
        side="right"
        viewName={stockView}
        lines={lines}
        placement={state.placement}
        ready={state.loaded.stock || state.errors.stock !== undefined}
      />
    </Frame>
  );
}
