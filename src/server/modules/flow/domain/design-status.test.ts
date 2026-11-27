import { describe, expect, it } from "vitest";
import type { IssueState } from "../../../../shared/issue/state";
import { designStatus, type DesignEvent } from "./design-status";

const submitted = { type: "design_submitted", payload: {}, createdAt: 5 };
const approved = { type: "design_approved", payload: { mode: "pr" }, createdAt: 5 };
const created = {
  type: "design_pr_created",
  payload: { prUrl: "https://example.test/pr/1" },
  createdAt: 5,
};
const reflected = { type: "design_reflected", payload: { mode: "pr" }, createdAt: 5 };
const failed = { type: "design_reflect_failed", payload: { message: "失敗" }, createdAt: 5 };
const rejected = { type: "design_rejected", payload: { via: "reject" }, createdAt: 5 };
const stopped = (cause: string) => ({
  type: "state_changed",
  payload: { from: "design", to: "stopped", cause },
  createdAt: 5,
});

describe("設計の状況", () => {
  it.each<{ state: IssueState; history: Omit<DesignEvent, "seq">[]; status: string }>([
    { state: "design", history: [], status: "none" },
    { state: "design", history: [submitted, rejected], status: "designing" },
    { state: "design_review", history: [submitted], status: "reviewing" },
    { state: "design_review", history: [submitted, approved], status: "reflecting" },
    { state: "design", history: [submitted, approved, created], status: "merging_pr" },
    {
      state: "stopped",
      history: [submitted, approved, created, stopped("design_pr_not_merged")],
      status: "merge_failed",
    },
    { state: "ready", history: [submitted, approved, created, reflected], status: "approved" },
    {
      state: "stopped",
      history: [submitted, approved, created, stopped("agent_usage_limit")],
      status: "merging_pr",
    },
    { state: "design_review", history: [submitted, approved, failed], status: "reviewing" },
    {
      state: "design_review",
      history: [submitted, approved, failed, approved],
      status: "reflecting",
    },
  ])("記録順と状態 $state から $status を返す", ({ state, history, status }) => {
    const events = history.map((event, i) => ({ ...event, seq: i + 1 }));
    expect(designStatus(state, events)).toBe(status);
  });
});
