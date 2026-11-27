import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { limitClosingItems, parseClosingCommits, parseUncommittedPaths } from "./closing-summary";

const hash = fc
  .array(fc.constantFrom(..."0123456789abcdef".split("")), { minLength: 40, maxLength: 40 })
  .map((characters) => characters.join(""));
const subject = fc.stringMatching(/^[a-zA-Z\d \t]*$/);

test.prop([fc.array(fc.record({ at: fc.nat(), hash, subject }), { minLength: 1, maxLength: 20 })])(
  "git log の出力から全件のハッシュと件名を時刻の新しい順で返す",
  (commits) => {
    const lines = commits.map(({ at, hash, subject }) => `${at}\t${hash}\t${subject}\n`).join("");
    expect(parseClosingCommits(lines)).toEqual(
      commits.toSorted((a, b) => b.at - a.at).map(({ hash, subject }) => ({ hash, subject })),
    );
  },
);

const path = fc.stringMatching(/^[a-zA-Z\d/_ .-]{1,20}$/);
const changed = fc
  .record({
    path,
    status: fc.constantFrom(" M", "??", "R ", " C"),
  })
  .chain((current) => fc.record({ source: path }).map(({ source }) => ({ ...current, source })));

test.prop([fc.array(changed, { minLength: 1, maxLength: 20 })])(
  "Git の状態ごとに報告されたパスを保ち、改名前のパスを別の変更に数えない",
  (changes) => {
    const tokens = changes.flatMap(({ path, status, source }) =>
      status.includes("R") || status.includes("C")
        ? [`${status} ${path}`, source]
        : [`${status} ${path}`],
    );
    expect(parseUncommittedPaths(tokens.join("\0") + "\0")).toEqual(
      [...new Set(changes.map(({ path }) => path))].sort(),
    );
  },
);

test.prop([
  fc.array(fc.integer(), { minLength: 1, maxLength: 100 }),
  fc.integer({ min: 1, max: 30 }),
])("上限内の項目は元の順で返し、続きの件数を返す", (items, limit) => {
  expect(limitClosingItems(items, limit)).toEqual({
    items: items.slice(0, limit),
    more: items.slice(limit).length,
  });
});
