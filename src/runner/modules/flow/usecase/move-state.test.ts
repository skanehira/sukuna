import { describe, expect, it } from "vite-plus/test";
import { flowFixture } from "../test-support";
import { createMoveState } from "./move-state";

describe("状態と記録の同じトランザクションでの保存", () => {
  const f = flowFixture();

  it("設計の提出は状態と更新時刻を変えて記録し、コミット後に知らせる", () => {
    f.addIssue("design", 1);
    const before = f.issue("design");
    const move = createMoveState(f.deps);

    const result = move({ issueId: "design", trigger: "design_submitted" });

    expect(result).toEqual({
      kind: "moved",
      notice: { kind: "issue", issue_id: "design", project_id: "project", seq: 1 },
    });
    expect(f.issue("design")).toEqual({ ...before, state: "design_review", updatedAt: 1000 });
    expect(f.events("design")).toEqual([
      {
        issueId: "design",
        seq: 1,
        type: "state_changed",
        createdAt: 1000,
        payload: {
          from: "design",
          to: "design_review",
          stopReason: null,
          detail: null,
          cause: "design_submitted",
        },
      },
    ]);
    expect(f.notices).toEqual([
      { kind: "issue", issue_id: "design", project_id: "project", seq: 1 },
    ]);
    expect(f.noticeTransactions).toEqual([false]);
  });

  it("記録の保存に失敗したら状態も時刻も記録も残さず、知らせを出さない", () => {
    f.addIssue("design", 1);
    const before = f.issue("design");
    f.opened.sqlite.exec(
      "CREATE TRIGGER fail_event BEFORE INSERT ON issue_events BEGIN SELECT RAISE(ABORT, 'event failed'); END",
    );
    const move = createMoveState(f.deps);

    expect(() => move({ issueId: "design", trigger: "design_submitted" })).toThrow("event failed");

    expect(f.issue("design")).toEqual(before);
    expect(f.events("design")).toEqual([]);
    expect(f.notices).toEqual([]);
  });

  it.each([
    {
      initial: "implementing",
      trigger: "implementation_done",
      state: "done",
      githubNumber: 30,
      closedAt: 1000,
      facts: { mergeVerified: true },
    },
    {
      initial: "design",
      trigger: "withdraw",
      state: "withdrawn",
      githubNumber: null,
      closedAt: 1000,
      facts: {},
    },
    {
      initial: "done",
      trigger: "reopen",
      state: "triage",
      githubNumber: 30,
      closedAt: null,
      facts: {},
    },
    {
      initial: "withdrawn",
      trigger: "reopen",
      state: "triage",
      githubNumber: 30,
      closedAt: null,
      facts: {},
    },
  ] as const)(
    "$initial から $state に移すと閉じた時刻と GitHub の番号が揃う",
    ({ initial, trigger, state, githubNumber, closedAt, facts }) => {
      f.addIssue("issue", 1, { state: initial, githubNumber: 30, closedAt: 50 });
      const before = f.issue("issue");

      const result = createMoveState(f.deps)({ issueId: "issue", trigger, facts });

      expect(result).toEqual({
        kind: "moved",
        notice: { kind: "issue", issue_id: "issue", project_id: "project", seq: 1 },
      });
      expect(f.issue("issue")).toEqual({
        ...before,
        state,
        githubNumber,
        closedAt,
        stopReason: null,
        updatedAt: 1000,
      });
      expect(f.events("issue")).toEqual([
        {
          issueId: "issue",
          seq: 1,
          type: "state_changed",
          createdAt: 1000,
          payload: { from: initial, to: state, stopReason: null, detail: null, cause: trigger },
        },
      ]);
    },
  );

  it("停止を別の理由の停止に変えても from は元の停止前の状態を引き継ぎ、解消で戻れる", () => {
    f.addIssue("issue", 1);
    f.addIssue("dependency", 2, { state: "withdrawn" });
    const move = createMoveState(f.deps);
    move({ issueId: "issue", trigger: "agent_failed", detail: "API を呼べませんでした" });
    f.depend("issue", "dependency");

    const stopped = move({ issueId: "issue", trigger: "dependency_withdrawn" });
    f.removeDependency("issue");
    const resumed = move({ issueId: "issue", trigger: "dependency_cleared" });

    expect([stopped, resumed]).toEqual([
      {
        kind: "moved",
        notice: { kind: "issue", issue_id: "issue", project_id: "project", seq: 2 },
      },
      {
        kind: "moved",
        notice: { kind: "issue", issue_id: "issue", project_id: "project", seq: 3 },
      },
    ]);
    expect(f.events("issue")).toEqual([
      {
        issueId: "issue",
        seq: 1,
        type: "state_changed",
        createdAt: 1000,
        payload: {
          from: "design",
          to: "stopped",
          stopReason: "failed",
          detail: "API を呼べませんでした",
          cause: "agent_failed",
        },
      },
      {
        issueId: "issue",
        seq: 2,
        type: "state_changed",
        createdAt: 1000,
        payload: {
          from: "design",
          to: "stopped",
          stopReason: "dependency_withdrawn",
          detail: "#2",
          cause: "dependency_withdrawn",
        },
      },
      {
        issueId: "issue",
        seq: 3,
        type: "state_changed",
        createdAt: 1000,
        payload: {
          from: "stopped",
          to: "design",
          stopReason: null,
          detail: null,
          cause: "dependency_cleared",
        },
      },
    ]);
    expect(f.issue("issue")).toEqual({
      id: "issue",
      projectId: "project",
      number: 1,
      title: "issue",
      body: "",
      kind: null,
      state: "design",
      stopReason: null,
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
  });

  it("worktree の作り直しが再び失敗しても元の停止前の状態を保存する", () => {
    f.addIssue("issue", 1);
    const move = createMoveState(f.deps);
    move({
      issueId: "issue",
      trigger: "worktree_failed",
      detail: "worktree を作れませんでした: first",
    });

    move({
      issueId: "issue",
      trigger: "worktree_failed",
      detail: "worktree を作れませんでした: second",
    });
    move({ issueId: "issue", trigger: "agent_resumed", facts: { worktreeReady: true } });

    expect(f.events("issue")).toEqual([
      {
        issueId: "issue",
        seq: 1,
        type: "state_changed",
        createdAt: 1000,
        payload: {
          from: "design",
          to: "stopped",
          stopReason: "failed",
          detail: "worktree を作れませんでした: first",
          cause: "worktree_failed",
        },
      },
      {
        issueId: "issue",
        seq: 2,
        type: "state_changed",
        createdAt: 1000,
        payload: {
          from: "design",
          to: "stopped",
          stopReason: "failed",
          detail: "worktree を作れませんでした: second",
          cause: "worktree_failed",
        },
      },
      {
        issueId: "issue",
        seq: 3,
        type: "state_changed",
        createdAt: 1000,
        payload: {
          from: "stopped",
          to: "design",
          stopReason: null,
          detail: null,
          cause: "agent_resumed",
        },
      },
    ]);
  });

  it("停止前の状態は時刻が同じでも最新の停止の seq から求める", () => {
    f.addIssue("issue", 1, { state: "triage" });
    const move = createMoveState(f.deps);
    move({ issueId: "issue", trigger: "agent_failed", detail: "精査の失敗" });
    move({ issueId: "issue", trigger: "agent_resumed" });
    move({ issueId: "issue", trigger: "triage_reported", facts: { triageResult: "design" } });
    move({ issueId: "issue", trigger: "agent_question", detail: "設計の質問" });

    const result = move({ issueId: "issue", trigger: "agent_resumed" });

    expect(result).toEqual({
      kind: "moved",
      notice: { kind: "issue", issue_id: "issue", project_id: "project", seq: 5 },
    });
    expect(f.events("issue").at(-1)).toEqual({
      issueId: "issue",
      seq: 5,
      type: "state_changed",
      createdAt: 1000,
      payload: {
        from: "stopped",
        to: "design",
        stopReason: null,
        detail: null,
        cause: "agent_resumed",
      },
    });
  });

  it("精査は DB の設計済みと子の有無を使って実装待ちにする", () => {
    f.addIssue("designed", 1, { state: "triage", designed: true });
    f.addIssue("parent", 2, { state: "triage" });
    f.addIssue("child", 3, { parentId: "parent" });
    const move = createMoveState(f.deps);

    move({ issueId: "designed", trigger: "triage_reported", facts: { triageResult: "design" } });
    move({ issueId: "parent", trigger: "triage_reported", facts: { triageResult: "parent" } });

    expect([f.events("designed"), f.events("parent")]).toEqual([
      [
        {
          issueId: "designed",
          seq: 1,
          type: "state_changed",
          createdAt: 1000,
          payload: {
            from: "triage",
            to: "ready",
            stopReason: null,
            detail: null,
            cause: "triage_reported",
          },
        },
      ],
      [
        {
          issueId: "parent",
          seq: 1,
          type: "state_changed",
          createdAt: 1000,
          payload: {
            from: "triage",
            to: "ready",
            stopReason: null,
            detail: null,
            cause: "triage_reported",
          },
        },
      ],
    ]);
  });

  it("同じ報告を二度受けても二度目は状態も記録も知らせも増えない", () => {
    f.addIssue("issue", 1);
    const move = createMoveState(f.deps);
    move({ issueId: "issue", trigger: "design_submitted" });
    const before = f.issue("issue");
    const events = f.events("issue");

    expect(move({ issueId: "issue", trigger: "design_submitted" })).toEqual({ kind: "unchanged" });
    expect(f.issue("issue")).toEqual(before);
    expect(f.events("issue")).toEqual(events);
    expect(f.notices).toEqual([
      { kind: "issue", issue_id: "issue", project_id: "project", seq: 1 },
    ]);
  });

  it("記録しない反映失敗と見つからない issue は書き込みや知らせを行わない", () => {
    f.addIssue("issue", 1, { state: "design_review" });
    const before = f.issue("issue");
    const move = createMoveState(f.deps);

    expect(move({ issueId: "issue", trigger: "design_reflect_failed" })).toEqual({
      kind: "unchanged",
    });
    expect(move({ issueId: "missing", trigger: "confirm" })).toEqual({ kind: "not_found" });
    expect(f.issue("issue")).toEqual(before);
    expect(f.events("issue")).toEqual([]);
    expect(f.notices).toEqual([]);
  });

  it("既存のコメントも数えて issue ごとの次の seq で記録と知らせを出す", () => {
    f.addIssue("issue", 1);
    f.addIssue("other", 2);
    const seed = f.opened.sqlite.prepare(
      "INSERT INTO issue_events (issue_id, seq, type, payload, created_at) VALUES (?, ?, 'comment', '{}', 1)",
    );
    seed.run("issue", 7);
    seed.run("other", 20);

    const result = createMoveState(f.deps)({ issueId: "issue", trigger: "design_submitted" });

    expect(result).toEqual({
      kind: "moved",
      notice: { kind: "issue", issue_id: "issue", project_id: "project", seq: 8 },
    });
    expect(f.events("issue")).toEqual([
      { issueId: "issue", seq: 7, type: "comment", payload: {}, createdAt: 1 },
      {
        issueId: "issue",
        seq: 8,
        type: "state_changed",
        createdAt: 1000,
        payload: {
          from: "design",
          to: "design_review",
          stopReason: null,
          detail: null,
          cause: "design_submitted",
        },
      },
    ]);
    expect(f.notices).toEqual([
      { kind: "issue", issue_id: "issue", project_id: "project", seq: 8 },
    ]);
  });

  it.each(["done", "withdrawn"] as const)(
    "実装の開始では依存先の %s を DB から読み、完了だけを数える",
    (dependencyState) => {
      f.addIssue("issue", 1, { state: "ready" });
      f.addIssue("dependency", 2, { state: dependencyState });
      f.depend("issue", "dependency");
      const before = f.issue("issue");

      const result = createMoveState(f.deps)({
        issueId: "issue",
        trigger: "impl_started",
        facts: { hasCapacity: true, stageEnabled: true },
      });

      if (dependencyState === "done") {
        expect(result).toEqual({
          kind: "moved",
          notice: { kind: "issue", issue_id: "issue", project_id: "project", seq: 1 },
        });
        expect(f.issue("issue")).toEqual({ ...before, state: "implementing", updatedAt: 1000 });
      } else {
        expect(result).toEqual({ kind: "unchanged" });
        expect(f.issue("issue")).toEqual(before);
        expect(f.events("issue")).toEqual([]);
      }
    },
  );

  it.each([
    { children: ["done", "withdrawn"], closes: true },
    { children: ["withdrawn"], closes: false },
    { children: ["done", "design"], closes: false },
    { children: [], closes: false },
  ] as const)(
    "子が $children の親は、全て閉じて 1 件以上完了した場合だけ完了する",
    ({ children, closes }) => {
      f.addIssue("parent", 1, { state: "ready" });
      for (const [index, state] of children.entries()) {
        f.addIssue(`child-${index}`, index + 2, { state, parentId: "parent" });
      }
      const before = f.issue("parent");

      const result = createMoveState(f.deps)({ issueId: "parent", trigger: "children_closed" });

      if (closes) {
        expect(result).toEqual({
          kind: "moved",
          notice: { kind: "issue", issue_id: "parent", project_id: "project", seq: 1 },
        });
        expect(f.issue("parent")).toEqual({
          ...before,
          state: "done",
          updatedAt: 1000,
          closedAt: 1000,
        });
      } else {
        expect(result).toEqual({ kind: "unchanged" });
        expect(f.issue("parent")).toEqual(before);
        expect(f.events("parent")).toEqual([]);
      }
    },
  );

  it("設計 PR の merge 待ちは停止と復帰を挟んでも残り、merge の検証後に移せる", () => {
    f.addIssue("issue", 1);
    const seed = f.opened.sqlite.prepare(
      "INSERT INTO issue_events (issue_id, seq, type, payload, created_at) VALUES ('issue', ?, ?, '{}', 1)",
    );
    seed.run(1, "design_approved");
    seed.run(2, "design_pr_created");
    const move = createMoveState(f.deps);
    move({ issueId: "issue", trigger: "agent_failed", detail: "merge に失敗" });
    move({ issueId: "issue", trigger: "agent_resumed" });

    const result = move({ issueId: "issue", trigger: "design_reflected" });

    expect(result).toEqual({
      kind: "moved",
      notice: { kind: "issue", issue_id: "issue", project_id: "project", seq: 5 },
    });
    expect(f.events("issue").at(-1)).toEqual({
      issueId: "issue",
      seq: 5,
      type: "state_changed",
      createdAt: 1000,
      payload: {
        from: "design",
        to: "ready",
        stopReason: null,
        detail: null,
        cause: "design_reflected",
      },
    });
  });

  it.each(["design_reflected", "design_rejected", "design_approved"] as const)(
    "設計 PR の作成後に %s があれば以前の merge 待ちとして進めない",
    (eventType) => {
      f.addIssue("issue", 1);
      const seed = f.opened.sqlite.prepare(
        "INSERT INTO issue_events (issue_id, seq, type, payload, created_at) VALUES ('issue', ?, ?, '{}', 1)",
      );
      seed.run(1, "design_approved");
      seed.run(2, "design_pr_created");
      seed.run(3, eventType);
      const before = f.issue("issue");
      const beforeEvents = f.events("issue");

      const result = createMoveState(f.deps)({ issueId: "issue", trigger: "design_reflected" });

      expect(result).toEqual({ kind: "unchanged" });
      expect(f.issue("issue")).toEqual(before);
      expect(f.events("issue")).toEqual(beforeEvents);
      expect(f.notices).toEqual([]);
    },
  );
});
