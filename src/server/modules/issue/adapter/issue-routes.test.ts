import { describe, expect, it } from "vite-plus/test";
import { ScriptedAgent } from "../../../../runner/modules/conversation/adapter/scripted-agent";
import { eq } from "drizzle-orm";
import { projects, issues, issueEvents } from "../../../../shared/db/schema";
import type { IssueView } from "../../../../shared/issue/schema";
import { issueFixture, expectedIssue } from "../test-support";
import { createIssueRoutes } from "./issue-routes";
import { createIssueDependencies } from "./dependencies";
import { createLogger } from "../../../../shared/log";

describe("issue API とランナー", () => {
  const f = issueFixture();
  it.each(["working", "waiting_answer", "waiting_permission"] as const)(
    "取り下げても分岐した質問スレッドの %s を保つ",
    async (runState) => {
      f.addIssue("i", 1);
      const step =
        runState === "working"
          ? { hold: true as const }
          : runState === "waiting_answer"
            ? { ask: [{ question: "質問", header: "質問", options: [], multi_select: false }] }
            : { permission: { tool_name: "Bash", input: {} } };
      f.runner.runtime.options.agent = new ScriptedAgent({
        rules: [{ match: "スレッド", steps: [step, { hold: true }] }],
        fallback: [{ hold: true }],
      });
      const source = (
        await f.runner.runtime.start({
          projectId: "p",
          issueId: "i",
          kind: "triage",
          title: "精査",
          cwd: f.home,
          message: "開始",
        })
      )._unsafeUnwrap().conversationId;
      await f.until(() => f.runner.runtime.store.get(source)?.sessionId !== null);
      const thread = (
        await f.runner.runtime.fork(source, { kind: "thread", title: "質問" })
      )._unsafeUnwrap().conversationId;
      expect(
        (
          await f.runner.runtime.send(thread, { text: "スレッド", images: [], origin: "developer" })
        ).isOk(),
      ).toBe(true);
      await f.until(() => f.runner.runtime.store.get(thread)?.runState === runState);
      expect(await (await f.request("/api/issues/i/withdraw", "POST")).json()).toEqual({
        issue: expectedIssue({
          state: "withdrawn",
          closedAt: 1000000,
          conversations: [{ id: source, kind: "triage", runState: "stopped" }],
        }),
        stoppedDependents: [],
      });
      const saved = f.runner.runtime.store.get(thread)!;
      expect({
        kind: saved.kind,
        issueId: saved.issueId,
        parentConversationId: saved.parentConversationId,
        runState: saved.runState,
      }).toEqual({ kind: "thread", issueId: "i", parentConversationId: source, runState });
    },
  );
  it("空の下書きを作成・編集すると番号が付き、確定で精査待ちと記録が残る", async () => {
    const response = await f.request("/api/projects/p/issues", "POST", {});
    expect(response.status).toBe(201);
    const { issue } = (await response.json()) as { issue: IssueView };
    expect(issue).toEqual(expectedIssue({ id: issue.id, title: "", state: "draft" }));
    expect(
      await (
        await f.request(`/api/issues/${issue.id}`, "PATCH", {
          title: "  在庫  ",
          body: "\n 本文 \n",
        })
      ).json(),
    ).toEqual({
      issue: expectedIssue({ id: issue.id, title: "在庫", body: "本文", state: "draft" }),
    });
    expect(f.opened.sqlite.prepare("SELECT count(*) AS count FROM conversations").get()).toEqual({
      count: 0,
    });
    expect(await (await f.request(`/api/issues/${issue.id}/confirm`, "POST")).json()).toEqual({
      issue: expectedIssue({ id: issue.id, title: "在庫", body: "本文" }),
    });
    expect(f.events(issue.id)).toEqual([
      {
        issueId: issue.id,
        seq: 1,
        type: "state_changed",
        payload: { from: "draft", to: "triage", stopReason: null, detail: null, cause: "confirm" },
        createdAt: 1000000,
      },
      {
        issueId: issue.id,
        seq: 2,
        type: "created",
        payload: { by: "developer", conversationId: null },
        createdAt: 1000000,
      },
    ]);
    const second = await f.request(`/api/issues/${issue.id}/confirm`, "POST");
    expect({ status: second.status, body: await second.json() }).toEqual({
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: "issue の状態が変わりました。読み直してから操作してください。",
        },
      },
    });
  });
  it.each([true, false])(
    "merge 前の確認のプロジェクト既定 %s を下書きに使う",
    async (confirmBeforeMergeDefault) => {
      f.db.update(projects).set({ confirmBeforeMergeDefault }).where(eq(projects.id, "p")).run();
      const response = await f.request("/api/projects/p/issues", "POST", { title: "題名" });
      const { issue } = (await response.json()) as { issue: IssueView };
      expect(issue).toEqual(
        expectedIssue({
          id: issue.id,
          title: "題名",
          state: "draft",
          confirmBeforeMerge: confirmBeforeMergeDefault,
        }),
      );
    },
  );
  it("循環や存在しない番号の指定を保存せず、親と依存の参照を組み立てる", async () => {
    f.addIssue("a", 1, { state: "draft" });
    f.addIssue("b", 2, { state: "draft" });
    expect(
      await (await f.request("/api/issues/a", "PATCH", { parentNumber: 2, dependsOn: [2] })).json(),
    ).toEqual({
      issue: expectedIssue({
        id: "a",
        title: "a",
        state: "draft",
        parent: { id: "b", number: 2, title: "b", state: "draft" },
        dependsOn: [{ id: "b", number: 2, title: "b", state: "draft" }],
      }),
    });
    for (const [body, code, message] of [
      [
        { dependsOn: [1] },
        "dependency_cycle",
        "#2 → #1 → #2 が循環しています。依存を保存しませんでした",
      ],
      [
        { parentNumber: 1 },
        "parent_cycle",
        "#2 → #1 → #2 が循環しています。親を保存しませんでした",
      ],
      [{ dependsOn: [99] }, "invalid_input", "#99 はこのプロジェクトにありません"],
    ] as const) {
      const result = await f.request("/api/issues/b", "PATCH", body);
      expect({ status: result.status, body: await result.json() }).toEqual({
        status: 400,
        body: { error: { code, message } },
      });
    }
    expect(await (await f.request("/api/issues/b")).json()).toEqual({
      issue: expectedIssue({
        id: "b",
        number: 2,
        title: "b",
        state: "draft",
        children: [{ id: "a", number: 1, title: "a", state: "draft" }],
        dependents: [{ id: "a", number: 1, title: "a", state: "draft" }],
      }),
    });
  });
  it("題名が空の確定、確定後の本文変更と優先度の解除を拒否する", async () => {
    f.addIssue("draft", 1, { state: "draft", title: "" });
    f.addIssue("confirmed", 2, { priority: "high" });
    for (const [path, method, input, status, code, message] of [
      [
        "draft/confirm",
        "POST",
        undefined,
        400,
        "title_required",
        "題名を書いてから確定してください",
      ],
      [
        "confirmed",
        "PATCH",
        { title: "直す" },
        409,
        "confirmed_text_locked",
        "確定した issue の題名と本文は、会話で AI に頼んで直します",
      ],
      [
        "confirmed",
        "PATCH",
        { body: "直す" },
        409,
        "confirmed_text_locked",
        "確定した issue の題名と本文は、会話で AI に頼んで直します",
      ],
      [
        "confirmed",
        "PATCH",
        { priority: null },
        400,
        "invalid_input",
        "確定した issue の優先度は無しに戻せません",
      ],
    ] as const) {
      const response = await f.request(`/api/issues/${path}`, method, input);
      expect({ status: response.status, body: await response.json() }).toEqual({
        status,
        body: { error: { code, message } },
      });
    }
  });
  it("確定した issue の項目はランナーで更新し edited を残す", async () => {
    f.addIssue("i", 1);
    expect(
      await (
        await f.request("/api/issues/i", "PATCH", { priority: "high", confirmBeforeMerge: true })
      ).json(),
    ).toEqual({ issue: expectedIssue({ priority: "high", confirmBeforeMerge: true }) });
    expect(f.events("i")).toEqual([
      {
        issueId: "i",
        seq: 1,
        type: "edited",
        payload: {
          fields: ["priority", "confirmBeforeMerge"],
          by: "developer",
          conversationId: null,
        },
        createdAt: 1000000,
      },
    ]);
  });
  it("作業中の issue の取り下げは本人と依存元の会話を止め、再開は記録を保つ", async () => {
    f.addIssue("source", 1, { githubNumber: 25 });
    f.addIssue("dependent", 2);
    f.depend("dependent", "source");
    const conversations = await Promise.all(
      ["source", "dependent"].map(
        async (issueId) =>
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
      ),
    );
    await f.until(() => conversations.every((id) => f.runner.runtime.store.events(id).length >= 1));
    const withdrawn = await f.request("/api/issues/source/withdraw", "POST");
    expect(withdrawn.status).toBe(200);
    expect(await withdrawn.json()).toEqual({
      issue: expectedIssue({
        id: "source",
        title: "source",
        state: "withdrawn",
        closedAt: 1000000,
        conversations: [{ id: conversations[0]!, kind: "triage", runState: "stopped" }],
        dependents: [{ id: "dependent", number: 2, title: "dependent", state: "stopped" }],
      }),
      stoppedDependents: [2],
    });
    expect(await (await f.request("/api/issues/dependent")).json()).toEqual({
      issue: expectedIssue({
        id: "dependent",
        number: 2,
        title: "dependent",
        state: "stopped",
        stopReason: "dependency_withdrawn",
        stopDetail: "#1",
        dependsOn: [{ id: "source", number: 1, title: "source", state: "withdrawn" }],
        conversations: [{ id: conversations[1]!, kind: "triage", runState: "stopped" }],
      }),
    });
    const before = f.events("source");
    expect((await f.request("/api/issues/source/reopen", "POST")).status).toBe(200);
    expect(f.events("source").slice(0, before.length)).toEqual(before);
    expect(await (await f.request("/api/issues/dependent")).json()).toEqual({
      issue: expectedIssue({
        id: "dependent",
        number: 2,
        title: "dependent",
        dependsOn: [{ id: "source", number: 1, title: "source", state: "triage" }],
        conversations: [{ id: conversations[1]!, kind: "triage", runState: "stopped" }],
      }),
    });
    expect(conversations.map((id) => f.runner.runtime.store.get(id)?.runState)).toEqual([
      "stopped",
      "stopped",
    ]);
    expect(f.db.select().from(issues).where(eq(issues.id, "source")).get()).toEqual({
      id: "source",
      projectId: "p",
      number: 1,
      title: "source",
      body: "",
      kind: null,
      state: "triage",
      stopReason: null,
      parentId: null,
      priority: null,
      designed: false,
      confirmBeforeMerge: false,
      prUrl: null,
      githubNumber: null,
      createdConversationId: null,
      createdAt: 1000000,
      updatedAt: 1000000,
      closedAt: null,
    });
  });
  it.each(["done", "withdrawn"] as const)("%s の再開は会話とイベントを残す", async (state) => {
    f.addIssue("i", 1, { state, closedAt: 900000 });
    const conversationId = (
      await f.runner.runtime.start({
        projectId: "p",
        issueId: "i",
        kind: "impl",
        title: "実装",
        cwd: f.home,
      })
    )._unsafeUnwrap().conversationId;
    expect(await (await f.request("/api/issues/i/reopen", "POST")).json()).toEqual({
      issue: expectedIssue({
        conversations: [{ id: conversationId, kind: "impl", runState: "idle" }],
      }),
    });
    expect(f.events("i")).toEqual([
      {
        issueId: "i",
        seq: 1,
        type: "state_changed",
        payload: { from: state, to: "triage", stopReason: null, detail: null, cause: "reopen" },
        createdAt: 1000000,
      },
    ]);
  });
  it("ランナー切断中は確定・取り下げ・再開・確定後の編集を変更せず503で返す", async () => {
    f.addIssue("draft", 1, { state: "draft" });
    f.addIssue("confirmed", 2);
    f.addIssue("closed", 3, { state: "done", closedAt: 900000 });
    const before = f.db.select().from(issues).all();
    f.link.stop();
    for (const [path, method, body] of [
      ["draft/confirm", "POST"],
      ["confirmed/withdraw", "POST"],
      ["closed/reopen", "POST"],
      ["confirmed", "PATCH", { priority: "high" }],
    ] as const) {
      const response = await f.request(`/api/issues/${path}`, method, body);
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 503,
        body: {
          error: {
            code: "runner_unavailable",
            message:
              "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
          },
        },
      });
    }
    expect(f.db.select().from(issues).all()).toEqual(before);
  });
  it("一覧は状態と語で絞り、番号の降順でcursorを返す", async () => {
    f.addIssue("a", 1, { title: "対象", state: "draft" });
    f.addIssue("b", 2, { title: "対象", priority: "high" });
    f.addIssue("c", 3, { body: "対象" });
    f.addIssue("unmatched", 4);
    const summary = (values: Partial<IssueView>) => {
      const {
        body: _body,
        children: _children,
        dependents: _dependents,
        conversations: _conversations,
        comments: _comments,
        ...row
      } = expectedIssue(values);
      return row;
    };
    expect(await (await f.request("/api/projects/p/issues")).json()).toEqual({
      items: [
        summary({ id: "unmatched", number: 4, title: "unmatched" }),
        summary({ id: "c", number: 3, title: "c" }),
        summary({ id: "b", number: 2, title: "対象", priority: "high" }),
        summary({ id: "a", title: "対象", state: "draft" }),
      ],
      nextCursor: null,
    });
    expect(await (await f.request("/api/projects/p/issues?q=対象&limit=1")).json()).toEqual({
      items: [summary({ id: "c", number: 3, title: "c" })],
      nextCursor: "3",
    });
    expect(await (await f.request("/api/projects/p/issues?q=対象&limit=2")).json()).toEqual({
      items: [
        summary({ id: "c", number: 3, title: "c" }),
        summary({ id: "b", number: 2, title: "対象", priority: "high" }),
      ],
      nextCursor: "2",
    });
    expect(
      await (await f.request("/api/projects/p/issues?q=対象&limit=2&cursor=2")).json(),
    ).toEqual({ items: [summary({ id: "a", title: "対象", state: "draft" })], nextCursor: null });
    expect(
      await (await f.request("/api/projects/p/issues?state=triage&q=対象&limit=2")).json(),
    ).toEqual({
      items: [
        summary({ id: "c", number: 3, title: "c" }),
        summary({ id: "b", number: 2, title: "対象", priority: "high" }),
      ],
      nextCursor: null,
    });
  });
  it("上限ちょうどの題名・本文・50件の依存は保存でき、超えた入力は変更しない", async () => {
    for (let number = 1; number <= 50; number++) f.addIssue(`dependency-${number}`, number);
    const input = {
      title: "a".repeat(200),
      body: "b".repeat(50000),
      dependsOn: Array.from({ length: 50 }, (_, i) => i + 1),
    };
    const response = await f.request("/api/projects/p/issues", "POST", input);
    expect(response.status).toBe(201);
    const { issue } = (await response.json()) as { issue: IssueView };
    expect(issue).toEqual(
      expectedIssue({
        id: issue.id,
        number: 51,
        title: input.title,
        body: input.body,
        state: "draft",
        dependsOn: input.dependsOn.map((number) => ({
          id: `dependency-${number}`,
          number,
          title: `dependency-${number}`,
          state: "triage",
        })),
      }),
    );
    for (const invalid of [
      { title: "a".repeat(201) },
      { body: "b".repeat(50001) },
      { dependsOn: Array.from({ length: 51 }, (_, i) => i + 1) },
    ]) {
      const failed = await f.request(`/api/issues/${issue.id}`, "PATCH", invalid);
      expect({ status: failed.status, body: await failed.json() }).toEqual({
        status: 400,
        body: {
          error: { code: "invalid_input", message: "入力の長さ・番号・件数を確認してください。" },
        },
      });
    }
    expect(await (await f.request(`/api/issues/${issue.id}`)).json()).toEqual({ issue });
  });
  it("存在しないか解除されたプロジェクトと範囲外の一覧条件を拒否する", async () => {
    f.addIssue("i", 1);
    for (const path of ["/api/projects/missing/issues", "/api/issues/missing"]) {
      const response = await f.request(path);
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 404,
        body: {
          error: {
            code: "not_found",
            message: "issue またはプロジェクトが見つかりません。読み直してください。",
          },
        },
      });
    }
    for (const query of ["limit=0", "limit=501", "cursor=bad", "state=unknown"]) {
      const response = await f.request(`/api/projects/p/issues?${query}`);
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 400,
        body: { error: { code: "invalid_input", message: "一覧の条件を確認してください。" } },
      });
    }
    f.db.update(projects).set({ removedAt: 1000 }).where(eq(projects.id, "p")).run();
    for (const [path, method] of [
      ["/api/projects/p/issues", "GET"],
      ["/api/projects/p/issues", "POST"],
      ["/api/issues/i", "GET"],
      ["/api/issues/i", "PATCH"],
      ["/api/issues/i/withdraw", "POST"],
    ]) {
      const response = await f.request(path!, method!, method === "GET" ? undefined : {});
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 404,
        body: {
          error: {
            code: "not_found",
            message: "issue またはプロジェクトが見つかりません。読み直してください。",
          },
        },
      });
    }
  });
  it("確定の記録を書けないときは、状態変更もイベントもまとめて戻す", async () => {
    f.addIssue("i", 1, { state: "draft" });
    f.opened.sqlite.exec(
      "CREATE TRIGGER reject_created BEFORE INSERT ON issue_events WHEN NEW.type = 'created' BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
    );
    const failed = await f.request("/api/issues/i/confirm", "POST");
    expect({ status: failed.status, body: await failed.json() }).toEqual({
      status: 500,
      body: {
        error: {
          code: "internal",
          message: "会話の操作に失敗しました。もう一度操作してください。",
        },
      },
    });
    expect(await (await f.request("/api/issues/i")).json()).toEqual({
      issue: expectedIssue({ state: "draft" }),
    });
    expect(f.events("i")).toEqual([]);
    f.opened.sqlite.exec("DROP TRIGGER reject_created");
    expect(await (await f.request("/api/issues/i/confirm", "POST")).json()).toEqual({
      issue: expectedIssue({}),
    });
  });
  it("コメントは新しい50件を古い順に返し停止の説明は状態変更の記録から読む", async () => {
    f.addIssue("i", 1, { state: "stopped", stopReason: "failed" });
    f.db
      .insert(issueEvents)
      .values([
        {
          issueId: "i",
          seq: 1,
          type: "state_changed",
          payload: {
            from: "triage",
            to: "stopped",
            stopReason: "failed",
            detail: "作業の失敗",
            cause: "agent_failed",
          },
          createdAt: 1000,
        },
        ...Array.from({ length: 51 }, (_, i) => ({
          issueId: "i",
          seq: i + 2,
          type: "comment",
          payload: { text: `コメント ${i + 1}`, conversationId: "c" },
          createdAt: 1001 + i,
        })),
      ])
      .run();
    expect(await (await f.request("/api/issues/i")).json()).toEqual({
      issue: expectedIssue({
        state: "stopped",
        stopReason: "failed",
        stopDetail: "作業の失敗",
        comments: Array.from({ length: 50 }, (_, i) => ({
          at: 1002 + i,
          conversationId: "c",
          text: `コメント ${i + 2}`,
        })),
      }),
    });
  });

  it("項目を一つずつ直しても親と依存を保持し、送った項目だけを edited に残す", async () => {
    f.addIssue("parent", 1);
    f.addIssue("i", 2, { parentId: "parent" });
    f.depend("i", "parent");
    for (const [input, fields] of [
      [{ priority: "low" }, ["priority"]],
      [{ confirmBeforeMerge: true }, ["confirmBeforeMerge"]],
    ] as const) {
      expect((await f.request("/api/issues/i", "PATCH", input)).status).toBe(200);
      expect(f.events("i").at(-1)).toEqual({
        issueId: "i",
        seq: f.events("i").length,
        type: "edited",
        payload: { fields, by: "developer", conversationId: null },
        createdAt: 1000000,
      });
    }
    expect(await (await f.request("/api/issues/i")).json()).toEqual({
      issue: expectedIssue({
        number: 2,
        priority: "low",
        confirmBeforeMerge: true,
        parent: { id: "parent", number: 1, title: "parent", state: "triage" },
        dependsOn: [{ id: "parent", number: 1, title: "parent", state: "triage" }],
      }),
    });
  });
  it("下書きとランナーの変更は購読している issue と一覧へ知らせる", async () => {
    f.addIssue("i", 1, { state: "draft" });
    const messages: unknown[] = [];
    const client = {
      bufferedAmount: 0,
      send: (text: string) => messages.push(JSON.parse(text)),
      close: () => {},
    };
    f.hub.add(client);
    f.hub.receive(client, { op: "subscribe", topic: "issue:i" });
    f.hub.receive(client, { op: "subscribe", topic: "inbox" });
    expect((await f.request("/api/issues/i", "PATCH", { title: "題名" })).status).toBe(200);
    expect(messages).toEqual([
      { topic: "issue:i", seq: 0, type: "changed", payload: {} },
      {
        topic: "inbox",
        seq: 1,
        type: "changed",
        payload: { conversation_ids: [], issue_ids: ["i"], project_ids: ["p"] },
      },
    ]);
    expect((await f.request("/api/issues/i/confirm", "POST")).status).toBe(200);
    await f.waitNotice(() => f.notices.some((notice) => notice.kind === "issue"));
    expect(f.notices).toEqual([{ kind: "issue", issue_id: "i", project_id: "p", seq: 2 }]);
    expect(messages.slice(2)).toEqual([
      {
        topic: "issue:i",
        seq: 1,
        type: "event",
        payload: {
          issue_id: "i",
          seq: 1,
          type: "state_changed",
          payload: {
            from: "draft",
            to: "triage",
            stopReason: null,
            detail: null,
            cause: "confirm",
          },
          created_at: 1000000,
        },
      },
      {
        topic: "issue:i",
        seq: 2,
        type: "event",
        payload: {
          issue_id: "i",
          seq: 2,
          type: "created",
          payload: { by: "developer", conversationId: null },
          created_at: 1000000,
        },
      },
      { topic: "issue:i", seq: 2, type: "changed", payload: {} },
      {
        topic: "inbox",
        seq: 2,
        type: "changed",
        payload: { conversation_ids: [], issue_ids: ["i"], project_ids: ["p"] },
      },
    ]);
    expect((await f.request("/api/issues/i/withdraw", "POST")).status).toBe(200);
    expect((await f.request("/api/issues/i/reopen", "POST")).status).toBe(200);
    await f.waitNotice(() =>
      f.notices.some((notice) => notice.kind === "issue" && notice.seq === 4),
    );
    expect(f.notices).toEqual([
      { kind: "issue", issue_id: "i", project_id: "p", seq: 2 },
      { kind: "issue", issue_id: "i", project_id: "p", seq: 3 },
      { kind: "issue", issue_id: "i", project_id: "p", seq: 4 },
    ]);
  });

  it.each(["waiting_answer", "waiting_permission"] as const)(
    "%s の AI も取り下げで止める",
    async (runState) => {
      f.addIssue("i", 1);
      const step =
        runState === "waiting_answer"
          ? { ask: [{ question: "方針", header: "方針", options: [], multi_select: false }] }
          : { permission: { tool_name: "Bash", input: {} } };
      f.runner.runtime.options.agent = new ScriptedAgent({
        rules: [],
        fallback: [step, { hold: true }],
      });
      const id = (
        await f.runner.runtime.start({
          projectId: "p",
          issueId: "i",
          kind: "design",
          title: "設計",
          cwd: f.home,
          message: "開始",
        })
      )._unsafeUnwrap().conversationId;
      await f.until(() => f.runner.runtime.store.get(id)?.runState === runState);
      expect(await (await f.request("/api/issues/i/withdraw", "POST")).json()).toEqual({
        issue: expectedIssue({
          state: "withdrawn",
          closedAt: 1000000,
          conversations: [{ id, kind: "design", runState: "stopped" }],
        }),
        stoppedDependents: [],
      });
    },
  );
  it("下書きの編集・確定・確定後の編集で更新時刻を進め、作成時刻を保持する", async () => {
    f.addIssue("i", 1, { state: "draft" });
    f.setTime(1000100);
    expect(
      await (await f.request("/api/issues/i", "PATCH", { priority: "medium" })).json(),
    ).toEqual({ issue: expectedIssue({ state: "draft", priority: "medium", updatedAt: 1000100 }) });
    f.setTime(1000200);
    expect(await (await f.request("/api/issues/i/confirm", "POST")).json()).toEqual({
      issue: expectedIssue({ priority: "medium", updatedAt: 1000200 }),
    });
    f.setTime(1000300);
    expect(await (await f.request("/api/issues/i", "PATCH", { priority: "high" })).json()).toEqual({
      issue: expectedIssue({ priority: "high", updatedAt: 1000300 }),
    });
    expect(f.events("i").map(({ createdAt, type }) => ({ createdAt, type }))).toEqual([
      { createdAt: 1000200, type: "state_changed" },
      { createdAt: 1000200, type: "created" },
      { createdAt: 1000300, type: "edited" },
    ]);
  });

  it("すでに別の依存先の取り下げで停止していた依存元は新しく停止した番号に含めない", async () => {
    f.addIssue("i", 1);
    f.addIssue("already", 2, { state: "stopped", stopReason: "dependency_withdrawn" });
    f.addIssue("other", 3, { state: "withdrawn", closedAt: 900000 });
    f.depend("already", "i");
    f.depend("already", "other");
    f.db
      .insert(issueEvents)
      .values({
        issueId: "already",
        seq: 1,
        type: "state_changed",
        payload: {
          from: "triage",
          to: "stopped",
          stopReason: "dependency_withdrawn",
          detail: "#3",
          cause: "dependency_withdrawn",
        },
        createdAt: 900000,
      })
      .run();
    expect(await (await f.request("/api/issues/i/withdraw", "POST")).json()).toEqual({
      issue: expectedIssue({
        state: "withdrawn",
        closedAt: 1000000,
        dependents: [{ id: "already", number: 2, title: "already", state: "stopped" }],
      }),
      stoppedDependents: [],
    });
  });
  it("AI の停止に失敗しても取り下げの保存と通知を保ち、再取り下げは拒否する", async () => {
    f.addIssue("i", 1);
    f.addIssue("dependent", 2);
    f.depend("dependent", "i");
    let failStop = true;
    const agent = new ScriptedAgent({ rules: [], fallback: [{ hold: true }] });
    const open = agent.open.bind(agent);
    agent.open = (params) => {
      const session = open(params);
      const own = params.context.issueId === "i";
      const interrupt = session.interrupt.bind(session);
      session.interrupt = async () => {
        if (failStop && own) throw new Error("fixture stop failure");
        await interrupt();
      };
      return session;
    };
    f.runner.runtime.options.agent = agent;
    const id = (
      await f.runner.runtime.start({
        projectId: "p",
        issueId: "i",
        kind: "triage",
        title: "精査",
        cwd: f.home,
        message: "開始",
      })
    )._unsafeUnwrap().conversationId;
    const dependentId = (
      await f.runner.runtime.start({
        projectId: "p",
        issueId: "dependent",
        kind: "design",
        title: "設計",
        cwd: f.home,
        message: "開始",
      })
    )._unsafeUnwrap().conversationId;
    try {
      const failed = await f.request("/api/issues/i/withdraw", "POST");
      expect({ status: failed.status, body: await failed.json() }).toEqual({
        status: 500,
        body: {
          error: {
            code: "internal",
            message:
              "取り下げは保存しましたが、AI を停止できませんでした。会話の状態を確認してください。",
          },
        },
      });
      expect(await (await f.request("/api/issues/i")).json()).toEqual({
        issue: expectedIssue({
          state: "withdrawn",
          closedAt: 1000000,
          conversations: [{ id, kind: "triage", runState: "working" }],
          dependents: [{ id: "dependent", number: 2, title: "dependent", state: "stopped" }],
        }),
      });
      expect(f.runner.runtime.store.get(dependentId)?.runState).toBe("stopped");
      await f.waitNotice(() => f.notices.filter((notice) => notice.kind === "issue").length === 2);
      expect(f.notices.filter((notice) => notice.kind === "issue")).toEqual([
        { kind: "issue", issue_id: "i", project_id: "p", seq: 1 },
        { kind: "issue", issue_id: "dependent", project_id: "p", seq: 1 },
      ]);
    } finally {
      failStop = false;
    }
    const repeated = await f.request("/api/issues/i/withdraw", "POST");
    expect({ status: repeated.status, body: await repeated.json() }).toEqual({
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: "issue の状態が変わりました。読み直してから操作してください。",
        },
      },
    });
    expect((await f.runner.runtime.stop(id)).isOk()).toBe(true);
    expect(await (await f.request("/api/issues/i")).json()).toEqual({
      issue: expectedIssue({
        state: "withdrawn",
        closedAt: 1000000,
        conversations: [{ id, kind: "triage", runState: "stopped" }],
        dependents: [{ id: "dependent", number: 2, title: "dependent", state: "stopped" }],
      }),
    });
  });
  it("下書きを保存できないときはJSONで失敗を返し、再試行で保存できる", async () => {
    f.opened.sqlite.exec(
      "CREATE TRIGGER reject_issue BEFORE INSERT ON issues BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
    );
    const failed = await f.request("/api/projects/p/issues", "POST", {
      title: "private-title-marker",
      body: "private-body-marker",
    });
    expect({ status: failed.status, body: await failed.json() }).toEqual({
      status: 500,
      body: {
        error: {
          code: "internal",
          message: "issue を保存できませんでした。もう一度操作してください。",
        },
      },
    });
    expect(f.db.select().from(issues).all()).toEqual([]);
    expect(f.logs.map((line) => JSON.parse(line))).toEqual([
      {
        time: "1970-01-01T00:16:40.000Z",
        level: "error",
        component: "server.api",
        message: "issue を保存できませんでした。",
        error: { name: "SqliteError", message: "fixture" },
      },
    ]);
    f.opened.sqlite.exec("DROP TRIGGER reject_issue");
    const response = await f.request("/api/projects/p/issues", "POST", { title: "題名" });
    expect(response.status).toBe(201);
    const { issue } = (await response.json()) as { issue: IssueView };
    expect(issue).toEqual(expectedIssue({ id: issue.id, title: "題名", state: "draft" }));
    expect(f.logs).toHaveLength(1);
  });
  it("保存例外がSQLと本文を含むエラーに包まれていても原因だけをログに残す", async () => {
    const deps = createIssueDependencies(
      () => f.db,
      () => f.link,
      createLogger({ now: () => 1000000, write: (line) => f.logs.push(line), level: "info" }),
    );
    const routes = createIssueRoutes({
      ...deps,
      unitOfWork: {
        ...deps.unitOfWork,
        create: () => {
          throw new Error("SQL INSERT private-title-marker params private-body-marker", {
            cause: new Error("query parameters private-body-marker", {
              cause: new Error("保存先が利用できません"),
            }),
          });
        },
      },
    });
    const response = await routes.request("/projects/p/issues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "private-title-marker", body: "private-body-marker" }),
    });
    expect({
      status: response.status,
      body: await response.json(),
      logs: f.logs.map((line) => JSON.parse(line)),
    }).toEqual({
      status: 500,
      body: {
        error: {
          code: "internal",
          message: "issue を保存できませんでした。もう一度操作してください。",
        },
      },
      logs: [
        {
          time: "1970-01-01T00:16:40.000Z",
          level: "error",
          component: "server.api",
          message: "issue を保存できませんでした。",
          error: { name: "Error", message: "保存先が利用できません" },
        },
      ],
    });
  });
  it("確定後の親と依存をAPIから変更し、nullと空配列で解除できる", async () => {
    f.addIssue("parent", 1);
    f.addIssue("i", 2);
    expect(
      await (await f.request("/api/issues/i", "PATCH", { parentNumber: 1, dependsOn: [1] })).json(),
    ).toEqual({
      issue: expectedIssue({
        number: 2,
        parent: { id: "parent", number: 1, title: "parent", state: "triage" },
        dependsOn: [{ id: "parent", number: 1, title: "parent", state: "triage" }],
      }),
    });
    expect(
      await (
        await f.request("/api/issues/i", "PATCH", { parentNumber: null, dependsOn: [] })
      ).json(),
    ).toEqual({ issue: expectedIssue({ number: 2 }) });
    expect(f.events("i")).toEqual(
      [1, 2].map((seq) => ({
        issueId: "i",
        seq,
        type: "edited",
        payload: { fields: ["parentNumber", "dependsOn"], by: "developer", conversationId: null },
        createdAt: 1000000,
      })),
    );
  });
});
