import { describe, expect, it } from "vite-plus/test";
import { flowFixture } from "../test-support";
import { createMoveState } from "./move-state";
import { createDependencyWithdrawn } from "./dependency-withdrawn";

describe("依存先の取り下げと解消", () => {
  const f = flowFixture();

  it("取り下げと依存元の停止をまとめて保存し、依存元で動く段階の会話だけ止める", async () => {
    f.addIssue("target", 10, { githubNumber: 100 });
    f.addIssue("previous", 2, { state: "withdrawn" });
    const active = ["triage", "design", "design_review", "ready", "implementing"] as const;
    for (const [index, state] of active.entries()) {
      f.addIssue(state, 20 + index, { state });
      f.depend(state, "target");
      f.depend(state, "previous");
      f.addConversation(`${state}-working`, state, { kind: index % 2 === 0 ? "triage" : "impl" });
    }
    f.addIssue("other-stop", 30, { state: "stopped", stopReason: "question" });
    f.depend("other-stop", "target");
    f.addConversation("other-stop-working", "other-stop");
    const unchanged = ["draft", "done", "withdrawn"] as const;
    for (const [index, state] of unchanged.entries()) {
      f.addIssue(state, 40 + index, { state });
      f.depend(state, "target");
      f.addConversation(`${state}-working`, state);
    }
    f.addIssue("unrelated", 50);
    f.addConversation("own-working", "target");
    f.addConversation("unrelated-working", "unrelated");
    f.addConversation("chat-working", "design", { kind: "chat" });
    f.addConversation("thread-working", "design", { kind: "thread" });
    f.addConversation("design-waiting", "design", { runState: "waiting_answer" });
    const before = f.issue("target");
    const otherStop = f.issue("other-stop");
    const beforeUnchanged = unchanged.map((id) => f.issue(id));

    const result = await createDependencyWithdrawn(f.deps).withdraw("target");

    expect(result).toEqual({
      kind: "moved",
      notice: { kind: "issue", issue_id: "target", project_id: "project", seq: 1 },
    });
    expect(await createDependencyWithdrawn(f.deps).withdraw("target")).toEqual({
      kind: "unchanged",
    });
    expect(f.issue("target")).toEqual({
      ...before,
      state: "withdrawn",
      githubNumber: null,
      updatedAt: 1000,
      closedAt: 1000,
    });
    for (const state of active) {
      expect(f.events(state)).toEqual([
        {
          issueId: state,
          seq: 1,
          type: "state_changed",
          createdAt: 1000,
          payload: {
            from: state,
            to: "stopped",
            stopReason: "dependency_withdrawn",
            detail: "#2 #10",
            cause: "dependency_withdrawn",
          },
        },
      ]);
      expect(f.issue(state)).toEqual({
        id: state,
        projectId: "project",
        number: 20 + active.indexOf(state),
        title: state,
        body: "",
        kind: null,
        state: "stopped",
        stopReason: "dependency_withdrawn",
        parentId: null,
        priority: null,
        designed: false,
        confirmBeforeMerge: false,
        prUrl: null,
        githubNumber: null,
        createdConversationId: null,
        createdAt: 1,
        updatedAt: 1000,
        closedAt: null,
      });
    }
    expect(f.events("target")).toEqual([
      {
        issueId: "target",
        seq: 1,
        type: "state_changed",
        createdAt: 1000,
        payload: {
          from: "design",
          to: "withdrawn",
          stopReason: null,
          detail: null,
          cause: "withdraw",
        },
      },
    ]);
    expect(f.issue("other-stop")).toEqual(otherStop);
    expect(unchanged.map((id) => f.issue(id))).toEqual(beforeUnchanged);
    expect(f.stopped.toSorted()).toEqual(
      [
        "triage-working",
        "design-working",
        "design_review-working",
        "ready-working",
        "implementing-working",
        "other-stop-working",
      ].toSorted(),
    );
    expect(f.notices).toEqual(
      ["target", ...active].map((id) => ({
        kind: "issue",
        issue_id: id,
        project_id: "project",
        seq: 1,
      })),
    );
    expect(f.noticeTransactions).toEqual([false, false, false, false, false, false]);
    expect(f.stopTransactions).toEqual([false, false, false, false, false, false]);
  });

  it("依存元の保存が失敗すると取り下げもすべての依存元の停止も戻し、AI は止めない", async () => {
    f.addIssue("target", 1, { githubNumber: 100 });
    f.addIssue("first", 2);
    f.addIssue("second", 3);
    f.depend("first", "target");
    f.depend("second", "target");
    f.addConversation("first-conversation", "first");
    const before = ["target", "first", "second"].map((id) => f.issue(id));
    f.opened.sqlite.exec(
      "CREATE TRIGGER fail_dependent BEFORE INSERT ON issue_events WHEN NEW.issue_id = 'second' BEGIN SELECT RAISE(ABORT, 'dependent failed'); END",
    );

    await expect(createDependencyWithdrawn(f.deps).withdraw("target")).rejects.toThrow(
      "dependent failed",
    );

    expect(["target", "first", "second"].map((id) => f.issue(id))).toEqual(before);
    expect(["target", "first", "second"].map((id) => f.events(id))).toEqual([[], [], []]);
    expect(f.notices).toEqual([]);
    expect(f.stopped).toEqual([]);
  });

  it.each(["triage", "design", "design_review", "ready", "implementing"] as const)(
    "依存を外すと %s から止まった issue が元の状態へ戻る",
    async (state) => {
      f.addIssue("target", 1);
      f.addIssue("dependent", 2, { state });
      f.depend("dependent", "target");
      const service = createDependencyWithdrawn(f.deps);
      await service.withdraw("target");

      expect(service.clear("dependent")).toEqual({ kind: "unchanged" });
      f.removeDependency("dependent");
      expect(service.clear("dependent")).toEqual({
        kind: "moved",
        notice: { kind: "issue", issue_id: "dependent", project_id: "project", seq: 2 },
      });
      expect(service.clear("dependent")).toEqual({ kind: "unchanged" });

      expect(f.events("dependent")).toEqual([
        {
          issueId: "dependent",
          seq: 1,
          type: "state_changed",
          createdAt: 1000,
          payload: {
            from: state,
            to: "stopped",
            stopReason: "dependency_withdrawn",
            detail: "#1",
            cause: "dependency_withdrawn",
          },
        },
        {
          issueId: "dependent",
          seq: 2,
          type: "state_changed",
          createdAt: 1000,
          payload: {
            from: "stopped",
            to: state,
            stopReason: null,
            detail: null,
            cause: "dependency_cleared",
          },
        },
      ]);
    },
  );

  it("取り下げた依存先がすべて再開するまで戻らず、最後の再開で戻る", async () => {
    f.addIssue("first", 1);
    f.addIssue("second", 2, { state: "withdrawn" });
    f.addIssue("dependent", 3, { state: "implementing" });
    f.depend("dependent", "first");
    f.depend("dependent", "second");
    const service = createDependencyWithdrawn(f.deps);
    const move = createMoveState(f.deps);
    await service.withdraw("first");
    move({ issueId: "first", trigger: "reopen" });

    expect(service.clear("dependent")).toEqual({ kind: "unchanged" });
    move({ issueId: "second", trigger: "reopen" });
    expect(service.clear("dependent")).toEqual({
      kind: "moved",
      notice: { kind: "issue", issue_id: "dependent", project_id: "project", seq: 2 },
    });
    expect(f.events("dependent")).toEqual([
      {
        issueId: "dependent",
        seq: 1,
        type: "state_changed",
        createdAt: 1000,
        payload: {
          from: "implementing",
          to: "stopped",
          stopReason: "dependency_withdrawn",
          detail: "#1 #2",
          cause: "dependency_withdrawn",
        },
      },
      {
        issueId: "dependent",
        seq: 2,
        type: "state_changed",
        createdAt: 1000,
        payload: {
          from: "stopped",
          to: "implementing",
          stopReason: null,
          detail: null,
          cause: "dependency_cleared",
        },
      },
    ]);
  });

  it.each([
    { state: "design", stop: "needs_human", reason: "question", resume: "agent_resumed" },
    { state: "design", stop: "agent_failed", reason: "failed", resume: "agent_resumed" },
    { state: "design", stop: "agent_usage_limit", reason: "usage_limit", resume: "agent_resumed" },
    { state: "implementing", stop: "ci_failed", reason: "ci_failed", resume: "impl_instruction" },
    {
      state: "implementing",
      stop: "ready_for_merge",
      reason: "merge_confirm",
      resume: "merge_allowed",
    },
    {
      state: "implementing",
      stop: "ready_for_merge",
      reason: "merge_confirm",
      resume: "impl_instruction",
    },
  ] as const)(
    "$reason の停止から $resume で戻るときも、取り下げの依存先があれば停止し、解消で元に戻る",
    async ({ state, stop, reason, resume }) => {
      f.addIssue("target", 1);
      f.addIssue("dependent", 2, { state, confirmBeforeMerge: true });
      f.depend("dependent", "target");
      const move = createMoveState(f.deps);
      move({ issueId: "dependent", trigger: stop, detail: "停止の説明" });
      const service = createDependencyWithdrawn(f.deps);
      await service.withdraw("target");

      expect(move({ issueId: "dependent", trigger: resume })).toEqual({
        kind: "moved",
        notice: { kind: "issue", issue_id: "dependent", project_id: "project", seq: 2 },
      });
      f.removeDependency("dependent");
      expect(service.clear("dependent")).toEqual({
        kind: "moved",
        notice: { kind: "issue", issue_id: "dependent", project_id: "project", seq: 3 },
      });
      expect(f.events("dependent")).toEqual([
        {
          issueId: "dependent",
          seq: 1,
          type: "state_changed",
          createdAt: 1000,
          payload: {
            from: state,
            to: "stopped",
            stopReason: reason,
            detail: "停止の説明",
            cause: stop,
          },
        },
        {
          issueId: "dependent",
          seq: 2,
          type: "state_changed",
          createdAt: 1000,
          payload: {
            from: state,
            to: "stopped",
            stopReason: "dependency_withdrawn",
            detail: "#1",
            cause: "dependency_withdrawn",
          },
        },
        {
          issueId: "dependent",
          seq: 3,
          type: "state_changed",
          createdAt: 1000,
          payload: {
            from: "stopped",
            to: state,
            stopReason: null,
            detail: null,
            cause: "dependency_cleared",
          },
        },
      ]);
    },
  );
});
