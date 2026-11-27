import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { buildTimelineComments } from "./timeline-comments";

const comment = fc.record({ task_id: fc.string(), text: fc.string() });
test.prop([
  fc.array(comment, { minLength: 2, maxLength: 20 }),
  fc.integer({ min: 1, max: 100000 }),
  fc.constantFrom("developer", "queued", "interrupt", "stock", "answer_text"),
])(
  "構造化相談の任意のIDと本文を保持し、ファイルとの重複を除いて古い順にする",
  (comments, start, origin) => {
    const expected = comments.map(({ task_id, text }, index) => ({
      at: start + index,
      taskId: task_id,
      text,
    }));
    const result = buildTimelineComments(
      [],
      [expected[0]!],
      comments
        .map((value, index) => ({
          type: "user_message",
          createdAt: start + index,
          payload: { text: "表示だけの文", origin, timeline_comments: [value] },
        }))
        .toReversed(),
    );
    expect(result).toEqual({ comments: expected, unresolvedComments: [] });
  },
);

test.prop([fc.string(), fc.string(), fc.string(), fc.integer({ min: 1, max: 100000 })])(
  "別IDが同じ前置きになる旧発言は原文のまま未確定にする",
  (id, title, body, at) => {
    const text = `タイムラインのタスク ${id}「join「${title}」について: ${body}`;
    expect(
      buildTimelineComments(
        [
          { id: `${id}「join`, title },
          { id, title: `join「${title}` },
        ],
        [],
        [{ type: "user_message", createdAt: at, payload: { origin: "developer", text } }],
      ),
    ).toEqual({ comments: [], unresolvedComments: [{ at, text, reason: "ambiguous_task" }] });
  },
);
