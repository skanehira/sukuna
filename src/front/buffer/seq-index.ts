import type { LineInfo } from "./line";

export function findSeqLine(lines: LineInfo[], seq: number, seqLine?: number): number | null {
  const positions: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].seq === seq) positions.push(index);
  }
  if (seqLine === undefined) return positions[0] ?? null;
  return positions[seqLine] ?? null;
}
