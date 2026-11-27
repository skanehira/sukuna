import { fc, test } from "@fast-check/vitest";
import { expect, it } from "vite-plus/test";
import { reasonSchema } from "../../../../shared/inbox/schema";
import { startsNotification } from "./notification";

test.prop([
  fc.constantFrom(undefined, "working" as const),
  fc.constantFrom("decision" as const, "instruction" as const),
  fc.constantFrom(
    ...reasonSchema.options.filter((reason) => reason !== "thread" && reason !== "stopped_by_user"),
  ),
])("一覧に無いか作業中の対象が通知できる待ち状態に入ると知らせる", (previous, section, reason) => {
  expect(
    startsNotification(previous, { kind: "conversation", section, reason, unread: true }),
  ).toBe(true);
});

it.each([
  {
    previous: "instruction",
    section: "decision",
    reason: "question",
    unread: true,
    expected: true,
  },
  {
    previous: "decision",
    section: "instruction",
    reason: "turn_ended",
    unread: true,
    expected: false,
  },
  {
    previous: "decision",
    section: "decision",
    reason: "permission",
    unread: true,
    expected: false,
  },
  {
    previous: "working",
    section: "working",
    reason: "summarizing",
    unread: true,
    expected: false,
  },
  {
    previous: "working",
    section: "instruction",
    reason: "stopped_by_user",
    unread: true,
    expected: false,
  },
  {
    previous: "working",
    section: "decision",
    reason: "thread",
    unread: true,
    expected: false,
  },
  {
    previous: undefined,
    section: "decision",
    reason: "restarted",
    unread: true,
    alreadyObserved: true,
    expected: false,
  },
  {
    previous: "working",
    section: "instruction",
    reason: "turn_ended",
    unread: false,
    expected: false,
  },
] as const)(
  "通知の条件 $previous → $section $reason $unread",
  ({ previous, section, reason, unread, expected, alreadyObserved }) => {
    expect(
      startsNotification(
        previous,
        { kind: "conversation", section, reason, unread },
        alreadyObserved,
      ),
    ).toBe(expected);
  },
);
