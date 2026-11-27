import { expect, it } from "vite-plus/test";
import {
  parseClosingCommits,
  parseClosingCount,
  parseClosingPrs,
  parseUncommittedPaths,
} from "./closing-summary";

it("git log の出力から件名中のタブを保ってハッシュと件名を読む", () => {
  const hash = "ab".repeat(20);
  expect(parseClosingCommits(`1772366460\t${hash}\t対応\t検査\n`)).toEqual([
    { hash, subject: "対応\t検査" },
  ]);
  expect(parseClosingCommits("")).toEqual([]);
  expect(() => parseClosingCommits("不足している行")).toThrow("git log");
});

it("Git の NUL 区切りのパスを読み、改名先と空白を含むファイル名を返す", () => {
  const porcelain = "R  新しい 名前.txt\0旧名.txt\0?? src/a\nb.txt\0 M z.txt\0";
  expect(parseUncommittedPaths(porcelain)).toEqual(["src/a\nb.txt", "z.txt", "新しい 名前.txt"]);
  expect(parseUncommittedPaths("")).toEqual([]);
});

it("未 push の件数に使う rev-list の出力を整数として読む", () => {
  expect(parseClosingCount("0\n")).toBe(0);
  expect(parseClosingCount("12\n")).toBe(12);
  for (const value of ["", "1.5", "-1", "12 lines", "9007199254740992"])
    expect(() => parseClosingCount(value)).toThrow("git rev-list");
});

it("gh の出力から、会話の最初の記録より後の PR だけを返す", () => {
  const row = { title: "変更", state: "MERGED" };
  const data = [
    { ...row, number: 1, url: "https://example.test/1", createdAt: "2026-03-01T12:00:00Z" },
    { ...row, number: 2, url: "https://example.test/2", createdAt: "2026-03-01T12:00:01+00:00" },
    { ...row, number: 3, url: "https://example.test/3", createdAt: "2026-03-01T11:59:59Z" },
  ];
  expect(parseClosingPrs(JSON.stringify(data), Date.parse("2026-03-01T12:00:00Z"))).toEqual({
    received: 3,
    reachedStart: true,
    items: [{ ...row, number: 2, url: "https://example.test/2" }],
  });
  expect(() => parseClosingPrs('[{"number":1}]', 0)).toThrow("gh");
});
