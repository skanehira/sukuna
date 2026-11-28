import { expect, it } from "vite-plus/test";
import { countOutputTokens, emptyOutputTokens, outputTokenTotal } from "./output-tokens";

it("メッセージの途中は文字数から見積もり、確定した数で置き換え、次のメッセージに足す", () => {
  const started = countOutputTokens(emptyOutputTokens, { kind: "message_start" });
  const written = countOutputTokens(started, { kind: "output_chars", characters: 10 });
  expect(outputTokenTotal(written)).toBe(3);
  const confirmed = countOutputTokens(written, { kind: "message_usage", outputTokens: 7 });
  expect(outputTokenTotal(confirmed)).toBe(7);
  const next = countOutputTokens(countOutputTokens(confirmed, { kind: "message_start" }), {
    kind: "text_delta",
    text: "あ😀bc",
  });
  expect(outputTokenTotal(next)).toBe(8);
});
