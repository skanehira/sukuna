import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { sameAnswers } from "./answers";

const answer = fc.record({
  choices: fc.array(fc.string()),
  text: fc.option(fc.string(), { nil: null }),
});
const draft = fc.dictionary(fc.nat({ max: 20 }).map(String), answer, { minKeys: 1 });

test.prop([draft])("同じ回答を読み直した場合は送信確認を使える", (saved) => {
  const reread = Object.fromEntries(
    Object.entries(saved)
      .reverse()
      .map(([index, { choices, text }]) => [index, { text, choices: [...choices] }]),
  );
  expect(sameAnswers(saved, reread)).toBe(true);
});

test.prop([draft, fc.nat()])("どの質問の文章が変わっても送信確認が必要になる", (saved, offset) => {
  const indices = Object.keys(saved);
  const index = indices[offset % indices.length]!;
  const original = saved[index]!;
  const changed = { ...saved, [index]: { ...original, text: `${original.text ?? ""}追記` } };
  expect(sameAnswers(saved, changed)).toBe(false);
});

test.prop([draft, fc.nat()])(
  "同じ回答でも質問番号が移れば送信確認が必要になる",
  (saved, offset) => {
    const indices = Object.keys(saved);
    const index = indices[offset % indices.length]!;
    const { [index]: moved, ...other } = saved;
    const newIndex = String(Math.max(...indices.map(Number)) + 1);
    expect(sameAnswers(saved, { ...other, [newIndex]: moved! })).toBe(false);
  },
);

test.prop([draft, fc.nat()])("選択肢が変われば送信確認が必要になる", (saved, offset) => {
  const indices = Object.keys(saved);
  const index = indices[offset % indices.length]!;
  const original = saved[index]!;
  const choices = original.choices.length
    ? original.choices.map((choice, position) => (position === 0 ? choice + "追記" : choice))
    : ["追加した選択肢"];
  expect(sameAnswers(saved, { ...saved, [index]: { ...original, choices } })).toBe(false);
});
