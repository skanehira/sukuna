import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { countOutputTokens, emptyOutputTokens, outputTokenTotal } from "./output-tokens";

const written = fc.array(
  fc.oneof(
    fc.string().map((text) => ({ kind: "text_delta" as const, text })),
    fc.nat({ max: 10000 }).map((characters) => ({ kind: "output_chars" as const, characters })),
  ),
);
test.prop([fc.array(fc.tuple(written, fc.nat({ max: 100000 })), { minLength: 1 }), written])(
  "確定した数が届いたメッセージは、文字数に関係なくその数で数える",
  (messages, last) => {
    let state = emptyOutputTokens;
    for (const [outputs, confirmed] of messages) {
      state = countOutputTokens(state, { kind: "message_start" });
      for (const output of outputs) state = countOutputTokens(state, output);
      state = countOutputTokens(state, { kind: "message_usage", outputTokens: confirmed });
    }
    const total = messages.reduce((sum, [, confirmed]) => sum + confirmed, 0);
    expect(outputTokenTotal(state)).toBe(total);
    state = countOutputTokens(state, { kind: "message_start" });
    for (const output of last) state = countOutputTokens(state, output);
    const characters = last.reduce(
      (sum, output) =>
        sum + (output.kind === "text_delta" ? Array.from(output.text).length : output.characters),
      0,
    );
    expect(outputTokenTotal(state)).toBe(total + Math.ceil(characters / 4));
  },
);
