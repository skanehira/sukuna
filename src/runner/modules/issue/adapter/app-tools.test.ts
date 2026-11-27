import { describe, expect, it } from "vite-plus/test";
import { ok } from "neverthrow";
import type { IssueReportsPort } from "../domain/ports";
import { eq } from "drizzle-orm";
import { conversations, issueEvents, issues, projects } from "../../../../shared/db/schema";
import { issueFixture, expectedIssue } from "../../../../server/modules/issue/test-support";
import { ScriptedAgent } from "../../conversation/adapter/scripted-agent";
import type { OpenParams } from "../../conversation/domain/agent-port";
import type { ConversationKind } from "../../conversation/domain/conversation-store";

describe("issue のアプリツール", () => {
  const reportsReceived: unknown[] = [];
  const reports: IssueReportsPort = {
    report: async (name, input, context) => {
      reportsReceived.push({ name, input, context });
      return ok("受け取りました");
    },
  };
  const f = issueFixture(undefined, { issueReports: reports });
  async function callTool(
    name: string,
    input: unknown,
    kind: ConversationKind = "chat",
    issueId: string | null = null,
  ) {
    f.runner.runtime.options.agent = new ScriptedAgent({
      rules: [],
      fallback: [{ tool: `mcp__sukuna__${name}`, input }, { end: "success" }],
    });
    const id = (
      await f.runner.runtime.start({
        projectId: "p",
        kind,
        issueId,
        title: "作った会話",
        cwd: f.home,
        message: "ツール",
      })
    )._unsafeUnwrap().conversationId;
    await f.until(() =>
      f.runner.runtime.store.events(id).some((event) => event.type === "turn_end"),
    );
    const result = f.runner.runtime.store.events(id).find((event) => event.type === "tool_result");
    if (result?.type !== "tool_result") throw new Error("ツール結果がありません");
    return { id, payload: result.payload };
  }
  it.each([true, false])(
    "AI の作成はプロジェクトの merge 既定 %s を使い、会話と created の記録を残す",
    async (confirmBeforeMergeDefault) => {
      f.db.update(projects).set({ confirmBeforeMergeDefault }).where(eq(projects.id, "p")).run();
      const { id, payload } = await callTool("issue_create", {
        title: "  在庫  ",
        body: "\n本文\n",
      });
      expectReply(payload, '#1 を作りました。精査待ちです\n{"number":1}');
      const issue = f.db.select().from(issues).get()!;
      await f.waitNotice(() => f.notices.some((notice) => notice.kind === "issue"));
      expect(f.notices.filter((notice) => notice.kind === "issue")).toEqual([
        { kind: "issue", issue_id: issue.id, project_id: "p", seq: 2 },
      ]);
      expect(await (await f.request(`/api/issues/${issue.id}`)).json()).toEqual({
        issue: expectedIssue({
          id: issue.id,
          title: "在庫",
          body: "本文",
          confirmBeforeMerge: confirmBeforeMergeDefault,
          createdConversationId: id,
          createdConversation: { id, title: "作った会話", deleted: false },
        }),
      });
      expect(f.events(issue.id)).toEqual([
        {
          issueId: issue.id,
          seq: 1,
          type: "state_changed",
          payload: {
            from: null,
            to: "triage",
            stopReason: null,
            detail: null,
            cause: "ai_created",
          },
          createdAt: 1000000,
        },
        {
          issueId: issue.id,
          seq: 2,
          type: "created",
          payload: { by: "ai", conversationId: id },
          createdAt: 1000000,
        },
      ]);
      f.db.delete(conversations).where(eq(conversations.id, id)).run();
      expect(await (await f.request(`/api/issues/${issue.id}`)).json()).toEqual({
        issue: expectedIssue({
          id: issue.id,
          title: "在庫",
          body: "本文",
          confirmBeforeMerge: confirmBeforeMergeDefault,
          createdConversationId: id,
          createdConversation: { id, title: null, deleted: true },
        }),
      });
    },
  );
  it("同じ会話の10分以内の同題名は番号を返し、境界の後には新しい番号を作る", async () => {
    const { id } = await callTool("issue_create", { title: "在庫", body: "本文" });
    f.setTime(1600000);
    await f.runner.runtime.send(id, { text: "もう一度", images: [], origin: "developer" });
    await f.until(
      () =>
        f.runner.runtime.store.events(id).filter((event) => event.type === "turn_end").length === 2,
    );
    const results = f.runner.runtime.store
      .events(id)
      .filter((event) => event.type === "tool_result");
    expect(results.map((event) => event.payload.content)).toEqual([
      '#1 を作りました。精査待ちです\n{"number":1}',
      '#1 は作成済みです\n{"number":1}',
    ]);
    f.setTime(1600001);
    await f.runner.runtime.send(id, { text: "後から", images: [], origin: "developer" });
    await f.until(
      () =>
        f.runner.runtime.store.events(id).filter((event) => event.type === "turn_end").length === 3,
    );
    expect(
      f.db.select({ number: issues.number }).from(issues).orderBy(issues.number).all(),
    ).toEqual([{ number: 1 }, { number: 2 }]);
  });
  it.each([
    [
      "report_triage",
      { number: 99, result: "design", kind: "bug", summary: "精査" },
      "triage",
      "triage",
      "この会話が扱う issue は #1 です",
    ],
    [
      "report_triage",
      { number: 2, result: "design", kind: "bug", summary: "精査" },
      "triage",
      "triage",
      "この会話が扱う issue は #1 です",
    ],
    [
      "report_stage",
      { number: 1, stage: "review" },
      "impl",
      "ready",
      "#1 はいま 実装待ち なので、この報告を受け付けません",
    ],
    [
      "issue_update",
      { number: 1, title: "直す" },
      "chat",
      "draft",
      "下書きは開発者がフォームで直します",
    ],
    [
      "issue_create",
      { title: "子", body: "本文", designed: true },
      "impl",
      "implementing",
      "この会話では designed を付けて issue を作れません。設計の会話か開発者が始めた会話で作ってください。",
    ],
  ] as const)(
    "%s の合わない呼出しを日本語のエラーで断る",
    async (name, input, kind, state, content) => {
      f.addIssue("i", 1, { state });
      f.addIssue("other", 2);
      const before = f.db.select().from(issues).all();
      const { payload } = await callTool(name, input, kind, "i");
      expectReply(payload, content, true);
      expect(f.db.select().from(issues).all()).toEqual(before);
    },
  );
  it("AI は確定後の項目を更新し、コメントを記録し、番号で内容を取得する", async () => {
    f.addIssue("i", 1);
    const updated = await callTool("issue_update", {
      number: 1,
      title: "更新",
      body: "本文",
      priority: "high",
      kind: "bug",
      confirm_before_merge: true,
    });
    const afterUpdate = expectedIssue({
      title: "更新",
      body: "本文",
      priority: "high",
      kind: "bug",
      confirmBeforeMerge: true,
    });
    expectReply(updated.payload, afterUpdate);
    const commented = await callTool("issue_comment", { number: 1, text: "  確認しました  " });
    expectReply(commented.payload, "#1 にコメントを書きました");
    const read = await callTool("issue_get", { number: 1 });
    expectReply(read.payload, {
      ...afterUpdate,
      comments: [{ at: 1000000, conversationId: commented.id, text: "  確認しました  " }],
    });
    const listed = await callTool("issue_list", { text: "本文" });
    expectReply(listed.payload, [
      { number: 1, title: "更新", state: "triage", priority: "high", parent: null, dependsOn: [] },
    ]);
    await f.waitNotice(() => f.notices.filter((notice) => notice.kind === "issue").length === 2);
    expect(f.notices.filter((notice) => notice.kind === "issue")).toEqual([
      { kind: "issue", issue_id: "i", project_id: "p", seq: 1 },
      { kind: "issue", issue_id: "i", project_id: "p", seq: 2 },
    ]);
    expect(f.events("i")).toEqual([
      {
        issueId: "i",
        seq: 1,
        type: "edited",
        payload: {
          fields: ["title", "body", "priority", "kind", "confirmBeforeMerge"],
          by: "ai",
          conversationId: updated.id,
        },
        createdAt: 1000000,
      },
      {
        issueId: "i",
        seq: 2,
        type: "comment",
        payload: { text: "  確認しました  ", conversationId: commented.id },
        createdAt: 1000000,
      },
    ]);
  });
  it.each([
    [
      "report_triage",
      { number: 1, result: "design", kind: "bug", summary: "精査" },
      "triage",
      "triage",
      { urgent: false },
    ],
    ["report_design", { number: 1, policy: "  修正  ", checks: [] }, "design", "design", {}],
    [
      "report_needs_human",
      { number: 1, questions: [{ text: "方針", options: ["A", "B"] }], summary: "判断" },
      "triage",
      "triage",
      {},
    ],
    [
      "report_needs_human",
      { number: 1, questions: [{ text: "方針" }], summary: "判断" },
      "design",
      "design",
      {},
    ],
    [
      "report_needs_human",
      { number: 1, questions: [{ text: "方針" }], summary: "判断" },
      "impl",
      "implementing",
      {},
    ],
    ["report_stage", { number: 1, stage: "review" }, "impl", "implementing", {}],
    [
      "report_ready_for_merge",
      { number: 1, head_sha: "a".repeat(40), summary: "" },
      "impl",
      "implementing",
      { rebased: false },
    ],
    [
      "report_ci_failed",
      { number: 1, checks: [{ name: "test", bucket: "fail" }], timed_out: false, summary: "" },
      "impl",
      "implementing",
      {},
    ],
    [
      "report_implementation_done",
      { number: 1, merge_commit: "b".repeat(40), summary: "" },
      "impl",
      "implementing",
      {},
    ],
  ] as const)("%s は %s を検査して flow の口へ渡す", async (name, input, kind, state, defaults) => {
    f.addIssue("i", 1, { state });
    reportsReceived.length = 0;
    const before = f.db.select().from(issues).all();
    const { id, payload } = await callTool(name, input, kind, "i");
    expectReply(payload, "受け取りました");
    expect(reportsReceived).toEqual([
      {
        name,
        input: { ...input, ...defaults },
        context: { conversationId: id, projectId: "p", issueId: "i" },
      },
    ]);
    expect(f.db.select().from(issues).all()).toEqual(before);
  });
  it("設計書の PR の merge 待ちには設計の報告を渡さない", async () => {
    f.addIssue("i", 1, { state: "design" });
    f.db
      .insert(issueEvents)
      .values([
        { issueId: "i", seq: 1, type: "design_approved", payload: {}, createdAt: 1 },
        { issueId: "i", seq: 2, type: "design_pr_created", payload: {}, createdAt: 2 },
      ])
      .run();
    reportsReceived.length = 0;
    const { payload } = await callTool(
      "report_design",
      { number: 1, policy: "修正", checks: [] },
      "design",
      "i",
    );
    expectReply(payload, "#1 はいま 設計待ち なので、この報告を受け付けません", true);
    expect(reportsReceived).toEqual([]);
  });
  it.each([
    ["issue_get", { number: 0 }, "chat"],
    ["issue_list", { limit: 201 }, "chat"],
    ["issue_create", { title: " ", body: "" }, "chat"],
    ["issue_update", { number: 1, state: "done" }, "chat"],
    ["issue_comment", { number: 1, text: "c".repeat(20001) }, "chat"],
    [
      "report_triage",
      { number: 1, result: "design", kind: "bug", score: 1001, summary: "精査" },
      "triage",
    ],
    ["report_design", { number: 1, policy: "  ", checks: [] }, "design"],
    ["report_needs_human", { number: 1, questions: [], summary: "" }, "triage"],
    ["report_stage", { number: 1, stage: "unknown" }, "impl"],
    ["report_ready_for_merge", { number: 1, head_sha: "a".repeat(39), summary: "" }, "impl"],
    ["report_ci_failed", { number: 1, checks: [], timed_out: false, summary: "" }, "impl"],
    [
      "report_implementation_done",
      { number: 1, merge_commit: "x".repeat(40), summary: "" },
      "impl",
    ],
  ] as const)("%s の範囲外入力は実行せず isError で返す", async (name, input, kind) => {
    f.addIssue("i", 1);
    reportsReceived.length = 0;
    const { payload } = await callTool(name, input, kind, "i");
    expectReply(payload, "入力の項目・長さ・番号・件数を確認して、もう一度呼んでください。", true);
    expect(f.events("i")).toEqual([]);
    expect(reportsReceived).toEqual([]);
  });
  it("同じ題名でも別の会話から作ると別の番号になり、同じ会話の別題名も新しく作る", async () => {
    const first = await callTool("issue_create", { title: "在庫", body: "" });
    const second = await callTool("issue_create", { title: "在庫", body: "" });
    expectReply(second.payload, '#2 を作りました。精査待ちです\n{"number":2}');
    await f.runner.runtime.release(first.id);
    f.runner.runtime.options.agent = new ScriptedAgent({
      rules: [],
      fallback: [
        { tool: "mcp__sukuna__issue_create", input: { title: "別の題名", body: "" } },
        { end: "success" },
      ],
    });
    await f.runner.runtime.send(first.id, { text: "別の題名", images: [], origin: "developer" });
    await f.until(
      () =>
        f.runner.runtime.store.events(first.id).filter((event) => event.type === "turn_end")
          .length === 2,
    );
    expect(
      f.db
        .select({
          number: issues.number,
          title: issues.title,
          createdConversationId: issues.createdConversationId,
        })
        .from(issues)
        .orderBy(issues.number)
        .all(),
    ).toEqual([
      { number: 1, title: "在庫", createdConversationId: first.id },
      { number: 2, title: "在庫", createdConversationId: second.id },
      { number: 3, title: "別の題名", createdConversationId: first.id },
    ]);
  });
  it.each(["done", "withdrawn"] as const)(
    "同じ会話の同じ題名でも %s になっていれば新しく作る",
    async (state) => {
      const { id } = await callTool("issue_create", { title: "在庫", body: "" });
      f.db.update(issues).set({ state, closedAt: 1000000 }).where(eq(issues.number, 1)).run();
      await f.runner.runtime.send(id, { text: "もう一度", images: [], origin: "developer" });
      await f.until(
        () =>
          f.runner.runtime.store.events(id).filter((event) => event.type === "turn_end").length ===
          2,
      );
      expect(
        f.db
          .select({ number: issues.number, state: issues.state })
          .from(issues)
          .orderBy(issues.number)
          .all(),
      ).toEqual([
        { number: 1, state },
        { number: 2, state: "triage" },
      ]);
    },
  );
  it("実装の会話も designed を渡さなければ issue を作れる", async () => {
    const { payload } = await callTool("issue_create", { title: "未設計の子", body: "" }, "impl");
    expectReply(payload, '#1 を作りました。精査待ちです\n{"number":1}');
    expect(f.db.select({ designed: issues.designed }).from(issues).all()).toEqual([
      { designed: false },
    ]);
  });
  it.each([
    ["issue_get", { number: 99 }],
    ["issue_create", { title: "子", body: "", depends_on: [99] }],
    ["issue_update", { number: 1, parent: 99 }],
  ] as const)("%s で無い番号を指定すると日本語のエラーを返し保存しない", async (name, input) => {
    f.addIssue("i", 1);
    const before = f.db.select().from(issues).all();
    const { payload } = await callTool(name, input);
    expectReply(payload, "#99 はこのプロジェクトにありません", true);
    expect(f.db.select().from(issues).all()).toEqual(before);
  });
  it.each(["done", "withdrawn"] as const)("AI は %s の issue を更新できない", async (state) => {
    f.addIssue("i", 1, { state });
    const { payload } = await callTool("issue_update", { number: 1, title: "変更" });
    expectReply(payload, "issue の状態が変わりました。読み直してから操作してください。", true);
  });
  it("AI の一覧で条件を省略するとすべて返し、親を持つ issue の部分更新でも関係を保持する", async () => {
    f.addIssue("parent", 1);
    f.addIssue("i", 2, { parentId: "parent" });
    f.depend("i", "parent");
    const listed = await callTool("issue_list", {});
    expectReply(listed.payload, [
      { number: 1, title: "parent", state: "triage", priority: null, parent: null, dependsOn: [] },
      { number: 2, title: "i", state: "triage", priority: null, parent: 1, dependsOn: [1] },
    ]);
    const updated = await callTool("issue_update", { number: 2, title: "改題" });
    expectReply(
      updated.payload,
      expectedIssue({
        number: 2,
        title: "改題",
        parent: { id: "parent", number: 1, title: "parent", state: "triage" },
        dependsOn: [{ id: "parent", number: 1, title: "parent", state: "triage" }],
      }),
    );
    const bodyUpdate = await callTool("issue_update", { number: 2, body: "本文だけを変更" });
    expectReply(
      bodyUpdate.payload,
      expectedIssue({
        number: 2,
        title: "改題",
        body: "本文だけを変更",
        parent: { id: "parent", number: 1, title: "parent", state: "triage" },
        dependsOn: [{ id: "parent", number: 1, title: "parent", state: "triage" }],
      }),
    );
    expect(f.events("i")).toEqual([
      {
        issueId: "i",
        seq: 1,
        type: "edited",
        payload: { fields: ["title"], by: "ai", conversationId: updated.id },
        createdAt: 1000000,
      },
      {
        issueId: "i",
        seq: 2,
        type: "edited",
        payload: { fields: ["body"], by: "ai", conversationId: bodyUpdate.id },
        createdAt: 1000000,
      },
    ]);
    const detached = await callTool("issue_update", { number: 2, parent: null, depends_on: [] });
    expectReply(
      detached.payload,
      expectedIssue({ number: 2, title: "改題", body: "本文だけを変更" }),
    );
    expect(f.events("i").at(-1)).toEqual({
      issueId: "i",
      seq: 3,
      type: "edited",
      payload: { fields: ["parentNumber", "dependsOn"], by: "ai", conversationId: detached.id },
      createdAt: 1000000,
    });
  });
  it.each(["design_rejected", "design_reflected"])(
    "%s の後は設計書の PR の merge 待ちとせず報告を渡す",
    async (type) => {
      f.addIssue("i", 1, { state: "design" });
      reportsReceived.length = 0;
      f.db
        .insert(issueEvents)
        .values(
          ["design_approved", "design_pr_created", type].map((type, i) => ({
            issueId: "i",
            seq: i + 1,
            type,
            payload: {},
            createdAt: i,
          })),
        )
        .run();
      const { id, payload } = await callTool(
        "report_design",
        { number: 1, policy: "修正", checks: [] },
        "design",
        "i",
      );
      expectReply(payload, "受け取りました");
      expect(reportsReceived).toEqual([
        {
          name: "report_design",
          input: { number: 1, policy: "修正", checks: [] },
          context: { conversationId: id, projectId: "p", issueId: "i" },
        },
      ]);
    },
  );
  it.each(["chat", "thread", "design"] as const)(
    "%s から設計済みの子を作ると親・依存・設定を保持する",
    async (kind) => {
      f.addIssue("parent", 1, { state: "done", closedAt: 900000 });
      f.db
        .update(projects)
        .set({ confirmBeforeMergeDefault: true })
        .where(eq(projects.id, "p"))
        .run();
      const { id, payload } = await callTool(
        "issue_create",
        {
          title: "子",
          body: "本文",
          parent: 1,
          depends_on: [1],
          priority: "low",
          kind: "enhancement",
          designed: true,
          confirm_before_merge: false,
        },
        kind,
      );
      expectReply(payload, '#2 を作りました。精査待ちです\n{"number":2}');
      const issue = f.db.select().from(issues).where(eq(issues.number, 2)).get()!;
      expect(await (await f.request(`/api/issues/${issue.id}`)).json()).toEqual({
        issue: expectedIssue({
          id: issue.id,
          number: 2,
          title: "子",
          body: "本文",
          kind: "enhancement",
          priority: "low",
          designed: true,
          createdConversationId: id,
          createdConversation: { id, title: "作った会話", deleted: false },
          parent: { id: "parent", number: 1, title: "parent", state: "done" },
          dependsOn: [{ id: "parent", number: 1, title: "parent", state: "done" }],
        }),
      });
    },
  );
  it.each([
    ["draft", "下書き"],
    ["triage", "精査待ち"],
    ["design", "設計待ち"],
    ["design_review", "設計レビュー"],
    ["ready", "実装待ち"],
    ["stopped", "停止中"],
    ["done", "完了"],
    ["withdrawn", "取り下げ"],
  ] as const)("%s への実装の報告は現在の状態の名前を示して断る", async (state, label) => {
    f.addIssue("i", 1, { state, ...(state === "stopped" ? { stopReason: "failed" } : {}) });
    const { payload } = await callTool("report_stage", { number: 1, stage: "review" }, "impl", "i");
    expectReply(payload, `#1 はいま ${label} なので、この報告を受け付けません`, true);
  });
  it("AI の一覧は状態と題名・本文で絞り番号の小さい順に件数を制限する", async () => {
    f.addIssue("parent", 1, { state: "done", title: "語" });
    f.addIssue("child", 2, { body: "語", parentId: "parent", priority: "low" });
    f.addIssue("other", 3, { title: "語" });
    f.addIssue("unmatched", 4);
    f.depend("child", "parent");
    const { payload } = await callTool("issue_list", { state: ["triage"], text: "語", limit: 1 });
    expectReply(payload, [
      { number: 2, title: "child", state: "triage", priority: "low", parent: 1, dependsOn: [1] },
    ]);
  });
  it.each([
    ["chat", ["issue_get", "issue_list", "issue_create", "issue_update", "issue_comment"]],
    ["thread", ["issue_get", "issue_list", "issue_create", "issue_update", "issue_comment"]],
    [
      "triage",
      [
        "issue_get",
        "issue_list",
        "issue_update",
        "issue_comment",
        "report_triage",
        "report_needs_human",
      ],
    ],
    [
      "design",
      [
        "issue_get",
        "issue_list",
        "issue_create",
        "issue_update",
        "issue_comment",
        "report_design",
        "report_needs_human",
      ],
    ],
    [
      "impl",
      [
        "issue_get",
        "issue_list",
        "issue_create",
        "issue_update",
        "issue_comment",
        "report_stage",
        "report_ready_for_merge",
        "report_ci_failed",
        "report_implementation_done",
        "report_needs_human",
      ],
    ],
  ] as const)("%s の実行には決めたツールだけを毎回 alwaysLoad で渡す", async (kind, names) => {
    const opened: OpenParams[] = [];
    let recapCalls = 0;
    f.runner.runtime.tools.register({
      name: "recap_read",
      description: "別モジュールのツール",
      input: {},
      alwaysLoad: true,
      handler: async () => {
        recapCalls++;
        return { text: "目次の見本", isError: false };
      },
    });
    const agent = new ScriptedAgent({
      rules: [],
      fallback: [{ tool: "mcp__sukuna__recap_read", input: {} }, { end: "success" }],
    });
    const open = agent.open.bind(agent);
    agent.open = (params) => {
      opened.push(params);
      return open(params);
    };
    f.runner.runtime.options.agent = agent;
    const id = (
      await f.runner.runtime.start({
        projectId: "p",
        kind,
        title: "会話",
        cwd: f.home,
        message: "開始",
      })
    )._unsafeUnwrap().conversationId;
    await f.until(() => f.runner.runtime.store.get(id)?.runState === "idle");
    await f.runner.runtime.release(id);
    await f.runner.runtime.send(id, { text: "再開", images: [], origin: "developer" });
    await f.until(
      () =>
        f.runner.runtime.store.events(id).filter((event) => event.type === "turn_end").length === 2,
    );
    expect(
      opened.map((params) =>
        params.appTools
          .map(({ name, alwaysLoad }) => ({ name, alwaysLoad }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ),
    ).toEqual(
      [1, 2].map(() =>
        [...names, "recap_read"]
          .sort((a, b) => a.localeCompare(b))
          .map((name) => ({ name, alwaysLoad: true })),
      ),
    );
    expect(recapCalls).toBe(2);
    expect(
      f.runner.runtime.store
        .events(id)
        .filter((event) => event.type === "tool_result")
        .map((event) => event.payload.content),
    ).toEqual(["目次の見本", "目次の見本"]);
  });
});

function expectReply(
  payload: {
    tool_use_id: string;
    content: string;
    is_error: boolean;
    truncated: boolean;
    bytes: number;
  },
  content: unknown,
  isError = false,
) {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  expect({
    ...payload,
    content: typeof content === "string" ? payload.content : JSON.parse(payload.content),
  }).toEqual({
    tool_use_id: payload.tool_use_id,
    content,
    is_error: isError,
    truncated: false,
    bytes: Buffer.byteLength(text),
  });
}
