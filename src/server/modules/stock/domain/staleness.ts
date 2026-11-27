import type { Quote } from "../../../../shared/stock";

export function isStale(quote: Quote, content: string | undefined): boolean {
  if (quote.kind !== "file") return false;
  if (content === undefined) return true;
  const { start, end, mode } = quote;
  const lines = content.split("\n");
  if (start.line > end.line || end.line > lines.length) return true;
  const selected = lines.slice(start.line - 1, end.line);
  if (mode === "line") return selected.join("\n") !== quote.text;
  if (mode === "block")
    return selected.map((line) => line.slice(start.col, end.col)).join("\n") !== quote.text;
  if (start.col > selected[0].length || end.col > selected[selected.length - 1].length) return true;
  selected[selected.length - 1] = selected[selected.length - 1].slice(0, end.col);
  selected[0] = selected[0].slice(start.col);
  return selected.join("\n") !== quote.text;
}
