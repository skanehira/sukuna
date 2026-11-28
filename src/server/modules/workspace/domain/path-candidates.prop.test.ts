import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { parsePathQuery, pathCandidates, type DirectoryEntry } from "./path-candidates";

const nameCharacter = fc.constantFrom("a", "A", "s", "S", "Z", "0", "-", "_", ".", "漢");
const name = fc
  .array(nameCharacter, { minLength: 1, maxLength: 6 })
  .map((characters) => characters.join(""));
const visibleName = name.filter((value) => !value.startsWith("."));
const segments = fc.array(name, { maxLength: 3 });
const root = fc.constantFrom("/", "~/");
const formError = {
  code: "invalid_input",
  message: "パスは / または ~/ で始まる形で指定してください。",
};
const lineError = { code: "invalid_input", message: "パスに改行と NUL は書けません。" };
const entries = (names: string[]): DirectoryEntry[] =>
  names.map((value, index) => ({ name: value, repository: index % 2 === 0 }));
const listed = (names: string[]) => ({ kind: "listed" as const, entries: entries(names) });

test.prop([root, segments, fc.oneof(fc.constant(""), name)])(
  "最後の / までを探すディレクトリ、その後ろを名前の先頭として読む",
  (start, parents, prefix) => {
    const directory = `${start}${parents.map((part) => `${part}/`).join("")}`;
    expect(parsePathQuery(`${directory}${prefix}`)._unsafeUnwrap()).toEqual({ directory, prefix });
  },
);

test.prop([
  fc
    .string({ minLength: 1 })
    .filter(
      (text) =>
        text !== "~" && !text.startsWith("/") && !text.startsWith("~/") && !/[\0\n\r]/.test(text),
    ),
])("/ と ~/ のどちらでも始まらない本文は探さない", (text) => {
  expect(parsePathQuery(text)._unsafeUnwrapErr()).toEqual(formError);
});

test.prop([root, name, fc.constantFrom("\0", "\n", "\r"), name])(
  "改行か NUL を含む本文は、始まりの形によらず探さない",
  (start, before, character, after) => {
    expect(parsePathQuery(`${start}${before}${character}${after}`)._unsafeUnwrapErr()).toEqual(
      lineError,
    );
  },
);

test.prop([fc.uniqueArray(name, { maxLength: 30 }), fc.oneof(fc.constant(""), name)])(
  "名前の先頭に前方一致し、. で始まる名前は先頭が . のときだけ残す",
  (names, prefix) => {
    const result = pathCandidates({ directory: "~/src/", prefix }, listed(names));
    const expected = names.filter(
      (value) => value.startsWith(prefix) && (!value.startsWith(".") || prefix.startsWith(".")),
    );
    expect(result.candidates.map((candidate) => candidate.name).toSorted()).toEqual(
      expected.toSorted(),
    );
  },
);

test.prop([fc.uniqueArray(visibleName, { minLength: 2, maxLength: 30 })])(
  "候補は名前の文字コードの順に並ぶ",
  (names) => {
    const sorted = pathCandidates({ directory: "/", prefix: "" }, listed(names)).candidates.map(
      (candidate) => candidate.name,
    );
    expect(sorted.every((value, index) => index === 0 || sorted[index - 1] < value)).toBe(true);
    expect(sorted.length).toBe(names.length);
  },
);

test.prop([fc.constantFrom(200, 201)])(
  "並べた先頭の 200 件までを返し、それを超えたら切ったことを返す",
  (count) => {
    const names = Array.from({ length: count }, (_, index) => `d${String(index).padStart(3, "0")}`);
    const result = pathCandidates({ directory: "/", prefix: "" }, listed(names.toReversed()));
    expect({
      names: result.candidates.map((candidate) => candidate.name),
      truncated: result.truncated,
    }).toEqual({ names: names.slice(0, 200), truncated: count > 200 });
  },
);

test.prop([root, segments, visibleName, fc.boolean()])(
  "候補の文は、書いたままの探すディレクトリに名前と / を足したもの",
  (start, parents, value, repository) => {
    const directory = `${start}${parents.map((part) => `${part}/`).join("")}`;
    const result = pathCandidates(
      { directory, prefix: "" },
      { kind: "listed", entries: [{ name: value, repository }] },
    );
    expect(result).toEqual({
      candidates: [{ name: value, text: `${directory}${value}/`, repository }],
      truncated: false,
      note: null,
    });
  },
);
