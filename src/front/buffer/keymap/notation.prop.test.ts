import { fc, test } from "@fast-check/vitest";
import { normalizeKeys, parseKeys } from "./notation";

const plainKey = fc.constantFrom("a", "j", "G", ":", "/");
const notatedKey = fc
  .tuple(fc.subarray(["C", "A", "S", "M"]), fc.constantFrom("Space", "CR", "Esc", "lt", "a", "x"))
  .filter(([modifiers, base]) => modifiers.length > 0 || base.length > 1)
  .map(([modifiers, base]) => `<${modifiers.map((modifier) => `${modifier}-`).join("")}${base}>`);
const keys = fc
  .array(fc.oneof(plainKey, notatedKey), { minLength: 1, maxLength: 5 })
  .map((tokens) => tokens.join(""));

test.prop([keys])("正規化してもキーの数は変わらない", (k) => {
  return parseKeys(normalizeKeys(k))?.length === parseKeys(k)?.length;
});

test.prop([keys])("正規化は冪等", (k) => {
  const once = normalizeKeys(k);
  return normalizeKeys(once) === once;
});

test.prop([keys])("生成した列は分解できる", (k) => parseKeys(k) !== null);
