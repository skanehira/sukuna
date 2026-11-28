import { describe, expect, it } from "vite-plus/test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { issueViewSchema } from "../../../../shared/issue/schema";
import { createWorktreeActivity } from "../../../../shared/workspace/sqlite-worktree-activity";
import { issueFixture, expectedIssue, git, ScriptedAgent } from "../issue-ops-test-support";

describe("ランナー側の issue 操作の再検査", () => {
  const f = issueFixture();
  it.each(
    (["triage", "design", "impl"] as const).flatMap((kind) =>
      (["working", "waiting_answer", "waiting_permission"] as const).map((runState) => ({
        kind,
        runState,
      })),
    ),
  )(
    "$kind/$runState の停止時には本人と依存元の変更がcommitされている",
    async ({ kind, runState }) => {
      f.addIssue("i", 1);
      f.addIssue("dependent", 2);
      f.depend("dependent", "i");
      const step =
        runState === "working"
          ? { hold: true as const }
          : runState === "waiting_answer"
            ? { ask: [{ question: "方針", header: "方針", options: [], multi_select: false }] }
            : { permission: { tool_name: "Bash", input: {} } };
      const observed: unknown[] = [];
      const agent = new ScriptedAgent({
        rules: [{ match: "本人", steps: [step, { hold: true }] }],
        fallback: [{ hold: true }],
      });
      const open = agent.open.bind(agent);
      agent.open = (params) => {
        const session = open(params);
        const interrupt = session.interrupt.bind(session);
        session.interrupt = async () => {
          observed.push({
            issues: f.opened.sqlite.prepare("SELECT id,state FROM issues ORDER BY number").all(),
            events: [f.events("i"), f.events("dependent")].map((rows) =>
              rows.map(({ payload }) => payload),
            ),
          });
          await interrupt();
        };
        return session;
      };
      f.runner.runtime.options.agent = agent;
      const ids: string[] = [];
      for (const [issueId, message] of [
        ["i", "本人"],
        ["dependent", "依存元"],
      ]) {
        ids.push(
          (
            await f.runner.runtime.start({
              projectId: "p",
              issueId,
              kind,
              title: "段階",
              cwd: f.home,
              message,
            })
          )._unsafeUnwrap().conversationId,
        );
      }
      await f.until(() => f.runner.runtime.store.get(ids[0]!)?.runState === runState);
      const response = await f.request("/api/issues/i/withdraw", "POST");
      expect(response.status).toBe(200);
      expect(observed).toEqual(
        [1, 2].map(() => ({
          issues: [
            { id: "i", state: "withdrawn" },
            { id: "dependent", state: "stopped" },
          ],
          events: [
            [
              {
                from: "triage",
                to: "withdrawn",
                stopReason: null,
                detail: null,
                cause: "withdraw",
              },
            ],
            [
              {
                from: "triage",
                to: "stopped",
                stopReason: "dependency_withdrawn",
                detail: "#1",
                cause: "dependency_withdrawn",
              },
            ],
          ],
        })),
      );
      expect(ids.map((id) => f.runner.runtime.store.get(id)?.runState)).toEqual([
        "stopped",
        "stopped",
      ]);
    },
  );
  it("依存元の状態を保存できなければ本人も依存元も止めず、保存できれば止める", async () => {
    f.addIssue("i", 1);
    f.addIssue("dependent", 2);
    f.depend("dependent", "i");
    let stops = 0;
    const agent = new ScriptedAgent({ rules: [], fallback: [{ hold: true }] });
    const open = agent.open.bind(agent);
    agent.open = (params) => {
      const session = open(params);
      const interrupt = session.interrupt.bind(session);
      session.interrupt = async () => {
        stops++;
        await interrupt();
      };
      return session;
    };
    f.runner.runtime.options.agent = agent;
    const ids: string[] = [];
    for (const issueId of ["i", "dependent"]) {
      ids.push(
        (
          await f.runner.runtime.start({
            projectId: "p",
            issueId,
            kind: "triage",
            title: "精査",
            cwd: f.home,
            message: "開始",
          })
        )._unsafeUnwrap().conversationId,
      );
    }
    f.opened.sqlite.exec(
      "CREATE TRIGGER reject_withdraw BEFORE INSERT ON issue_events WHEN NEW.issue_id = 'dependent' AND NEW.type = 'state_changed' BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
    );
    const failed = await f.request("/api/issues/i/withdraw", "POST");
    expect({
      status: failed.status,
      stops,
      states: ids.map((id) => f.runner.runtime.store.get(id)?.runState),
      issues: f.opened.sqlite.prepare("SELECT state FROM issues ORDER BY number").all(),
      events: [f.events("i"), f.events("dependent")],
    }).toEqual({
      status: 500,
      stops: 0,
      states: ["working", "working"],
      issues: [{ state: "triage" }, { state: "triage" }],
      events: [[], []],
    });
    f.opened.sqlite.exec("DROP TRIGGER reject_withdraw");
    expect((await f.request("/api/issues/i/withdraw", "POST")).status).toBe(200);
    expect({ stops, states: ids.map((id) => f.runner.runtime.store.get(id)?.runState) }).toEqual({
      stops: 2,
      states: ["stopped", "stopped"],
    });
  });
  it("画面側を通さなくても確定後の本文や閉じた行の編集を受け付けない", async () => {
    f.addIssue("draft", 1, { state: "draft", title: "" });
    f.addIssue("i", 2);
    f.addIssue("closed", 3, { state: "done" });
    for (const [method, path, input, status, code] of [
      ["POST", "/flow/issues/draft/confirm", undefined, 400, "title_required"],
      ["POST", "/flow/issues/i/confirm", undefined, 409, "conflict"],
      ["POST", "/flow/issues/i/reopen", undefined, 409, "conflict"],
      ["POST", "/flow/issues/closed/withdraw", undefined, 409, "conflict"],
      ["PATCH", "/flow/issues/i", { title: "書換" }, 400, "invalid_input"],
      ["PATCH", "/flow/issues/i", { priority: null }, 400, "invalid_input"],
      ["PATCH", "/flow/issues/closed", { priority: "high" }, 409, "conflict"],
      ["PATCH", "/flow/issues/draft", { priority: "high" }, 409, "conflict"],
      ["POST", "/flow/issues/missing/confirm", undefined, 404, "not_found"],
      ["POST", "/flow/issues/missing/reopen", undefined, 404, "not_found"],
      ["POST", "/flow/issues/missing/withdraw", undefined, 404, "not_found"],
      ["PATCH", "/flow/issues/missing", { priority: "high" }, 404, "not_found"],
    ] as const) {
      const response = (await f.link.call(method, path, input))._unsafeUnwrap();
      const messages = {
        title_required: "題名を書いてから確定してください",
        conflict: "issue の状態が変わりました。読み直してから操作してください。",
        invalid_input: "入力の長さ・番号・件数を確認してください。",
        not_found: "issue またはプロジェクトが見つかりません。読み直してください。",
      };
      expect(response).toEqual({
        status,
        body: {
          error: {
            code,
            message:
              code === "invalid_input" && path === "/flow/issues/i" && input && "priority" in input
                ? "確定した issue の優先度は無しに戻せません"
                : messages[code],
          },
        },
      });
    }
    expect(f.events("i")).toEqual([]);
  });
  it("ランナーが親と依存の循環を調べ、繰り返す依存番号は1つにする", async () => {
    f.addIssue("i", 1);
    f.addIssue("other", 2);
    f.depend("other", "i");
    const invalid = (
      await f.link.call("PATCH", "/flow/issues/i", { depends_on: [2] })
    )._unsafeUnwrap();
    expect(invalid).toEqual({
      status: 400,
      body: {
        error: {
          code: "dependency_cycle",
          message: "#1 → #2 → #1 が循環しています。依存を保存しませんでした",
        },
      },
    });
    const valid = (
      await f.link.call("PATCH", "/flow/issues/other", {
        parent_number: 1,
        depends_on: [1, 1],
        confirm_before_merge: true,
      })
    )._unsafeUnwrap();
    expect(valid).toEqual({
      status: 200,
      body: {
        issue: expectedIssue({
          id: "other",
          number: 2,
          title: "other",
          confirmBeforeMerge: true,
          parent: { id: "i", number: 1, title: "i", state: "triage" },
          dependsOn: [{ id: "i", number: 1, title: "i", state: "triage" }],
        }),
      },
    });
  });
});

