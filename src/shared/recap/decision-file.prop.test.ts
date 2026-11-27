import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { nextDecisionId, parseDecisionFile, replaceDecisionItems } from "./decision-file";

const text = fc
  .array(
    fc.oneof(
      fc.string({ maxLength: 12 }),
      fc.constantFrom('"', "\\", "\n", "\r", " — ", " → D9", " <!-- seq=99 -->", "🙂"),
    ),
    { maxLength: 6 },
  )
  .map((parts) => `本文${parts.join("")}`);
const item = fc.record({
  id: fc.bigInt({ min: 1n, max: 10n ** 350n }).map((number) => `D${number}`),
  kind: fc.constantFrom("decision" as const, "rejected" as const, "pending" as const),
  text,
  reason: fc.option(text, { nil: null }),
  seq: fc.option(fc.nat({ max: 1000000 }), { nil: null }),
  changedTo: fc.option(fc.constant("D1"), { nil: null }),
});
test.prop([fc.uniqueArray(item, { selector: (item) => item.id, minLength: 1, maxLength: 12 })])(
  "記号や改行を含む項目を1物理行ずつ保存して読み戻し、最大番号の次を採番する",
  (items) => {
    const content = replaceDecisionItems("手書きの文\r\n", items);
    expect(parseDecisionFile(content)).toEqual(items);
    expect(content.split("\r\n")).toHaveLength(items.length + 3);
    expect(nextDecisionId(content)).toBe(
      `D${items.reduce((max, item) => (BigInt(item.id.slice(1)) > max ? BigInt(item.id.slice(1)) : max), 0n) + 1n}`,
    );
  },
);

test.prop([item, fc.array(fc.string({ maxLength: 12 }), { maxLength: 8 })])(
  "旧形式の未管理行があるファイルを更新し直しても項目と元の手書き行を保つ",
  (item, words) => {
    const handwritten = `- [決定] D9: ${JSON.stringify(`手書き → D8 ${words.join(" ")}`)}`;
    const first = replaceDecisionItems(`手書きの題名\n${handwritten}\n`, [item]);
    expect(parseDecisionFile(first)).toEqual([item]);
    const second = replaceDecisionItems(first, [{ ...item, reason: "編集" }]);
    expect(parseDecisionFile(second)).toEqual([{ ...item, reason: "編集" }]);
    const removed = replaceDecisionItems(second, []);
    expect(parseDecisionFile(removed)).toEqual([]);
    expect(removed.split("\n").filter((line) => line === handwritten)).toEqual([handwritten]);
  },
);
