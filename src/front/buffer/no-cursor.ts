import { isWhitespaceOnly, type LineInfo, type LineKind } from "./line";

const NEVER_PLACEABLE: ReadonlySet<LineKind> = new Set<LineKind>([
  "speaker",
  "separator",
  "colhead",
]);

export function canPlaceCursor(line: LineInfo): boolean {
  if (NEVER_PLACEABLE.has(line.kind)) return false;
  if ((line.kind === "heading" || line.kind === "section") && line.target === undefined) {
    return false;
  }
  return !isWhitespaceOnly(line);
}

function search(lines: LineInfo[], from: number, direction: 1 | -1): number | null {
  for (let index = from; index >= 0 && index < lines.length; index += direction) {
    if (canPlaceCursor(lines[index])) return index;
  }
  return null;
}

export function placeCursor(lines: LineInfo[], previous: number, next: number): number {
  if (next >= 0 && next < lines.length && canPlaceCursor(lines[next])) return next;
  const direction: 1 | -1 = next < previous ? -1 : 1;
  const forward = search(lines, next + direction, direction);
  if (forward !== null) return forward;
  const backward = search(lines, next - direction, -direction as 1 | -1);
  if (backward !== null) return backward;
  return 0;
}

export function initialLine(lines: LineInfo[], startLine: number | undefined): number {
  if (startLine !== undefined && startLine >= 0 && startLine < lines.length) {
    if (canPlaceCursor(lines[startLine])) return startLine;
    const down = search(lines, startLine + 1, 1);
    if (down !== null) return down;
    const up = search(lines, startLine - 1, -1);
    if (up !== null) return up;
    return 0;
  }
  const first = search(lines, 0, 1);
  return first ?? 0;
}
