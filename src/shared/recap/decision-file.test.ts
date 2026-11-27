import { describe, expect, it } from "vite-plus/test";
import {
  nextDecisionId,
  parseDecisionFile,
  replaceDecisionItems,
  serializeDecision,
} from "./decision-file";

describe("決まったことのファイル", () => {
  const items = [
    {
      id: "D2",
      kind: "decision" as const,
      text: "24 時間前",
      reason: null,
      seq: 9,
      changedTo: "D5",
    },
    {
      id: "D3",
      kind: "rejected" as const,
      text: "独自認証",
      reason: "既存を使う",
      seq: null,
      changedTo: null,
    },
    {
      id: "D5",
      kind: "pending" as const,
      text: "12 時間前",
      reason: null,
      seq: 40,
      changedTo: null,
    },
  ];
  const lines = [
    "- [決定] D2: 24 時間前 → D5 <!-- seq=9 -->",
    "- [棄却] D3: 独自認証 — 既存を使う",
    "- [保留] D5: 12 時間前 <!-- seq=40 -->",
  ];
  it("3 種類・理由・変わった先・根拠を読み、同じ行に組み立てる", () => {
    expect(parseDecisionFile(lines.join("\n"))).toEqual(items);
    expect(items.map(serializeDecision)).toEqual(lines);
    expect(nextDecisionId(lines.join("\n"))).toBe("D6");
    expect(nextDecisionId("手で書いた文\n- [未知] D90: 読まない")).toBe("D1");
  });
  it("空文字の理由も保存後に同じ項目として読み直せる", () => {
    const item = { ...items[0], reason: "" };
    expect(parseDecisionFile(serializeDecision(item))).toEqual([item]);
  });
  it("項目を並べ替え・削除・復元しても手書き行と改行を残す", () => {
    const source = `# 台帳\r\n\r\n${lines[0]}\r\n手で書いた文\r\n${lines[1]}\r\n末尾`;
    expect(replaceDecisionItems(source, [items[2], items[0]])).toBe(
      `# 台帳\r\n\r\n${lines[2]}\r\n手で書いた文\r\n${lines[0]}\r\n末尾`,
    );
    expect(replaceDecisionItems(source, [])).toBe("# 台帳\r\n\r\n手で書いた文\r\n末尾");
  });
  it.each([
    "- [決定] D0: 無効",
    "- [決定] D1: ",
    "- [決定] D1: 本文 <!-- seq=bad -->",
    "- [決定] D2: 本文 → D0",
  ])("形の合わない行 %s を書き換えない", (line) => {
    expect(parseDecisionFile(line)).toEqual([]);
    expect(replaceDecisionItems(line, [])).toBe(line);
  });
});
