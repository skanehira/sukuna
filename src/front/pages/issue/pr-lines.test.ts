import { describe, expect, it } from "vitest";
import type { PrResponse } from "../../../shared/api/pr";
import type { Quote, StockItem } from "../../../shared/stock";
import { stockMarks } from "../../lib/stock/marks";
import { mergePrompt, prLines, prQuoteSources, runningChecks } from "./pr-lines";
import { base, check, file, sha } from "./pr.test-support";
import { makeQuote } from "../../lib/stock/quote";

const rows = (data = base, github = true, merged = false) =>
  prLines(data, { github, merged, expanded: new Set() });

describe("差分の行", () => {
  it("PR の項目と差分を指定順に並べ、ファイルの行を色と行番号で分ける", () => {
    const lines = rows({ ...base, files: [file] });
    expect(lines.slice(0, 5).map((line) => line.text)).toEqual([
      "PR #128 予約カレンダーに祝日を表示する",
      "状況  merge 前の確認",
      "ブランチ  sukuna/issue-8 → main",
      "merge できるか  できる",
      "URL  https://github.com/o/r/pull/128",
    ]);
    expect(
      lines.slice(9, 14).map(({ kind, text, lineNumber }) => [kind, text, lineNumber]),
    ).toEqual([
      ["heading", "src/calendar/holiday.ts  +2 −1", undefined],
      ["del", "const days = fetchHolidays()", 18],
      ["add", "const days = fetchHolidays(year)", 19],
      ["code", "", 20],
      ["add", "return days", 21],
    ]);
  });

  it("同じファイルの差分の両側を選ぶと、PR のコミットと両側の行が引用に入る", () => {
    const lines = rows({ ...base, files: [file] });
    const [source] = prQuoteSources(lines);
    const start = lines.findIndex((line) => line.kind === "del");
    const selected = [start, start + 1].map((line) => ({
      line,
      from: 0,
      to: lines[line].text.length,
    }));
    expect(
      makeQuote(
        source,
        lines.map((line) => line.text),
        { mode: "line", ranges: selected },
      ),
    ).toEqual({
      kind: "pr_diff",
      path: file.path,
      commit: sha,
      mode: "line",
      text: "const days = fetchHolidays()\nconst days = fetchHolidays(year)",
      start: { side: "old", line: 18, col: 0 },
      end: { side: "new", line: 19, col: 32 },
    });
  });

  const instruction = (quote: Quote): StockItem => ({
    id: "selected",
    conversationId: "c",
    kind: "instruction",
    text: "直す",
    quote,
    state: "stocked",
    stale: false,
    sentAt: null,
    sentSeq: null,
    thread: null,
    githubCommentUrl: null,
  });

  it.each(["char", "block"] as const)(
    "%s の部分引用は同じ桁の印が付き、更新後に別の語へ印を移さない",
    (mode) => {
      const original = rows({ ...base, files: [file] });
      const start = original.findIndex((line) => line.kind === "add");
      const from = original[start].text.indexOf("fetchHolidays");
      const to = from + "fetchHolidays".length;
      const [source] = prQuoteSources(original);
      const texts = original.map((line) => line.text);
      const quote = makeQuote(source, texts, {
        mode,
        ranges: [{ line: start, from, to }],
        ...(mode === "block" ? { block: { from, to } } : {}),
      })!;
      const saved = instruction(quote);
      expect(stockMarks(source, texts, [], quote).get(start)?.symbol).toBe("›");
      expect(stockMarks(source, texts, [saved]).get(start)?.symbol).toBe("!");
      const modified = texts.map((text, index) =>
        index === start ? text.replace("fetchHolidays", "monthFor") : text,
      );
      expect(stockMarks(source, modified, [saved]).size).toBe(0);
    },
  );

  it("PR の HEAD が変わると、GitHub の行コメントと同じ行頭条件を文字・矩形にも使う", () => {
    const original = rows({ ...base, files: [file] });
    const [oldSource] = prQuoteSources(original);
    const newer = rows({ ...base, pr: { ...base.pr!, headSha: "7".repeat(40) }, files: [file] });
    const [newSource] = prQuoteSources(newer);
    const from = original.findIndex((line) => line.kind === "add");
    const lineText = original[from].text;
    const column = lineText.indexOf("fetchHolidays");
    const end = column + "fetchHolidays".length;
    const oldTexts = original.map((line) => line.text);
    const newTexts = newer.map((line) => line.text);
    const quotes = [
      makeQuote(oldSource, oldTexts, {
        mode: "char",
        ranges: [{ line: from, from: column, to: end }],
      }),
      makeQuote(oldSource, oldTexts, {
        mode: "block",
        ranges: [{ line: from, from: column, to: end }],
        block: { from: column, to: end },
      }),
      makeQuote(oldSource, oldTexts, {
        mode: "line",
        ranges: [{ line: from, from: 0, to: lineText.length }],
      }),
    ];
    expect(
      quotes.map((quote) => stockMarks(newSource, newTexts, [instruction(quote!)]).has(from)),
    ).toEqual([false, false, true]);
  });

  it("長い差分を折り畳んでも、引用のうち表示中の行には印が残る", () => {
    const many = {
      ...file,
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 26,
          lines: Array.from({ length: 26 }, (_, index) => `+休日 ${index + 1}`),
        },
      ],
    };
    const data = { ...base, files: [many] };
    const expanded = prLines(data, { github: true, merged: false, expanded: new Set([file.path]) });
    const first = expanded.findIndex((line) => line.lineNumber === 9);
    const positions = [first, first + 1, first + 2, first + 3];
    const quote = makeQuote(
      prQuoteSources(expanded)[0],
      expanded.map((line) => line.text),
      {
        mode: "line",
        ranges: positions.map((line) => ({ line, from: 0, to: expanded[line].text.length })),
      },
    )!;
    const collapsed = rows(data);
    const marks = stockMarks(
      prQuoteSources(collapsed)[0],
      collapsed.map((line) => line.text),
      [instruction(quote)],
    );
    expect([...marks.keys()].map((position) => collapsed[position].lineNumber)).toEqual([9, 10]);
  });

  it("CI の検査を API の順で表示し、それぞれの時間と集計を表示する", () => {
    const checks = [
      check("lint", "failure"),
      check("e2e", "running"),
      { ...check("docs", "queued"), startedAt: null, completedAt: null },
      check("test", "skipped"),
    ];
    expect(
      rows({ ...base, checks })
        .slice(5, 10)
        .map((line) => line.text),
    ).toEqual([
      "CI  成功 1 / 失敗 1 / 実行中 2",
      "lint  失敗  1分",
      "e2e  実行中  1分30秒",
      "docs  待ち  —",
      "test  飛ばした  1分",
    ]);
  });

  it("証跡の画像行を本文中の位置で URL とプレビューに分ける", () => {
    const url = "https://example.test/screenshot.png";
    const evidence = {
      markdown: `### 一覧\n![一覧](${url})\n検査済み`,
      images: [{ alt: "一覧", url }],
    };
    expect(
      rows({ ...base, evidence })
        .slice(7, 11)
        .map(({ text, image }) => [text, image]),
    ).toEqual([
      ["動作確認", undefined],
      ["### 一覧", undefined],
      [url, { alt: "一覧", url }],
      ["検査済み", undefined],
    ]);
  });

  it("同じ URL の画像にも PR 本文の出現箇所ごとの代替テキストを使う", () => {
    const url = "https://example.test/both.png";
    const records = [
      { alt: "修正前", url },
      { alt: "修正後", url },
    ];
    const data = {
      ...base,
      evidence: {
        markdown: records.map(({ alt }) => `![${alt}](${url})`).join("\n"),
        images: records,
      },
    };
    expect(rows(data).flatMap(({ image }) => (image ? [image] : []))).toEqual(records);
  });

  it("取得失敗を先頭に出し、空の節と大きすぎる差分、以前の PR を表示する", () => {
    const lines = rows({
      ...base,
      fetchError: "GitHub から PR を取得できませんでした: GitHub につながりません",
      diffTooLarge: true,
      files: [{ ...file, hunks: [] }],
      earlierPrUrls: ["https://github.com/o/r/pull/127"],
    }).map((line) => line.text);
    expect(lines[0]).toBe(
      "GitHub から PR を取得できませんでした: GitHub につながりません。15:20 に取得した内容を表示しています",
    );
    expect(lines).toContain("CI の検査はありません");
    expect(lines).toContain("動作確認の証跡はありません");
    expect(lines).toContain(
      "差分が大きすぎて GitHub から取得できません。Space g のターミナルで確かめてください",
    );
    expect(lines.slice(-6)).toEqual([
      "以前の PR",
      "https://github.com/o/r/pull/127",
      "操作",
      "merge を許可する",
      "指摘を書いて実装に戻す",
      "GitHub から読み直す",
    ]);
  });

  const missing = {
    ...base,
    source: "none",
    pr: null,
    waitingMergeConfirm: false,
  } satisfies PrResponse;
  it.each([
    {
      github: true,
      merged: false,
      expected: "PR はまだありません。実装が終わると、ここに差分と CI の結果が出ます",
    },
    { github: false, merged: false, expected: "実装のブランチ issue-8 と既定ブランチの差分" },
    { github: false, merged: true, expected: "merge 済みです。変更は会話の差分で見られます" },
  ])("PR が無いときの行は $expected", ({ github, merged, expected }) => {
    const data: PrResponse = github
      ? missing
      : {
          ...missing,
          source: "local",
          local: { branch: "issue-8", baseBranch: "main", headSha: sha },
          files: [file],
        };
    expect(rows(data, github, merged)[0].text).toBe(expected);
  });

  it("ファイルの差分が 25 行を超えると 10 行を残して畳み、開くと全行が戻る", () => {
    const longFile = (size: number) => ({
      ...file,
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: size,
          lines: Array.from({ length: size }, (_, index) => `+行 ${index + 1}`),
        },
      ],
    });
    const edge = rows({ ...base, files: [longFile(25)] });
    expect(edge.filter((line) => line.kind === "add")).toHaveLength(25);

    const data = { ...base, files: [longFile(26)] };
    const folded = rows(data);
    expect(folded.filter((line) => line.kind === "add")).toHaveLength(10);
    expect(folded.some((line) => line.text === "残り 16 行 (Enter か zo で開く)")).toBe(true);
    const expanded = prLines(data, { github: true, merged: false, expanded: new Set([file.path]) });
    expect(expanded.filter((line) => line.kind === "add")).toHaveLength(26);
  });

  it("許可は確認待ちで表示し、未送信の指示があると確認に件数を添える", () => {
    expect(rows({ ...base, waitingMergeConfirm: false }).map((line) => line.text)).not.toContain(
      "merge を許可する",
    );
    expect(mergePrompt(1)).toBe(
      "merge を許可しますか? 送っていない指示が 1 件あります。許可しても送られずに残ります",
    );
    expect(mergePrompt(0)).toBe("merge を許可しますか?");
  });

  it("実行中と待ちの検査がポーリングを必要とする", () => {
    expect(runningChecks([check("test", "success")])).toBe(false);
    expect(runningChecks([check("test", "running")])).toBe(true);
    expect(runningChecks([check("test", "queued")])).toBe(true);
  });
});
