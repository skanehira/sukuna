import { ChangeSet } from "@codemirror/state";
import type { LineInfo } from "./line";
import { contentLines, contentText, TAIL_ORDER, type BufferContent, type BufferOp } from "./tail";
export function menuAt(
  lines: LineInfo[],
  number: number,
): { line: LineInfo; index: number } | null {
  return (
    lines.map((line, index) => ({ line, index })).filter(({ line }) => line.kind === "menu")[
      number - 1
    ] ?? null
  );
}
export function numberMenus(lines: LineInfo[], start = 1): LineInfo[] {
  let number = start;
  return lines.map((line) => {
    if (line.kind !== "menu") return line;
    const parts = line.cols ?? line.text.split(/ {2,}/);
    const fields = parts.length >= 3 && /^\d+$/.test(parts[0]) ? parts.slice(1) : parts;
    const cols = [String(number++), fields[0] ?? "", fields.slice(1).join("  ")];
    const text = cols.join("  ");
    return line.text === text && line.cols?.join("  ") === text ? line : { ...line, text, cols };
  });
}
export function numberMenuOperation(base: BufferContent, op: BufferOp): BufferOp {
  let number = 1;
  const numbered = (lines: LineInfo[]) => {
    const result = numberMenus(lines, number);
    number += lines.filter((line) => line.kind === "menu").length;
    return result;
  };
  const content: BufferContent = {
    committed: numbered(op.content.committed),
    tail: { reply: [], question: [], queue: [] },
  };
  for (const part of TAIL_ORDER) content.tail[part] = numbered(op.content.tail[part]);
  const original = contentLines(op.content);
  const next = contentLines(content);
  const corrections: { from: number; to: number; insert: string }[] = [];
  let offset = 0;
  let first = next.length;
  let last = 0;
  for (let index = 0; index < original.length; index += 1) {
    if (original[index].text !== next[index].text) {
      corrections.push({
        from: offset,
        to: offset + original[index].text.length,
        insert: next[index].text,
      });
      first = Math.min(first, index);
      last = index + 1;
    }
    offset += original[index].text.length + 1;
  }
  if (corrections.length === 0) return { ...op, content };
  const changes = ChangeSet.of(op.specs, contentText(base).length).compose(
    ChangeSet.of(corrections, contentText(op.content).length),
  );
  const specs: BufferOp["specs"] = [];
  changes.iterChanges((from, to, _nextFrom, _nextTo, insert) =>
    specs.push({ from, to, insert: insert.toString() }),
  );
  return {
    content,
    specs,
    rebuild: { from: Math.min(op.rebuild.from, first), to: Math.max(op.rebuild.to, last) },
  };
}
