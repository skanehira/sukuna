import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ok } from "neverthrow";
import { describe, expect, it, vi } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { ScriptedAgent } from "../../../../runner/modules/conversation/adapter/scripted-agent";
import type { AgentScript } from "../../../../shared/agent-script";
import { drafts, issueDependencies, issues } from "../../../../shared/db/schema";
import { designFixture, git } from "../design-test-support";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

describe("設計の操作を受理するときの競合", () => {
  const f = designFixture();
  const approve = (headCommit: string) =>
    f.request("/api/issues/issue/design/approve", "POST", { headCommit });
  const reject = (text: string) => f.request("/api/issues/issue/design/reject", "POST", { text });
  const withdraw = () => f.request("/api/issues/issue/withdraw", "POST");
  const history = () => f.runner.runtime.store.events("design");
  const version = {
    conversationId: "design",
    text: "変更の指摘",
    images: [],
    updatedAt: 10,
    updatedBy: "tab",
  };
  const readDraft = () =>
    f.db.select().from(drafts).where(eq(drafts.conversationId, "design")).get();

  it("承認の差分確認中に設計ブランチが進んだ場合は409で受理しない", async () => {
    const tree = await f.prepare();
    const before = f.events();
    let moved = false;
    f.interceptGit(async ([op, option]) => {
      if (op !== "diff" || option !== "--quiet" || moved) return;
      writeFileSync(join(tree.path, "design.md"), "新しい版\n");
      git(tree.path, "add", "--", "design.md");
      git(tree.path, "commit", "-qm", "edit during approval");
      moved = true;
    });

    expect((await approve(tree.head)).status).toBe(409);
    expect(moved).toBe(true);
    expect(f.events()).toEqual(before);
    expect(f.state()).toBe("design_review");
    expect(git(f.repository, "rev-parse", "main")).toBe(tree.base);
  });

  it.each(["期限", "切断"] as const)(
    "承認中にIPCの%sを検出し、再接続後も古い要求を保存しない",
    async (cause) => {
      const tree = await f.prepare();
      const before = f.events();
      const entered = deferred();
      const proceed = deferred();
      let blocked = false;
      f.interceptGit(async ([op, option]) => {
        if (op !== "diff" || option !== "--quiet" || blocked) return;
        blocked = true;
        entered.resolve();
        await proceed.promise;
      });
      const pending = approve(tree.head);
      await entered.promise;
      try {
        if (cause === "切断") {
          f.disconnectAtDeadline();
        } else {
          f.advanceToDeadline();
          proceed.resolve();
        }
        const refused = await pending;
        expect(refused.status).toBe(503);
        expect(await refused.json()).toMatchObject({ error: { code: "runner_unavailable" } });
        expect(f.events()).toEqual(before);
      } finally {
        proceed.resolve();
      }
      await expect
        .poll(async () => (await approve(tree.head)).status, { timeout: 5_000 })
        .toBe(202);
      await f.runner.design.drain();
      expect(f.state()).toBe("ready");
      expect(f.events().filter(({ type }) => type === "design_approved")).toHaveLength(1);
    },
    15_000,
  );

  it.each([
    { operation: "承認", table: "issue_events", event: "design_approved" },
    { operation: "差し戻し", table: "settings", event: "" },
    { operation: "取り下げ", table: "issue_events", event: "state_changed" },
  ] as const)(
    "$operation の最後の保存でIPCの期限に達すると状態を戻す",
    async ({ operation, table, event }) => {
      const tree = await f.prepare();
      const agent = new ScriptedAgent({ rules: [] });
      f.runner.runtime.options.agent = agent;
      f.db.insert(drafts).values(version).run();
      const before = f.events();
      f.expireAfterInsert(table, event);

      const response = await (operation === "承認"
        ? approve(tree.head)
        : operation === "差し戻し"
          ? reject(version.text)
          : withdraw());
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "runner_unavailable" } });
      await f.runner.design.drain();

      expect(f.state()).toBe("design_review");
      expect(f.events()).toEqual(before);
      expect(history()).toEqual([]);
      expect(agent.sent).toEqual([]);
      expect(f.runner.runtime.executions.has("design")).toBe(false);
      expect(readDraft()).toEqual(version);
      expect(git(f.repository, "rev-parse", "main")).toBe(tree.base);
      expect(existsSync(tree.path)).toBe(true);
    },
  );

  const runningTurn: { state: string; step: NonNullable<AgentScript["fallback"]>[number] }[] = [
    { state: "working", step: { hold: true } },
    {
      state: "waiting_answer",
      step: {
        ask: [{ question: "このまま進めるか", header: "方針", options: [], multi_select: false }],
      },
    },
    {
      state: "waiting_permission",
      step: { permission: { tool_name: "Bash", input: { command: "pwd" } } },
    },
  ];
  it.each(runningTurn)(
    "報告した番が $state でも、同じセッションに差し戻しを1回届ける",
    async ({ state, step }) => {
      const agent = new ScriptedAgent({
        rules: [{ match: "^設計を作る$", steps: [step] }],
        fallback: [{ hold: true }],
      });
      f.runner.runtime.options.agent = agent;
      const tree = (await f.worktree())._unsafeUnwrap();
      expect(
        (
          await f.runner.runtime.send("design", { text: "設計を作る", images: [], origin: "flow" })
        ).isOk(),
      ).toBe(true);
      await expect.poll(() => f.runner.runtime.store.get("design")?.runState).toBe(state);
      expect((await f.submit()).isOk()).toBe(true);
      const queued = await f.runner.runtime.send("design", {
        text: "後続の指示",
        origin: "developer",
        images: [],
      });
      expect(queued._unsafeUnwrap().result).toBe("queued");

      expect((await reject("設計の指摘")).status).toBe(202);
      await f.runner.design.drain();

      expect(f.state()).toBe("design");
      expect(
        agent.opened.map(({ cwd, sessionId, resume }) => ({ cwd, sessionId, resume })),
      ).toEqual([
        { cwd: tree.path, sessionId: "design-session", resume: true },
        { cwd: tree.path, sessionId: "design-session", resume: true },
      ]);
      expect(agent.sent).toEqual([
        { sessionId: "design-session", text: "設計を作る" },
        { sessionId: "design-session", text: expect.stringContaining("\n\n設計の指摘") },
      ]);
      expect(history().filter(({ type }) => type === "user_message")).toHaveLength(2);
      expect(f.runner.runtime.store.queue("design")).toMatchObject([{ text: "後続の指示" }]);
      expect(f.runner.runtime.executions.get("design")?.question).toBeUndefined();
      expect(f.runner.runtime.executions.get("design")?.permission).toBeUndefined();
      if (state === "waiting_permission")
        expect(agent.permissionDecisions).toMatchObject([{ decision: { behavior: "deny" } }]);
    },
  );

  it.each(runningTurn)(
    "$state の差し戻しが保存期限を超えたら元の番をそのまま保つ",
    async ({ step, state }) => {
      const agent = new ScriptedAgent({ rules: [{ match: "設計を書く", steps: [step] }] });
      f.runner.runtime.options.agent = agent;
      await f.worktree();
      expect(
        (
          await f.runner.runtime.send("design", { text: "設計を書く", images: [], origin: "flow" })
        ).isOk(),
      ).toBe(true);
      await expect.poll(() => f.runner.runtime.store.get("design")?.runState).toBe(state);
      expect((await f.submit()).isOk()).toBe(true);
      f.db.insert(drafts).values(version).run();
      const execution = f.runner.runtime.executions.get("design")!;
      const interrupt = vi.spyOn(execution.session, "interrupt");
      const before = history();
      const oldQuestion = execution.question;
      const oldPermission = execution.permission;
      f.expireAfterInsert("settings", "");

      expect((await reject(version.text)).status).toBe(503);

      expect(interrupt).not.toHaveBeenCalled();
      expect(execution.question).toBe(oldQuestion);
      expect(execution.permission).toBe(oldPermission);
      expect(f.runner.runtime.store.get("design")?.runState).toBe(state);
      expect(f.state()).toBe("design_review");
      expect(history()).toEqual(before);
      expect(readDraft()).toEqual(version);
      expect(agent.sent).toHaveLength(1);
    },
  );

  it.each(runningTurn)(
    "$state の差し戻しは割り込み完了前に受理し、同じセッションへ1回届ける",
    async ({ step, state }) => {
      const agent = new ScriptedAgent({
        rules: [{ match: "設計を書く", steps: [step, { hold: true }] }],
        fallback: [{ hold: true }],
      });
      f.runner.runtime.options.agent = agent;
      await f.worktree();
      expect(
        (
          await f.runner.runtime.send("design", { text: "設計を書く", images: [], origin: "flow" })
        ).isOk(),
      ).toBe(true);
      await expect.poll(() => f.runner.runtime.store.get("design")?.runState).toBe(state);
      expect((await f.submit()).isOk()).toBe(true);
      const entered = deferred();
      const proceed = deferred();
      const execution = f.runner.runtime.executions.get("design")!;
      const interrupt = execution.session.interrupt.bind(execution.session);
      vi.spyOn(execution.session, "interrupt").mockImplementation(async () => {
        entered.resolve();
        await proceed.promise;
        await interrupt();
      });

      const pending = reject(version.text);
      try {
        await entered.promise;
        expect((await pending).status).toBe(202);
        f.disconnectAtDeadline();
        expect(agent.sent).toHaveLength(1);
        expect(f.state()).toBe("design");
        expect(f.runner.runtime.store.get("design")?.runState).toBe(state);
      } finally {
        proceed.resolve();
      }
      await f.runner.design.drain();
      expect(agent.opened.map(({ sessionId }) => sessionId)).toEqual([
        "design-session",
        "design-session",
      ]);
      expect(agent.sent).toMatchObject([
        { sessionId: "design-session" },
        { sessionId: "design-session", text: expect.stringContaining(version.text) },
      ]);
      expect(f.runner.runtime.store.get("design")?.runState).toBe("working");
    },
  );

  it("受理後の割り込みが失敗すれば会話を失敗状態にして指摘を残す", async () => {
    const agent = new ScriptedAgent({ rules: [], fallback: [{ hold: true }] });
    f.runner.runtime.options.agent = agent;
    await f.worktree();
    expect(
      (
        await f.runner.runtime.send("design", { text: "設計を書く", images: [], origin: "flow" })
      ).isOk(),
    ).toBe(true);
    expect((await f.submit()).isOk()).toBe(true);
    const execution = f.runner.runtime.executions.get("design")!;
    vi.spyOn(execution.session, "interrupt").mockRejectedValue(
      new Error("SDK interruption failed"),
    );

    expect((await reject(version.text)).status).toBe(202);
    await f.runner.design.drain();

    expect(f.state()).toBe("design");
    expect(history().filter(({ type }) => type === "user_message")).toHaveLength(1);
    expect(f.runner.runtime.store.queue("design")).toMatchObject([
      { text: expect.stringContaining(version.text) },
    ]);
    expect(history().at(-1)).toMatchObject({ type: "stopped", payload: { reason: "error" } });
    expect(f.runner.runtime.store.get("design")?.runState).toBe("failed");
    expect(f.runner.runtime.executions.has("design")).toBe(false);
    expect(agent.sent).toHaveLength(1);
    await expect
      .poll(() => f.changes)
      .toContainEqual(
        expect.objectContaining({ kind: "notice", level: "error", conversation_id: "design" }),
      );
  });

  it.each([
    { target: "design", fail: false },
    { target: "dependent", fail: false },
    { target: "design", fail: true },
    { target: "dependent", fail: true },
  ])(
    "取り下げは $target のSDK停止を待たず、停止の失敗を知らせる（失敗 $fail）",
    async ({ target, fail }) => {
      const agent = new ScriptedAgent({ rules: [], fallback: [{ hold: true }] });
      f.runner.runtime.options.agent = agent;
      const tree = (await f.worktree())._unsafeUnwrap();
      await f.runner.runtime.send("design", { text: "設計を書く", images: [], origin: "flow" });
      expect((await f.submit()).isOk()).toBe(true);
      f.db
        .insert(issues)
        .values({
          id: "dependent",
          projectId: "project",
          number: 43,
          title: "依存元",
          state: "design",
          updatedAt: 1,
          createdAt: 1,
        })
        .run();
      f.db.insert(issueDependencies).values({ issueId: "dependent", dependsOnId: "issue" }).run();
      const dependent = (
        await f.runner.runtime.start({
          projectId: "project",
          issueId: "dependent",
          kind: "design",
          title: "依存元の設計",
          cwd: f.repository,
          message: "依存元の会話",
        })
      )._unsafeUnwrap().conversationId;
      const affected = target === "dependent" ? dependent : "design";
      const execution = f.runner.runtime.executions.get(affected)!;
      const original = execution.session.interrupt.bind(execution.session);
      const entered = deferred();
      const proceed = deferred();
      vi.spyOn(execution.session, "interrupt").mockImplementation(async () => {
        entered.resolve();
        await proceed.promise;
        if (fail) throw new Error("SDK interruption failed");
        await original();
      });

      const pending = withdraw();
      try {
        await entered.promise;
        const accepted = await pending;
        expect(accepted.status).toBe(200);
        expect(await accepted.json()).toMatchObject({
          issue: { state: "withdrawn" },
          stoppedDependents: [43],
        });
        f.disconnectAtDeadline();
        expect(f.events().some(({ type }) => type === "worktree_kept")).toBe(false);
      } finally {
        proceed.resolve();
      }
      await f.runner.design.drain();
      expect(f.runner.runtime.store.get(affected)?.runState).toBe(fail ? "failed" : "stopped");
      expect(
        f.runner.runtime.store.get(affected === "design" ? dependent : "design")?.runState,
      ).toBe("stopped");
      expect(existsSync(tree.path)).toBe(true);
      if (fail)
        await expect
          .poll(() => f.changes)
          .toContainEqual(
            expect.objectContaining({ kind: "notice", level: "error", issue_id: "issue" }),
          );
      else expect(f.events().at(-1)?.type).toBe("worktree_kept");
    },
  );

  it("取り下げ時の停止要求は再開後に始まった番を止めない", async () => {
    const agent = new ScriptedAgent({ rules: [], fallback: [{ hold: true }] });
    f.runner.runtime.options.agent = agent;
    const tree = (await f.worktree())._unsafeUnwrap();
    await f.runner.runtime.send("design", { text: "取り下げ前の番", images: [], origin: "flow" });
    expect((await f.submit()).isOk()).toBe(true);
    const entered = deferred();
    const proceed = deferred();
    const blocker = f.runner.runtime.serial("design", async () => {
      entered.resolve();
      await proceed.promise;
      return ok(undefined);
    });
    await entered.promise;
    const newInput = f.runner.runtime.send("design", {
      text: "再開後の番",
      images: [],
      origin: "developer",
      interrupt: true,
    });
    try {
      expect((await withdraw()).status).toBe(200);
      expect((await f.request("/api/issues/issue/reopen", "POST")).status).toBe(200);
    } finally {
      proceed.resolve();
    }
    await blocker;
    expect((await newInput)._unsafeUnwrap().result).toBe("delivered");
    await f.runner.design.drain();

    expect(agent.sent.map(({ text }) => text)).toEqual(["取り下げ前の番", "再開後の番"]);
    expect(f.runner.runtime.store.get("design")?.runState).toBe("working");
    expect(f.events().filter(({ type }) => type === "worktree_kept")).toEqual([]);
    expect(existsSync(tree.path)).toBe(true);
  });
  it("新しく開いた実行の配達に失敗しても受理を取り消さず、会話に失敗を記録する", async () => {
    await f.prepare();
    const agent = new ScriptedAgent({ rules: [] });
    const open = agent.open.bind(agent);
    vi.spyOn(agent, "open").mockImplementation((params) => ({
      ...open(params),
      send: () => {
        throw new Error("SDK send failed");
      },
    }));
    f.runner.runtime.options.agent = agent;
    f.db.insert(drafts).values(version).run();

    expect((await reject(version.text)).status).toBe(202);
    await f.runner.design.drain();

    expect(f.state()).toBe("design");
    expect(readDraft()).toMatchObject({ text: "" });
    expect(history().filter(({ type }) => type === "user_message")).toHaveLength(1);
    expect(history().at(-1)).toMatchObject({ type: "stopped", payload: { reason: "error" } });
    expect(f.runner.runtime.store.get("design")?.runState).toBe("failed");
    expect(f.runner.runtime.executions.has("design")).toBe(false);
  });

  it("SDKを開けない差し戻しでは設計の状態と下書きが残る", async () => {
    await f.prepare();
    f.db.insert(drafts).values(version).run();
    const agent = new ScriptedAgent({ rules: [] });
    vi.spyOn(agent, "open").mockImplementation(() => {
      throw new Error("SDK unavailable");
    });
    f.runner.runtime.options.agent = agent;
    const before = f.events();

    expect((await reject(version.text)).status).toBe(500);

    expect(f.state()).toBe("design_review");
    expect(f.events()).toEqual(before);
    expect(readDraft()).toEqual(version);
    expect(history().filter(({ type }) => type === "user_message")).toEqual([]);
  });

  it("メニューから送った版の下書きを同じ保存で空にして更新を知らせる", async () => {
    await f.prepare();
    f.db.insert(drafts).values(version).run();

    expect((await reject(version.text)).status).toBe(202);

    expect(readDraft()).toMatchObject({ text: "", images: [], updatedBy: version.updatedBy });
    await expect
      .poll(() => f.changes)
      .toContainEqual({ kind: "conversation_parts", conversation_id: "design", parts: ["draft"] });
  });

  it("メニューから送った後に別タブが書いた下書きを保つ", async () => {
    await f.prepare();
    f.db.insert(drafts).values(version).run();
    const forward = f.link.forward.bind(f.link);
    const newer = { ...version, text: "別タブで追記", updatedAt: 11, updatedBy: "other-tab" };
    vi.spyOn(f.link, "forward").mockImplementation((method, path, input) => {
      f.db.update(drafts).set(newer).where(eq(drafts.conversationId, "design")).run();
      return forward(method, path, input);
    });

    expect((await reject(version.text)).status).toBe(202);
    expect(readDraft()).toEqual(newer);
  });

  it("差し戻しを直列待ちしている間に取り下げると指摘や下書きを変更しない", async () => {
    await f.prepare();
    f.db.insert(drafts).values(version).run();
    const entered = deferred();
    const proceed = deferred();
    const blocker = f.runner.runtime.serial("design", async () => {
      entered.resolve();
      await proceed.promise;
      return ok(undefined);
    });
    await entered.promise;
    const forwarded = deferred();
    const forward = f.link.forward.bind(f.link);
    vi.spyOn(f.link, "forward").mockImplementation((method, path, input) => {
      const response = forward(method, path, input);
      forwarded.resolve();
      return response;
    });
    const pending = reject(version.text);
    try {
      await forwarded.promise;
      expect((await withdraw()).status).toBe(200);
    } finally {
      proceed.resolve();
    }
    await blocker;

    expect((await pending).status).toBe(409);
    expect(f.state()).toBe("withdrawn");
    expect(history()).toEqual([]);
    expect(readDraft()).toEqual(version);
  });

  it("取り下げは作業場所のGit照合が止まっていても保存済みの結果を返す", async () => {
    const tree = await f.prepare(false);
    const entered = deferred();
    const proceed = deferred();
    f.interceptGit(async ([op, subcommand]) => {
      if (op === "worktree" && subcommand === "list") {
        entered.resolve();
        await proceed.promise;
      }
    });
    const pending = withdraw();
    await entered.promise;
    try {
      expect((await pending).status).toBe(200);
      f.disconnectAtDeadline();
      expect(f.state()).toBe("withdrawn");
      expect(existsSync(tree.path)).toBe(true);
    } finally {
      proceed.resolve();
    }
    await f.runner.design.drain();
    expect(existsSync(tree.path)).toBe(true);
  });

  it("片付けのGit操作が失敗した場合も取り下げを保存し作業場所を残す", async () => {
    const tree = await f.prepare(false);
    f.interceptGit(async ([op, subcommand]) => {
      if (op === "worktree" && subcommand === "list") throw new Error("git unavailable");
    });

    expect((await withdraw()).status).toBe(200);
    await f.runner.design.drain();

    expect(f.state()).toBe("withdrawn");
    expect(existsSync(tree.path)).toBe(true);
    expect(f.events().at(-1)).toMatchObject({
      type: "worktree_kept",
      payload: { worktreeId: tree.id },
    });
  });

  it("取り下げの片付け中の再開は競合になり、片付け後の再開は通る", async () => {
    const tree = await f.prepare(false);
    const entered = deferred();
    const proceed = deferred();
    f.interceptGit(async ([op, subcommand]) => {
      if (op === "worktree" && subcommand === "list") {
        entered.resolve();
        await proceed.promise;
      }
    });

    try {
      expect((await withdraw()).status).toBe(200);
      await entered.promise;
      expect((await f.request("/api/issues/issue/reopen", "POST")).status).toBe(409);
    } finally {
      proceed.resolve();
    }
    await f.runner.design.drain();
    expect(existsSync(tree.path)).toBe(true);
    expect(f.state()).toBe("withdrawn");
    expect((await f.request("/api/issues/issue/reopen", "POST")).status).toBe(200);
    expect(f.state()).toBe("triage");
  });
});
