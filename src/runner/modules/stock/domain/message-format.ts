import type { Quote } from "../../../../shared/stock";

export type StockMessageItem = { quote: Quote; text: string; stale?: boolean };

const activeNotice =
  "(元の会話の AI は、このスレッドを始めた時点で作業を続けています。記録で中断と出ているツールの呼び出しは、元の会話で動いています。やり直さないでください。ファイルは元の会話と共有しています。)";

function lines(start: number, end: number): string {
  return start === end ? `${start} 行目` : `${start}〜${end} 行目`;
}

function sideName(side: "old" | "new"): string {
  return side === "old" ? "変更前" : "変更後";
}

function location(quote: Quote, stale: boolean): string {
  switch (quote.kind) {
    case "conversation":
      return "この会話の発言から";
    case "file":
      return `${quote.path} ${lines(quote.start.line, quote.end.line)}${stale ? " (引用した時点の内容。いまのファイルとは違います)" : ""}`;
    case "design_diff":
      return `設計書の差分 ${quote.path} ${lines(quote.start.line, quote.end.line)}`;
    case "pr_diff": {
      const from = sideName(quote.start.side);
      const range =
        quote.start.side === quote.end.side
          ? `${from} ${lines(quote.start.line, quote.end.line)}`
          : `${from} ${quote.start.line} 行目〜${sideName(quote.end.side)} ${quote.end.line} 行目`;
      return `PR の差分 ${quote.path} ${range} (${quote.commit.slice(0, 7)})`;
    }
    case "terminal":
      return "ターミナルの出力から";
  }
}

export function formatStockItem({ quote, text, stale = false }: StockMessageItem): string {
  const citation = quote.text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${location(quote, stale)}\n${citation}\n${text}`;
}

export function formatStockInstructions(items: readonly StockMessageItem[]): string {
  const lines = items.map((item, index) => `${index + 1}. ${formatStockItem(item)}`);
  return [`ストックした指示が ${items.length} 件あります。順に対応してください。`, ...lines].join(
    "\n\n",
  );
}

export function formatThreadQuestion(item: StockMessageItem, parentActive: boolean): string {
  const body = `次の箇所について質問です。\n\n${formatStockItem(item)}`;
  return parentActive ? `${activeNotice}\n\n${body}` : body;
}
