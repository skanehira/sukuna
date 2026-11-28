import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { completeText, type CompletionCandidate } from "./completion";

const character = fc.constantFrom("a", "b", "-", "/", "~", "漢", "🦉", "🦊");
const word = fc.array(character, { maxLength: 6 }).map((characters) => characters.join(""));
const forks = fc
  .uniqueArray(character, { minLength: 2, maxLength: 4 })
  .chain((firsts) => fc.tuple(...firsts.map((first) => word.map((rest) => `${first}${rest}`))));
const candidates = (texts: string[]): CompletionCandidate[] =>
  texts.map((text) => ({ text, label: text, strong: false }));

test.prop([word, forks, fc.nat()])(
  "2 件以上の候補は、候補の文に共通する先頭まで本文を伸ばす",
  (shared, tails, cut) => {
    const characters = Array.from(shared);
    const text = characters.slice(0, cut % (characters.length + 1)).join("");
    const texts = tails.map((tail) => `${shared}${tail}`);
    expect(
      completeText(text, { candidates: candidates(texts), truncated: false, note: null }),
    ).toBe(shared);
  },
);

test.prop([word, forks, word.filter((typed) => typed !== "")])(
  "上限で切った候補では、切らなければ伸ばせる共通する先頭があっても本文を変えない",
  (shared, tails, typed) => {
    const listed = candidates(tails.map((tail) => `${shared}${typed}${tail}`));
    expect([
      completeText(shared, { candidates: listed, truncated: true, note: null }),
      completeText(shared, { candidates: listed, truncated: false, note: null }),
    ]).toEqual([shared, `${shared}${typed}`]);
  },
);

test.prop([word, forks, word.filter((typed) => typed !== "")])(
  "候補の文に共通する先頭が本文より長くなければ本文を変えず、長ければ伸ばす",
  (shared, tails, typed) => {
    const listed = {
      candidates: candidates(tails.map((tail) => `${shared}${tail}`)),
      truncated: false,
      note: null,
    };
    expect([completeText(`${shared}${typed}`, listed), completeText("", listed)]).toEqual([
      `${shared}${typed}`,
      shared,
    ]);
  },
);
