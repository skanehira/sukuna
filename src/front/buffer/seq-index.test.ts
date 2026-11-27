import { describe, expect, it } from "vite-plus/test";
import type { LineInfo } from "./line";
import { findSeqLine } from "./seq-index";

function line(text: string, extra: Partial<LineInfo> = {}): LineInfo {
  return { kind: "text", text, ...extra };
}

const lines: LineInfo[] = [
  line("はじめに"),
  line("1 行目の発言", { seq: 3, seqLine: 0 }),
  line("1 行目の発言の続き", { seq: 3, seqLine: 1 }),
  line("ツールの実行", { seq: 4 }),
  line("2 行目の発言", { seq: 3, seqLine: 2 }),
];

describe("findSeqLine", () => {
  it("seq を渡すと、そのイベントの最初の行の行番号を返す", () => {
    expect(findSeqLine(lines, 3)).toBe(1);
    expect(findSeqLine(lines, 4)).toBe(3);
  });

  it("seq と何行目かを渡すと、その行の行番号を返す", () => {
    expect(findSeqLine(lines, 3, 0)).toBe(1);
    expect(findSeqLine(lines, 3, 1)).toBe(2);
    expect(findSeqLine(lines, 3, 2)).toBe(4);
  });

  it("その seq の行が無ければ、見つからないことを返す", () => {
    expect(findSeqLine(lines, 99)).toBeNull();
    expect(findSeqLine(lines, 3, 3)).toBeNull();
  });
});
