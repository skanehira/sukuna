import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { eventLines } from "./lines";
import type { Event } from "./types";

test.prop([
  fc.array(
    fc.string().filter((text) => text.length > 0 && !text.includes("\n")),
    { minLength: 1, maxLength: 80 },
  ),
  fc.boolean(),
])("新規ファイルは末尾改行の有無によらず全行を追加行として読める", (text, newline) => {
  const event: Event = {
    seq: 7,
    createdAt: 0,
    type: "diff",
    payload: {
      tool_use_id: "tool",
      path: "new.ts",
      change: "create",
      hunks: [],
      content: text.join("\n") + (newline ? "\n" : ""),
      truncated: false,
    },
  };
  expect(eventLines(event, "c1", "/project", null, true)).toEqual(
    text.map((line, index) => ({
      kind: "add",
      text: `${index + 1} +${line}`,
      seq: 7,
      seqLine: index,
    })),
  );
});

test.prop([
  fc.integer({ min: 1, max: 1000 }),
  fc.array(
    fc.string().filter((text) => !text.includes("\n")),
    { minLength: 1, maxLength: 80 },
  ),
])("差分の追加行は開始行から連続して並び、開くと省略された本文もすべて読める", (start, text) => {
  const event: Event = {
    seq: 7,
    createdAt: 0,
    type: "diff",
    payload: {
      tool_use_id: "tool",
      path: "a.ts",
      change: "edit",
      hunks: [
        {
          old_start: start,
          old_lines: 0,
          new_start: start,
          new_lines: text.length,
          lines: text.map((line) => `+${line}`),
        },
      ],
      truncated: false,
    },
  };
  const expected = text.map((line, index) => ({
    kind: "add",
    text: `${start + index} +${line}`,
    seq: 7,
    seqLine: index,
  }));
  expect(eventLines(event, "c1", "/project", null, true)).toEqual(expected);
  const collapsed = eventLines(event, "c1", "/project");
  expect(collapsed.filter((line) => line.kind === "add")).toEqual(
    text.length > 25 ? expected.slice(0, 10) : expected,
  );
});
