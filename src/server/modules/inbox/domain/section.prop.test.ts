import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { conversationSection, issueSection, type ConversationFacts } from "./section";
import { issueStateSchema, issueStopReasonSchema } from "../../../../shared/issue/state";
const facts = fc.record({
  runState: fc.constantFrom(
    "working",
    "idle",
    "waiting_answer",
    "waiting_permission",
    "failed",
    "usage_limited",
    "stopped",
  ),
  stopReason: fc.constantFrom(null, "user", "restarted"),
  closedAt: fc.constant(null),
  pendingRecap: fc.boolean(),
  unansweredQuestions: fc.nat(20),
  developerTurn: fc.boolean(),
});
test.prop([facts])("会話の状態に関係なく開いたスレッドの判断待ちを優先する", (c) => {
  expect(conversationSection(c, true)).toEqual({ section: "decision", reason: "thread" });
});
test.prop([
  fc.constantFrom(...issueStateSchema.options),
  fc.constantFrom(...issueStopReasonSchema.options),
  facts,
])(
  "issueの独自の判断待ち理由は保ち、ほかの状態ではスレッドの判断待ちになる",
  (state, stopReason, c: ConversationFacts) => {
    const result = issueSection(state, stopReason, c, true);
    const preserved =
      state === "stopped"
        ? stopReason
        : state === "design_review"
          ? "design_review"
          : ["triage", "design", "implementing"].includes(state) &&
              ["waiting_answer", "waiting_permission", "failed", "usage_limited"].includes(
                c.runState,
              )
            ? (
                {
                  waiting_answer: "question",
                  waiting_permission: "permission",
                  failed: "failed",
                  usage_limited: "usage_limited",
                } as Record<string, string>
              )[c.runState]
            : "thread";
    expect(result).toEqual({ section: "decision", reason: preserved });
  },
);
