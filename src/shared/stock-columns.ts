export function codePointEdge(text: string, column: number, upper: boolean): number {
  const value = Math.max(0, Math.min(column, text.length));
  const before = text.charCodeAt(value - 1);
  const after = text.charCodeAt(value);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
    return value + (upper ? 1 : -1);
  return value;
}

export function sliceStockBlockLine(text: string, from: number, to: number): string {
  return text.slice(codePointEdge(text, from, false), codePointEdge(text, to, true));
}
