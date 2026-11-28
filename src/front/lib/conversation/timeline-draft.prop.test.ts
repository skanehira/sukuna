import { ChangeSet } from "@codemirror/state";
import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import {
  commentsFromAnchors,
  joinDraftContent,
  validTimelineAnchors,
} from "../../../shared/progress/draft";
import { consultationPrefix } from "../work-actions";
import { consultationContent, mapTimelineAnchors } from "./timeline-draft";

test.prop([
  fc.array(fc.record({ id: fc.string(), title: fc.string(), body: fc.string() }), {
    minLength: 1,
    maxLength: 12,
  }),
])("本文と任意の会話文をつないでも、相談の所属と本文を元の順で取り出せる", (consultations) => {
  const draft = consultations.reduce(
    (previous, { id, title, body }) => {
      const next = consultationContent(consultationPrefix(id, title), id);
      const text = next.text + body;
      const anchors = mapTimelineAnchors(
        next.timeline_anchors,
        next.text,
        text,
        ChangeSet.of({ from: next.text.length, insert: body }, next.text.length),
      );
      return joinDraftContent(
        joinDraftContent(previous, { text, images: [], timeline_anchors: anchors }),
        { text: "普通の指示\n", images: [] },
      );
    },
    joinDraftContent({ text: "", images: [] }, { text: "送信前の文章", images: [] }),
  );
  expect(validTimelineAnchors(draft)).toBe(true);
  expect(commentsFromAnchors(draft.text, draft.timeline_anchors ?? [])).toEqual(
    consultations.map(({ id, body }) => ({ task_id: id, text: body })),
  );
});

test.prop([
  fc.record({ id: fc.string(), title: fc.string(), body: fc.string(), before: fc.string() }),
])(
  "文字が同じでも前置きを通常の文字から貼り直したときは、選んだ相談先を外す",
  ({ id, title, body, before }) => {
    const prefix = consultationPrefix(id, title);
    const marked = consultationContent(prefix, id);
    const withBody = {
      text: prefix + body,
      images: [],
      timeline_anchors: [{ ...marked.timeline_anchors[0], to: prefix.length + body.length }],
    };
    const draft = joinDraftContent({ text: before, images: [] }, withBody);
    const from = before ? before.length + 2 : 0;
    const edits = ChangeSet.of(
      { from, to: from + prefix.length, insert: prefix },
      draft.text.length,
    );
    expect(mapTimelineAnchors(draft.timeline_anchors!, draft.text, draft.text, edits)).toEqual([]);
  },
);
