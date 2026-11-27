import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { statusText } from "./status-text";
test.prop([
  fc.string({ minLength: 1 }).filter((s) => !/[\r\n]/.test(s)),
  fc.string(),
  fc.integer({ min: 1, max: 20 }),
])("失敗の説明は一行目と未読スレッドの件数を状況に出す", (line, rest, count) => {
  const text = `失敗: ${line}`;
  const chars = Array.from(text);
  expect(statusText("failed", { detail: `${line}\n${rest}`, threadAnswers: count })).toEqual({
    status: `スレッドの回答 ${count} 件 · ${text}`,
    notice: chars.length > 120 ? `${chars.slice(0, 120).join("")}…` : text,
  });
});
