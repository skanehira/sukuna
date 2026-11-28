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

test.prop([
  fc
    .array(
      fc.string().filter((text) => !text.includes("\n")),
      { minLength: 1, maxLength: 20 },
    )
    .filter((text) => text.at(-1) !== ""),
  fc.boolean(),
])("ツールの結果は先頭 3 行を字下げして出し、残りの行数を数えて添える", (text, newline) => {
  const event: Event = {
    seq: 9,
    createdAt: 0,
    type: "tool_result",
    payload: {
      tool_use_id: "tool",
      is_error: false,
      content: text.join("\n") + (newline ? "\n" : ""),
      truncated: false,
      bytes: 0,
    },
  };
  const shown = text.slice(0, 3).map((line, index) => ({
    kind: "tool",
    text: `${index === 0 ? "  ⎿  " : "     "}${line}`,
    seq: 9,
    seqLine: index,
  }));
  expect(eventLines(event, "c1", "/project")).toEqual(
    text.length > 3
      ? [...shown, { kind: "tool", text: `     … +${text.length - 3} 行`, seq: 9 }]
      : shown,
  );
});

test.prop([
  fc.array(
    fc.string().filter((text) => text.trim() !== "" && !text.includes("\n")),
    { minLength: 1, maxLength: 5 },
  ),
  fc.uniqueArray(fc.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/), { maxLength: 20 }),
  fc.nat({ max: 30 }),
])(
  "ツールの結果の文の行の後に、保存できた画像ごとに k / n の行を並べ、保存できなかった画像があれば最後にその数の行を出す",
  (text, images, omitted) => {
    const payload = {
      tool_use_id: "tool",
      is_error: false,
      content: text.join("\n"),
      truncated: false,
      bytes: 0,
    };
    const event = (extra: object): Event => ({
      seq: 9,
      createdAt: 0,
      type: "tool_result",
      payload: { ...payload, ...extra },
    });
    expect(
      eventLines(
        event({
          ...(images.length
            ? { images: images.map((id) => ({ id, media_type: "image/png" })) }
            : {}),
          ...(omitted ? { omitted_images: omitted } : {}),
        }),
        "c1",
        "/project",
      ),
    ).toEqual([
      ...eventLines(event({}), "c1", "/project"),
      ...images.map((id, index) => ({
        kind: "tool",
        text: `     画像 ${index + 1} / ${images.length} (Enter で元の大きさで開く)`,
        seq: 9,
        image: {
          url: `/api/conversations/c1/images/${id}`,
          alt: `画像 ${index + 1} / ${images.length}`,
        },
      })),
      ...(omitted
        ? [
            {
              kind: "tool",
              text: `     画像 ${omitted} 件は保存できなかったため表示できません`,
              seq: 9,
            },
          ]
        : []),
    ]);
  },
);
