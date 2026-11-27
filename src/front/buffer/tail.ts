import type { LineInfo } from "./line";

export type TailPart = "reply" | "question" | "queue";

export const TAIL_ORDER: readonly TailPart[] = ["reply", "question", "queue"];

export type BufferContent = {
  committed: LineInfo[];
  tail: Record<TailPart, LineInfo[]>;
};

export type ChangeSpec = { from: number; to: number; insert: string };

export type LineRange = { from: number; to: number };

export type BufferOp = {
  content: BufferContent;
  specs: ChangeSpec[];
  rebuild: LineRange;
};

function emptyTail(): Record<TailPart, LineInfo[]> {
  return { reply: [], question: [], queue: [] };
}

export function createContent(lines: LineInfo[]): BufferContent {
  return { committed: [...lines], tail: emptyTail() };
}

export function contentLines(content: BufferContent): LineInfo[] {
  const lines = [...content.committed];
  for (const part of TAIL_ORDER) {
    const partLines = content.tail[part];
    if (partLines.length > 0) lines.push(...partLines);
  }
  return lines;
}

export function contentText(content: BufferContent): string {
  return contentLines(content)
    .map((line) => line.text)
    .join("\n");
}

function tailLineCount(content: BufferContent): number {
  return TAIL_ORDER.reduce((count, part) => count + content.tail[part].length, 0);
}

export function lineOffset(content: BufferContent, line: number): number {
  const lines = contentLines(content);
  if (line >= lines.length) return contentText(content).length;
  let offset = 0;
  for (let index = 0; index < line; index += 1) offset += lines[index].text.length + 1;
  return offset;
}

export function tailPartRange(content: BufferContent, part: TailPart): LineRange {
  let from = content.committed.length;
  for (const name of TAIL_ORDER) {
    if (name === part) return { from, to: from + content.tail[name].length };
    from += content.tail[name].length;
  }
  return { from, to: from };
}

function lineRangeChange(
  content: BufferContent,
  from: number,
  to: number,
  newLines: LineInfo[],
): ChangeSpec {
  const total = contentLines(content).length;
  const fromOffset = lineOffset(content, from);
  const toOffset = lineOffset(content, to);
  const insert = newLines.map((line) => line.text).join("\n");

  if (newLines.length === 0) {
    if (from === to) return { from: fromOffset, to: fromOffset, insert: "" };
    if (to < total) return { from: fromOffset, to: toOffset, insert: "" };
    if (from === 0) return { from: 0, to: contentText(content).length, insert: "" };
    return { from: fromOffset - 1, to: contentText(content).length, insert: "" };
  }

  if (from === to) {
    if (from === total) {
      return {
        from: fromOffset,
        to: fromOffset,
        insert: (total > 0 ? "\n" : "") + insert,
      };
    }
    return { from: fromOffset, to: fromOffset, insert: `${insert}\n` };
  }

  return { from: fromOffset, to: toOffset, insert: insert + (to < total ? "\n" : "") };
}

function usedSpecs(specs: ChangeSpec[]): ChangeSpec[] {
  return specs.filter((spec) => spec.from !== spec.to || spec.insert !== "");
}

export function appendLines(
  content: BufferContent,
  lines: LineInfo[],
  clearTail: readonly TailPart[] = [],
): BufferOp {
  const committed = content.committed.length;
  const tail = { ...content.tail };
  const clearedRanges: LineRange[] = [];

  for (const part of TAIL_ORDER) {
    const range = tailPartRange(content, part);
    if (clearTail.includes(part) && range.to > range.from) {
      const previous = clearedRanges.at(-1);
      if (previous !== undefined && previous.to === range.from) previous.to = range.to;
      else clearedRanges.push(range);
    }
    if (clearTail.includes(part)) tail[part] = [];
  }

  const specs: ChangeSpec[] = [];
  let mergedTo = committed;
  const firstCleared = clearedRanges.find((range) => range.from === committed);
  if (firstCleared !== undefined) mergedTo = firstCleared.to;
  specs.push(lineRangeChange(content, committed, mergedTo, lines));
  for (const range of clearedRanges) {
    if (range.from === committed) continue;
    specs.push(lineRangeChange(content, range.from, range.to, []));
  }

  const next: BufferContent = {
    committed: [...content.committed, ...lines],
    tail,
  };
  return {
    content: next,
    specs: usedSpecs(specs),
    rebuild: { from: Math.max(0, committed - 1), to: next.committed.length + tailLineCount(next) },
  };
}

export function setTailLines(content: BufferContent, part: TailPart, lines: LineInfo[]): BufferOp {
  const range = tailPartRange(content, part);
  const next: BufferContent = {
    committed: content.committed,
    tail: { ...content.tail, [part]: [...lines] },
  };
  const nextRange = tailPartRange(next, part);
  const total = next.committed.length + tailLineCount(next);
  return {
    content: next,
    specs: usedSpecs([lineRangeChange(content, range.from, range.to, lines)]),
    rebuild: { from: Math.max(0, nextRange.from - 1), to: Math.min(total, nextRange.to + 1) },
  };
}

export function replaceLines(
  content: BufferContent,
  from: number,
  to: number,
  lines: LineInfo[],
): BufferOp {
  const start = Math.max(0, Math.min(from, content.committed.length));
  const end = Math.max(start, Math.min(to, content.committed.length));
  const next: BufferContent = {
    committed: [...content.committed.slice(0, start), ...lines, ...content.committed.slice(end)],
    tail: content.tail,
  };
  const total = next.committed.length + tailLineCount(next);
  return {
    content: next,
    specs: usedSpecs([lineRangeChange(content, start, end, lines)]),
    rebuild: {
      from: Math.max(0, start - 1),
      to: Math.min(total, start + lines.length + 1),
    },
  };
}

export function replaceAllLines(content: BufferContent, lines: LineInfo[]): BufferOp {
  const next: BufferContent = { committed: [...lines], tail: content.tail };
  const total = next.committed.length + tailLineCount(next);
  return {
    content: next,
    specs: usedSpecs([lineRangeChange(content, 0, content.committed.length, lines)]),
    rebuild: { from: 0, to: total },
  };
}
