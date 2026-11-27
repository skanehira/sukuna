import { describe, expect, it } from "vite-plus/test";
import { canMoveChapterStart } from "./toc";

describe("章の始まり", () => {
  const chapters = [
    { position: 1, startSeq: 1 },
    { position: 2, startSeq: 10 },
    { position: 3, startSeq: 20 },
  ];
  it.each([
    [1, 1, true],
    [1, 2, false],
    [2, 1, false],
    [2, 2, true],
    [2, 19, true],
    [2, 20, false],
    [3, 10, false],
    [3, 21, true],
    [4, 22, false],
  ])("章 %i の始まり %i は %s", (position, startSeq, expected) => {
    expect(canMoveChapterStart(chapters, position, startSeq)).toBe(expected);
  });
});