describe("確定した issue の変更を自動フローに反映する", () => {
  let canCloseTerminal = true;
  const f = issueFixture(undefined, {
    autoFlow: true,
    terminalCleanup: () => (canCloseTerminal ? async () => {} : undefined),
  });

  function repository() {
    canCloseTerminal = true;
    const root = join(realpathSync(f.home), "repo");
    mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "commit", "--allow-empty", "-qm", "base");
    f.opened.sqlite
      .prepare("UPDATE projects SET path = ?, impl_concurrency = 1 WHERE id = 'p'")
      .run(root);
    return root;
  }

  async function view(id: string) {
    const response = await f.request(`/api/issues/${id}`);
    return issueViewSchema.parse(((await response.json()) as { issue: unknown }).issue);
  }

  function stage(id: string, kind: "design" | "impl") {
    return f.runner.runtime.store.list().find((c) => c.issueId === id && c.kind === kind);
  }

  async function api(path: string, method: string, body?: unknown) {
    expect((await f.request(path, method, body)).status).toBe(200);
  }

  async function evaluate(id: string) {
    const result = await f.link.forward("POST", "/flow/notify", { issue_id: id });
    expect(result.status).toBe(200);
  }

  const complete = (number: number, sha: string) => ({
    tool: "mcp__sukuna__report_implementation_done",
    input: { number, merge_commit: sha, summary: "完了" },
  });

  it("依存先の実装が完了するまでは会話を作らず、完了の報告で始める", async () => {
    const root = repository();
    const sha = git(root, "rev-parse", "HEAD");
    f.runner.runtime.options.agent = new ScriptedAgent({
      rules: [{ match: "^完了を報告", steps: [complete(41, sha), { end: "success" }] }],
      fallback: [{ hold: true }],
    });
    f.addIssue("dependency", 41, { state: "ready" });
    f.addIssue("waiting", 43, { state: "ready", priority: "high" });
    f.depend("waiting", "dependency");
    await evaluate("waiting");
    await expect
      .poll(() => stage("dependency", "impl")?.runState, { timeout: 3000 })
      .toBe("working");
    expect((await view("waiting")).state).toBe("ready");
    expect(stage("waiting", "impl")).toBeUndefined();

    const id = stage("dependency", "impl")!.id;
    expect((await f.runner.runtime.stop(id)).isOk()).toBe(true);
    expect(
      (
        await f.link.forward("POST", `/conversations/${id}/messages`, {
          text: "完了を報告する",
          origin: "developer",
          images: [],
          interrupt: false,
          client_id: "issue-ops-completion",
        })
      ).status,
    ).toBe(200);
    await expect.poll(() => stage("waiting", "impl")?.runState, { timeout: 3000 }).toBe("working");
    expect([(await view("dependency")).state, (await view("waiting")).state]).toEqual([
      "done",
      "implementing",
    ]);
  });

  it("確定後に親と未完了の依存先を外すと、元の親から外れて実装を始める", async () => {
    repository();
    f.addIssue("parent", 40, { state: "triage" });
    f.addIssue("dependency", 41, { state: "design_review" });
    f.addIssue("waiting", 43, { state: "ready", parentId: "parent" });
    f.depend("waiting", "dependency");
    expect((await view("parent")).children.map(({ number }) => number)).toEqual([43]);
    expect((await view("waiting")).dependsOn.map(({ number }) => number)).toEqual([41]);
    await api("/api/issues/waiting", "PATCH", { parentNumber: null, dependsOn: [] });
    await expect
      .poll(async () => (await view("waiting")).state, { timeout: 3000 })
      .toBe("implementing");
    expect((await view("parent")).children).toEqual([]);
    expect(await view("waiting")).toMatchObject({ parent: null, dependsOn: [] });
  });

  it("実装枠が一つなら更新した優先度の高・中・低の順に始める", async () => {
    const root = repository();
    const sha = git(root, "rev-parse", "HEAD");
    const order: string[] = [];
    const agent = new ScriptedAgent({
      rules: [41, 42, 43].map((number) => ({
        match: `^#${number}`,
        steps: [complete(number, sha), { end: "success" }],
      })),
    });
    const open = agent.open.bind(agent);
    agent.open = (params) => {
      if (params.context.issueId) order.push(params.context.issueId);
      return open(params);
    };
    f.runner.runtime.options.agent = agent;
    f.addIssue("first", 43, { state: "ready", priority: "low" });
    f.addIssue("next", 42, { state: "ready", priority: "medium" });
    f.addIssue("last", 41, { state: "ready", priority: "low" });
    await api("/api/issues/first", "PATCH", { priority: "high" });
    await expect.poll(async () => (await view("last")).state, { timeout: 4000 }).toBe("done");
    expect(order).toEqual(["first", "next", "last"]);
  });

  it("優先度なしの確定で精査が高を付け、その後開発者が低に変えられる", async () => {
    repository();
    f.addIssue("i", 42, { state: "draft", title: "予約" });
    f.runner.runtime.options.agent = new ScriptedAgent({
      rules: [
        {
          match: "^#42「予約」を精査",
          steps: [
            {
              tool: "mcp__sukuna__report_triage",
              input: {
                number: 42,
                result: "design",
                kind: "enhancement",
                score: 9.5,
                summary: "精査が完了",
              },
            },
            { end: "success" },
          ],
        },
      ],
      fallback: [{ hold: true }],
    });
    await api("/api/issues/i/confirm", "POST");
    await expect.poll(async () => (await view("i")).priority, { timeout: 3000 }).toBe("high");
    await api("/api/issues/i", "PATCH", { priority: "low" });
    expect((await view("i")).priority).toBe("low");
  });

  it("残りの子を取り下げると親が完了し、完了した子を再開すると親が実装待ちに戻る", async () => {
    repository();
    f.addIssue("parent", 41, { state: "ready" });
    f.addIssue("done", 42, { state: "done", parentId: "parent" });
    f.addIssue("open", 43, { state: "triage", parentId: "parent" });
    await api("/api/issues/open/withdraw", "POST");
    await expect.poll(async () => (await view("parent")).state).toBe("done");
    f.setTime(1_001_000);
    await api("/api/issues/done/reopen", "POST");
    await expect.poll(async () => (await view("parent")).state).toBe("ready");
    expect(
      f
        .events("parent")
        .filter(({ type }) => type === "state_changed")
        .map(({ payload }) => payload),
    ).toMatchObject([
      { from: "ready", to: "done", cause: "children_closed" },
      { from: "done", to: "ready", cause: "child_reopened" },
    ]);
  });

  it("取り下げた依存先を外すと、停止前の状態へ戻り実装を始める", async () => {
    repository();
    f.addIssue("dependency", 41, { state: "ready" });
    f.addIssue("waiting", 43, { state: "ready" });
    f.depend("waiting", "dependency");
    expect((await f.request("/api/issues/dependency/withdraw", "POST")).status).toBe(200);
    expect(await view("waiting")).toMatchObject({
      state: "stopped",
      stopReason: "dependency_withdrawn",
    });

    f.setTime(1_001_000);
    expect((await f.request("/api/issues/waiting", "PATCH", { dependsOn: [] })).status).toBe(200);
    await expect
      .poll(async () => (await view("waiting")).state, { timeout: 3000 })
      .toBe("implementing");
    expect(
      f
        .events("waiting")
        .filter((event) => event.type === "state_changed")
        .map(({ payload }) => payload),
    ).toMatchObject([
      { from: "ready", to: "stopped", cause: "dependency_withdrawn" },
      { from: "stopped", to: "ready", cause: "dependency_cleared" },
      { from: "ready", to: "implementing", cause: "impl_started" },
    ]);
  });

  it("取り下げた依存先を再開すると、依存元を止まる前の状態へ戻す", async () => {
    repository();
    f.addIssue("dependency", 41, { state: "design_review" });
    f.addIssue("waiting", 43, { state: "ready" });
    f.depend("waiting", "dependency");
    await api("/api/issues/dependency/withdraw", "POST");
    expect((await view("waiting")).stopReason).toBe("dependency_withdrawn");
    f.setTime(1_001_000);
    await api("/api/issues/dependency/reopen", "POST");
    expect(await view("waiting")).toMatchObject({ state: "ready", stopReason: null });
    expect(f.events("waiting").at(-1)?.payload).toMatchObject({
      from: "stopped",
      to: "ready",
      cause: "dependency_cleared",
    });
  });

  async function prepareBothWorktrees() {
    const root = repository();
    f.addIssue("i", 42, { state: "design" });
    const created = await f.runner.runtime.start({
      projectId: "p",
      issueId: "i",
      kind: "design",
      title: "設計",
      cwd: root,
    });
    const design = (
      await f.runner.design.workspace({
        issueId: "i",
        conversationId: created._unsafeUnwrap().conversationId,
      })
    )._unsafeUnwrap();
    f.opened.sqlite.prepare("UPDATE issues SET state = 'ready' WHERE id = 'i'").run();
    await evaluate("i");
    await expect.poll(() => stage("i", "impl")?.runState, { timeout: 3000 }).toBe("working");
    return { root, design, implementation: stage("i", "impl")! };
  }

  it("取り下げると管理端末の終了を確かめ、設計と実装の作業場所だけを片付ける", async () => {
    const { root, design, implementation } = await prepareBothWorktrees();
    expect((await f.request("/api/issues/i/withdraw", "POST")).status).toBe(200);
    await expect
      .poll(() => f.events("i").filter(({ type }) => type === "worktree_removed").length, {
        timeout: 4000,
      })
      .toBe(2);
    expect([existsSync(design.path), existsSync(implementation.cwd)]).toEqual([false, false]);
    expect(
      git(root, "branch", "--list", "sukuna/design-42", "sukuna/issue-42").trim().split(/\s+/),
    ).toEqual(["sukuna/design-42", "sukuna/issue-42"]);
    expect(f.runner.runtime.store.get(implementation.id)).toMatchObject({
      cwd: root,
      worktreeId: null,
    });
  });

  it("取り下げても設計の作業場所の未コミットのファイルは残す", async () => {
    const { design, implementation } = await prepareBothWorktrees();
    const dirty = join(design.path, "local-notes.md");
    writeFileSync(dirty, "設計の書きかけ\n");
    expect((await f.request("/api/issues/i/withdraw", "POST")).status).toBe(200);
    await expect
      .poll(() => f.events("i").map(({ type }) => type), { timeout: 4000 })
      .toEqual(expect.arrayContaining(["worktree_kept", "worktree_removed"]));
    expect([existsSync(dirty), existsSync(implementation.cwd)]).toEqual([true, false]);
    expect(f.events("i").find(({ type }) => type === "worktree_kept")?.payload).toMatchObject({
      worktreeId: design.id,
      path: design.path,
      uncommittedFiles: 1,
    });
  });

  it("作成時の所有記録が無い設計の作業場所を保持する", async () => {
    const { design, implementation } = await prepareBothWorktrees();
    f.opened.sqlite
      .prepare("DELETE FROM settings WHERE key = ?")
      .run(`implementation-worktree:${design.id}`);
    await api("/api/issues/i/withdraw", "POST");
    await expect
      .poll(() => f.events("i").find(({ type }) => type === "worktree_kept")?.payload, {
        timeout: 4000,
      })
      .toMatchObject({ worktreeId: design.id, path: design.path });
    await expect.poll(() => existsSync(implementation.cwd)).toBe(false);
    expect(existsSync(design.path)).toBe(true);
  });

  it("同じパスを外部から作り直した設計の作業場所を削除しない", async () => {
    const { root, design } = await prepareBothWorktrees();
    const old = join(f.home, "moved-design");
    git(root, "worktree", "move", design.path, old);
    git(old, "switch", "--detach");
    git(root, "worktree", "add", design.path, design.branch);
    const note = join(design.path, "developer.md");
    writeFileSync(note, "開発者の作業\n");
    await api("/api/issues/i/withdraw", "POST");
    await expect
      .poll(() => f.events("i").find(({ type }) => type === "worktree_kept")?.payload, {
        timeout: 4000,
      })
      .toMatchObject({ worktreeId: design.id, path: design.path });
    expect(readFileSync(note, "utf8")).toBe("開発者の作業\n");
    expect(existsSync(old)).toBe(true);
  });

  it("外で登録とフォルダが消えた設計の worktree を片付け済みにする", async () => {
    const { root, design } = await prepareBothWorktrees();
    git(root, "worktree", "remove", design.path);
    await api("/api/issues/i/withdraw", "POST");
    await expect
      .poll(() =>
        f
          .events("i")
          .filter(({ type }) => type === "worktree_removed")
          .map(({ payload }) => payload),
      )
      .toEqual(
        expect.arrayContaining([
          { worktreeId: design.id, path: design.path, retainedBranch: design.branch },
        ]),
      );
    expect(git(root, "branch", "--list", design.branch).trim()).toBe(design.branch);
  });

  it("依存の解除を保存した時に作業場所が排他中でも、解放後に段階へ戻る", async () => {
    const { implementation } = await prepareBothWorktrees();
    f.addIssue("dependency", 41, { state: "design_review" });
    f.depend("i", "dependency");
    await api("/api/issues/dependency/withdraw", "POST");
    expect(await view("i")).toMatchObject({ state: "stopped", stopReason: "dependency_withdrawn" });
    const lease = createWorktreeActivity(f.opened.sqlite.name)
      .acquire([implementation.worktreeId!])
      ._unsafeUnwrap();
    try {
      f.setTime(1_001_000);
      await api("/api/issues/i", "PATCH", { dependsOn: [] });
      expect(await view("i")).toMatchObject({ state: "stopped", dependsOn: [] });
      await evaluate("i");
    } finally {
      lease.release();
    }
    await f.advanceTo(1_002_000);
    await expect.poll(async () => (await view("i")).state).toBe("implementing");
    expect(f.events("i").findLast(({ type }) => type === "state_changed")?.payload).toMatchObject({
      cause: "dependency_cleared",
    });
  });

  it("依存元の作業場所が排他中なら取り下げ全体を確定せず、解放後は両方を保存する", async () => {
    const { implementation } = await prepareBothWorktrees();
    f.addIssue("dependency", 41, { state: "design_review" });
    f.addIssue("waiting", 40, { state: "ready" });
    f.depend("waiting", "dependency");
    f.depend("i", "dependency");
    const lease = createWorktreeActivity(f.opened.sqlite.name)
      .acquire([implementation.worktreeId!])
      ._unsafeUnwrap();
    try {
      const response = await f.request("/api/issues/dependency/withdraw", "POST");
      expect(response.status).toBe(409);
      expect([
        (await view("dependency")).state,
        (await view("waiting")).state,
        (await view("i")).state,
      ]).toEqual(["design_review", "ready", "implementing"]);
      expect(f.events("dependency")).toEqual([]);
      expect(f.events("waiting")).toEqual([]);
      expect(f.runner.runtime.store.get(implementation.id)?.runState).toBe("working");
    } finally {
      lease.release();
    }
    await api("/api/issues/dependency/withdraw", "POST");
    expect(await view("i")).toMatchObject({ state: "stopped", stopReason: "dependency_withdrawn" });
    expect(await view("waiting")).toMatchObject({
      state: "stopped",
      stopReason: "dependency_withdrawn",
    });
    expect((await view("dependency")).state).toBe("withdrawn");
    expect(f.runner.runtime.store.get(implementation.id)?.runState).toBe("stopped");
  });

  function cleaned(id: string) {
    return f
      .events("i")
      .some(
        ({ type, payload }) =>
          type === "worktree_removed" && (payload as { worktreeId: string }).worktreeId === id,
      );
  }

  it("取り下げを保存して片付け前に中断した場合も、再起動で設計と実装の両方を片付ける", async () => {
    const { design, implementation } = await prepareBothWorktrees();
    const now = 1_001_000;
    const seq = (f.events("i").at(-1)?.seq ?? 0) + 1;
    f.opened.sqlite.transaction(() => {
      f.opened.sqlite
        .prepare(
          "UPDATE issues SET state = 'withdrawn', updated_at = ?, closed_at = ? WHERE id = 'i'",
        )
        .run(now, now);
      f.opened.sqlite
        .prepare(
          "INSERT INTO issue_events(issue_id, seq, type, payload, created_at) VALUES ('i', ?, 'state_changed', ?, ?)",
        )
        .run(
          seq,
          JSON.stringify({
            from: "implementing",
            to: "withdrawn",
            stopReason: null,
            detail: null,
            cause: "withdraw",
          }),
          now,
        );
    })();
    await f.restart();
    await expect.poll(() => cleaned(implementation.worktreeId!), { timeout: 4000 }).toBe(true);
    await expect.poll(() => cleaned(design.id), { timeout: 4000 }).toBe(true);
    expect([existsSync(design.path), existsSync(implementation.cwd)]).toEqual([false, false]);
  });

  it("取り下げ時に設計の作業場所が一時的に排他中でも、解放後の評価で片付ける", async () => {
    const { design, implementation } = await prepareBothWorktrees();
    let release: (() => void) | undefined;
    f.interceptGitBefore((args) => {
      if (args[0] !== "status" || release) return;
      const lease = createWorktreeActivity(f.opened.sqlite.name)
        .acquire([design.id])
        ._unsafeUnwrap();
      release = () => lease.release();
    });
    try {
      await api("/api/issues/i/withdraw", "POST");
      await expect.poll(() => cleaned(implementation.worktreeId!), { timeout: 4000 }).toBe(true);
      await f.runner.design.drain();
      expect(release).toBeDefined();
      expect(existsSync(design.path)).toBe(true);
    } finally {
      f.interceptGitBefore(undefined);
      release?.();
    }
    await f.advanceTo(1_001_000);
    await expect.poll(() => cleaned(design.id), { timeout: 3000 }).toBe(true);
  });

  it("端末の終了を確認できない設計の作業場所は再接続後に片付ける", async () => {
    const { design } = await prepareBothWorktrees();
    canCloseTerminal = false;
    try {
      await api("/api/issues/i/withdraw", "POST");
      await f.runner.design.drain();
      expect(existsSync(design.path)).toBe(true);
    } finally {
      canCloseTerminal = true;
    }
    f.link.stop();
    await expect.poll(() => f.runner.changes.terminalCleanupAvailable).toBe(false);
    f.link.start();
    await expect.poll(() => cleaned(design.id), { timeout: 4000 }).toBe(true);
  });

  it("端末確認の接続なしで取り下げた設計の作業場所も、接続後に片付ける", async () => {
    const { design } = await prepareBothWorktrees();
    f.link.stop();
    await expect.poll(() => f.runner.changes.terminalCleanupAvailable).toBe(false);
    try {
      const withdrawal = await f.link.call("POST", "/flow/issues/i/withdraw");
      expect(withdrawal._unsafeUnwrap().status).toBe(200);
      await f.runner.design.drain();
      expect(existsSync(design.path)).toBe(true);
      expect(f.events("i").find(({ type }) => type === "worktree_kept")?.payload).toMatchObject({
        worktreeId: design.id,
        awaitingTerminal: true,
      });
    } finally {
      f.link.start();
    }
    await expect.poll(() => cleaned(design.id), { timeout: 4000 }).toBe(true);
  });
});
