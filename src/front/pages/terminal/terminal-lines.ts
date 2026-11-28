type TerminalLine = {
  length: number;
  isWrapped: boolean;
  getCell(index: number): { getChars(): string; getWidth(): number } | undefined;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
};

type TerminalBuffer = {
  length: number;
  baseY: number;
  cursorY: number;
  getLine(index: number): TerminalLine | undefined;
};

export function terminalLines(buffer: TerminalBuffer): string[] {
  const lines: string[] = [];
  let last = 0;
  for (let index = 0; index < buffer.length; index++) {
    const row = buffer.getLine(index);
    if (!row) continue;
    const following = index + 1 < buffer.length ? buffer.getLine(index + 1) : undefined;
    const lastCell = row.getCell(row.length - 1);
    const wideWrapPadding =
      following?.isWrapped &&
      following.getCell(0)?.getWidth() === 2 &&
      lastCell?.getWidth() === 1 &&
      lastCell.getChars() === "";
    const text = row.translateToString(false, 0, wideWrapPadding ? row.length - 1 : undefined);
    if (row.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
    if (index <= buffer.baseY + buffer.cursorY || text.trimEnd() !== "") last = lines.length;
  }
  return lines.slice(0, last).map((line) => line.trimEnd());
}
