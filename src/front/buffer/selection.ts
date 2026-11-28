export type SelectedRange = { line: number; from: number; to: number };
export type BufferSelection = {
  mode: "char" | "line" | "block";
  ranges: SelectedRange[];
  block?: { from: number; to: number };
};
