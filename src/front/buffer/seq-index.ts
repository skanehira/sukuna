import type { LineInfo } from "./line";

export function findSeqLine(lines: LineInfo[], seq: number, seqLine?: number): number | null {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.seq === seq && (seqLine === undefined || line.seqLine === seqLine)) return index;
  }
  return null;
}
