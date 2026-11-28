import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import type { ConversationQueueItem } from "../../../../shared/conversation/api";
import { editDeliveryContext } from "./edit-delivery-context";

const prose = fc
  .array(fc.constantFrom("a", "あ", "😀", " ", "\n"), { maxLength: 12 })
  .map((letters) => letters.join(""));

function compose(bodies: string[], protectedGaps: string[]) {
  let text = "[開始]";
  const ranges = bodies.map((body, index) => {
    const from = text.length;
    text += body;
    const range = { from, to: text.length };
    text += protectedGaps[index] ?? "";
    return range;
  });
  return { text: text + "[終了]", ranges };
}

test.prop([
  fc.array(fc.tuple(prose, prose, fc.integer({ min: 0, max: 2 })), { minLength: 1, maxLength: 5 }),
])("同じ生成文が繰り返されても、順番で区別できる本文を編集どおりに復元する", (sections) => {
  const previousBodies = sections.map(([previous]) => previous);
  const nextBodies = sections.map(([, next]) => next);
  const gaps = sections.slice(0, -1).map(([, , id]) => `[引用${id}]`);
  const previous = compose(previousBodies, gaps);
  const next = compose(nextBodies, gaps);
  const joined = (bodies: string[]) => bodies.filter(Boolean).join("\n\n");
  const item: ConversationQueueItem = {
    id: "queued",
    text: previous.text,
    images: [],
    position: 1,
    stockItemId: null,
    clientId: null,
    createdAt: 1,
    deliveryContext: {
      original: { text: joined(previousBodies), images: [] },
      originalRanges: previous.ranges,
    },
  };
  const result = editDeliveryContext(item, { text: next.text, images: [] });
  expect(result?.context?.original?.text ?? "").toBe(joined(nextBodies));
  expect(result?.context?.originalRanges).toEqual(next.ranges);
});
