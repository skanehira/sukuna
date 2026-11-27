import { fc, test } from "@fast-check/vitest";
import {
  issueStateSchema,
  issueStopReasonSchema,
  stateChangeCauseSchema,
} from "../../../../shared/issue/state";
import { transition, type TransitionContext, type TransitionTrigger } from "./transition";

const state = fc.constantFrom(...issueStateSchema.options);
const omittable = <T>(value: fc.Arbitrary<T>) => fc.option(value, { nil: undefined });
const nullable = <T>(value: fc.Arbitrary<T>) => fc.option(value, { nil: null });

const context: fc.Arbitrary<TransitionContext> = fc.record({
  state: nullable(state),
  stopReason: omittable(nullable(fc.constantFrom(...issueStopReasonSchema.options))),
  stoppedFrom: omittable(nullable(state)),
  stoppedCause: omittable(nullable(fc.constantFrom(...stateChangeCauseSchema.options))),
  hasChildren: omittable(fc.boolean()),
  designed: omittable(fc.boolean()),
  triageResult: omittable(fc.constantFrom("design" as const, "parent" as const)),
  designPrMergePending: omittable(fc.boolean()),
  dependenciesDone: omittable(fc.boolean()),
  hasCapacity: omittable(fc.boolean()),
  stageEnabled: omittable(fc.boolean()),
  confirmBeforeMerge: omittable(fc.boolean()),
  mergeVerified: omittable(fc.boolean()),
  mergeSource: omittable(fc.constantFrom("agent" as const, "github" as const)),
  worktreeReady: omittable(fc.boolean()),
  hasWithdrawnDependencies: omittable(fc.boolean()),
  allChildrenClosed: omittable(fc.boolean()),
  hasDoneChild: omittable(fc.boolean()),
});
const trigger: fc.Arbitrary<TransitionTrigger> = fc.constantFrom(
  ...stateChangeCauseSchema.options,
  "create_draft",
  "design_reflect_failed",
);
const unfinished = fc.constantFrom(
  "draft",
  "triage",
  "design",
  "design_review",
  "ready",
  "implementing",
  "stopped",
) satisfies fc.Arbitrary<TransitionContext["state"]>;

test.prop([context, trigger])("止まった先へ移るときだけ止まった理由が付く", (c, t) => {
  const result = transition(c, t);
  return result === null || (result.to === "stopped") === (result.stopReason !== null);
});

test.prop([context, trigger])("止まっていない issue はいまの状態から移る", (c, t) => {
  const result = transition(c, t);
  return result === null || c.state === "stopped" || result.from === c.state;
});

test.prop([context, unfinished])(
  "取り下げ (withdraw) はどの未完了の状態からも取り下げに移る",
  (c, s) => transition({ ...c, state: s }, "withdraw")?.to === "withdrawn",
);

test.prop([context, trigger])("取り下げた issue は開き直す以外のきっかけでは移らない", (c, t) => {
  return transition({ ...c, state: "withdrawn" }, t) === null || t === "reopen";
});
