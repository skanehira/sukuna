import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { applySummary, turnLines } from "./turn-summary";

const characters = fc.array(fc.constantFrom("A", "あ", "𠮷", "🎋"), {
  minLength: 201,
  maxLength: 250,
});
test.prop([characters, fc.integer({ min: 1, max: 50_000 }), fc.constantFrom("\n", "\r\n")])(
  "文字数を制限しても根拠の発言の位置と質問の原文が保たれる",
  (characters, seq, newline) => {
    const first = characters.slice(0, 100).join("");
    const question = "  " + characters.slice(100).join("") + "？";
    const turn = turnLines(
      [{ seq, type: "assistant_text", payload: { text: first + newline + question } }],
      "/project",
    );
    const text = characters.join("");
    const output = {
      chapter: { kind: "new", title: text },
      decisions: [{ kind: "decision", text, reason: text, line: 1 }],
      changes: [],
      questions: [2],
      answered: [],
    };
    expect(
      applySummary(
        output,
        { chapters: [], decisions: [], questions: [], entries: turn.entries },
        turn,
      ),
    ).toMatchObject({
      title: characters.slice(0, 30).join(""),
      decisions: [
        { seq, text: characters.slice(0, 200).join(""), reason: characters.slice(0, 200).join("") },
      ],
      questions: [{ seq, text: question }],
    });
  },
);
