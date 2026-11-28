import "../../../test/fast-check";
import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { terminalLines } from "./terminal-lines";
import { sendTerminalInput, type InputFrame } from "./terminal-client";
import { TERMINAL_INPUT_BYTES } from "../../../shared/api/terminal";

const chunks = fc.array(fc.string({ minLength: 1, maxLength: 12 }), {
  minLength: 1,
  maxLength: 10,
});

test.prop([chunks])("端末の折り返し数にかかわらず元の内容を1行で読める", (values) => {
  const rows = values.map((value, index) => ({
    length: value.length,
    getCell: () => undefined,
    isWrapped: index !== 0,
    translateToString: () => value,
  }));
  expect(
    terminalLines({
      length: rows.length,
      baseY: 0,
      cursorY: rows.length - 1,
      getLine: (i) => rows[i],
    }),
  ).toEqual([values.join("").trimEnd()]);
});

test("64KiB を超える貼り付けは UTF-8 の文字を壊さず順番どおり送る", () => {
  const text = "a".repeat(TERMINAL_INPUT_BYTES - 1) + "🐾" + "b";
  const frames: InputFrame[] = [];
  sendTerminalInput((frame) => frames.push(frame), text);
  expect(frames).toEqual([
    { type: "input", data: "a".repeat(TERMINAL_INPUT_BYTES - 1) },
    { type: "input", data: "🐾b" },
  ]);
});
