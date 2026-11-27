import { expect, it } from "vite-plus/test";
import type { Quote } from "../../../../shared/stock";
import { formatStockInstructions, formatStockItem, formatThreadQuestion } from "./message-format";

const position = { line: 5, col: 0 };
const commit = "1234567890123456789012345678901234567890";
const notice =
  "(元の会話の AI は、このスレッドを始めた時点で作業を続けています。記録で中断と出ているツールの呼び出しは、元の会話で動いています。やり直さないでください。ファイルは元の会話と共有しています。)";
const quoted = "選んだ行\n\n最後の行";
const selection = { mode: "line", text: quoted } as const;
const quotes: [Quote, string][] = [
  [
    {
      ...selection,
      kind: "conversation",
      start: { ...position, seq: 10 },
      end: { ...position, seq: 12 },
    },
    "この会話の発言から",
  ],
  [
    { ...selection, kind: "file", path: "main.ts", start: position, end: { ...position, line: 7 } },
    "main.ts 5〜7 行目",
  ],
  [
    { ...selection, kind: "design_diff", path: "design.md", start: position, end: position },
    "設計書の差分 design.md 5 行目",
  ],
  [
    {
      ...selection,
      kind: "pr_diff",
      path: "main.ts",
      commit,
      start: { ...position, side: "old" },
      end: { ...position, line: 7, side: "new" },
    },
    "PR の差分 main.ts 変更前 5 行目〜変更後 7 行目 (1234567)",
  ],
  [{ ...selection, kind: "terminal" }, "ターミナルの出力から"],
];

it.each(quotes)("引用 %j の場所、引用行、本文を一項目として並べる", (quote, location) => {
  expect(formatStockItem({ quote, text: "本文" })).toBe(
    `${location}\n> 選んだ行\n> \n> 最後の行\n本文`,
  );
});

it("指示を番号付きで一通にまとめ、古いファイルの引用に説明を付ける", () => {
  expect(
    formatStockInstructions([
      { quote: quotes[1][0], text: "一つ目", stale: true },
      { quote: quotes[0][0], text: "二つ目" },
    ]),
  ).toBe(
    "ストックした指示が 2 件あります。順に対応してください。\n\n" +
      "1. main.ts 5〜7 行目 (引用した時点の内容。いまのファイルとは違います)\n> 選んだ行\n> \n> 最後の行\n一つ目\n\n" +
      "2. この会話の発言から\n> 選んだ行\n> \n> 最後の行\n二つ目",
  );
});

it("元の会話の作業継続を伝える注記は作業中のスレッドにだけ付ける", () => {
  const item = { quote: quotes[4][0], text: "定期処理の負荷は問題ない?" };
  const question =
    "次の箇所について質問です。\n\nターミナルの出力から\n> 選んだ行\n> \n> 最後の行\n定期処理の負荷は問題ない?";
  expect(formatThreadQuestion(item, false)).toBe(question);
  expect(formatThreadQuestion(item, true)).toBe(`${notice}\n\n${question}`);
});

it("PR 差分の同じ側の範囲は側の名前を一度だけ出す", () => {
  const quote = {
    ...selection,
    kind: "pr_diff",
    path: "main.ts",
    commit,
    start: { ...position, side: "old" },
    end: { ...position, line: 6, side: "old" },
  } satisfies Quote;
  expect(formatStockItem({ quote, text: "本文" })).toBe(
    "PR の差分 main.ts 変更前 5〜6 行目 (1234567)\n> 選んだ行\n> \n> 最後の行\n本文",
  );
});
