import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { validProjectName } from "./project-settings";

const validCharacters = fc.constantFrom("a", "9", "_", "-", "漢", "🦉");
const validName = fc
  .array(validCharacters, { minLength: 1, maxLength: 40 })
  .map((chars) => chars.join(""));

test.prop([validName, fc.constantFrom("/", " ", "\t", "　", "\n", "\0")])(
  "1〜40 字の名前を受け付け、文字を禁則へ置き換えると断る",
  (name, forbidden) => {
    const [, ...rest] = Array.from(name);
    expect([validProjectName(name), validProjectName(forbidden + rest.join(""))]).toEqual([
      true,
      false,
    ]);
  },
);

test.prop([fc.array(validCharacters, { minLength: 40, maxLength: 40 }), validCharacters])(
  "40 字まで登録でき、41 字では登録できない",
  (characters, extra) => {
    const name = characters.join("");
    expect([validProjectName(name), validProjectName(name + extra)]).toEqual([true, false]);
  },
);
