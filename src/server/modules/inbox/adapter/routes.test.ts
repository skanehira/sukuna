import { eventSchema } from "../../../../shared/events";
import { stateChangedSchema } from "../../../../shared/issue/state";
import { describe, expect, it } from "vite-plus/test";
import { eq } from "drizzle-orm";
import {
  conversations,
  projects,
  questions,
  issueDependencies,
  worktrees,
  settings,
} from "../../../../shared/db/schema";
import { inboxFixture, expectedRow } from "../test-support";
import {
  inboxResponseSchema,
  overviewResponseSchema,
  projectsResponseSchema,
} from "../../../../shared/inbox/schema";

describe("一覧のHTTP APIとSQLite", () => {
  const f = inboxFixture();
  it("複数プロジェクトの会話とissueを判断待ち、指示待ち、作業中で返す", async () => {
    f.conversation("c", { lastSeq: 2, recapSeq: 2 });
    f.event("c", 1, "assistant_text", { text: "応答\n二行目" });
    f.event("c", 2, "turn_end");
    f.issue("i", 1, { projectId: "q", state: "design_review", priority: "high" });
    f.conversation("design", { projectId: "q", kind: "design", issueId: "i", runState: "idle" });
    f.conversation("work", { runState: "working" });
    f.event("work", 1, "user_message", { origin: "developer", text: "開始" }, 20);
    f.event("work", 2, "tool_use", { name: "Bash", input: { command: "vp test\n次" } }, 30);
    f.issue("draft", 2, { state: "draft" });
    f.issue("ready", 3, { state: "ready" });
    f.issue("done", 4, { state: "done", closedAt: 200 });
    f.conversation("closed", { closedAt: 1 });
    const response = await f.request("/api/inbox");
    const body = await response.json();
    expect({ status: response.status, body: inboxResponseSchema.parse(body) }).toEqual({
      status: 200,
      body: {
        sections: [
          {
            name: "decision",
            rows: [
              expectedRow({
                key: "issue:i",
                kind: "issue",
                id: "i",
                project: { id: "q", name: "project-q" },
                title: "#1 i",
                section: "decision",
                reason: "design_review",
                status: "設計の承認",
                notice: "設計の承認を待っています",
                priority: "high",
                issue: { number: 1, state: "design_review", stopReason: null },
              }),
            ],
          },
          {
            name: "instruction",
            rows: [expectedRow({ unread: true, status: "応答", notice: "応答" })],
          },
          {
            name: "working",
            rows: [
              expectedRow({
                key: "conversation:work",
                id: "work",
                title: "会話: work",
                section: "working",
                reason: "working",
                activity: {
                  stage: "reply",
                  stageLabel: "応答",
                  stageStartedAt: 20,
                  lastAction: "Bash(vp test)",
                  lastActionAt: 30,
                },
              }),
            ],
          },
        ],
      },
    });
    f.db.update(conversations).set({ lastReadSeq: 2 }).where(eq(conversations.id, "c")).run();
    const read = inboxResponseSchema.parse(await (await f.request("/api/inbox")).json());
    expect(read.sections.find((s) => s.name === "instruction")?.rows).toEqual([
      expectedRow({ status: "応答", notice: "応答" }),
    ]);
  });
  it("番末の反映・失敗を待ち、文章の質問と開発者発言以外の未読だけを数える", async () => {
    f.conversation("c", { lastSeq: 3, recapSeq: 0, recapFailedAt: 99 });
    f.event("c", 1, "user_message", { text: "依頼", origin: "developer" }, 10);
    f.event("c", 2, "assistant_text", { text: "方針は?" }, 20);
    f.event("c", 3, "turn_end", {}, 100);
    f.db
      .insert(questions)
      .values({ id: "question", conversationId: "c", seq: 2, kind: "text", text: "方針は?\n次" })
      .run();
    expect(
      inboxResponseSchema.parse(await (await f.request("/api/inbox")).json()).sections,
    ).toEqual([
      { name: "decision", rows: [] },
      { name: "instruction", rows: [] },
      {
        name: "working",
        rows: [
          expectedRow({
            section: "working",
            reason: "summarizing",
            status: "応答をまとめています",
          }),
        ],
      },
    ]);
    f.db.update(conversations).set({ recapFailedAt: 100 }).where(eq(conversations.id, "c")).run();
    expect(
      inboxResponseSchema.parse(await (await f.request("/api/inbox")).json()).sections[0]?.rows,
    ).toEqual([
      expectedRow({
        section: "decision",
        reason: "question",
        status: "質問 1 件: 方針は?",
        notice: "方針は?",
        unread: true,
      }),
    ]);
    f.db.update(questions).set({ answered: true }).run();
    f.db.update(conversations).set({ lastReadSeq: 3 }).run();
    f.event("c", 4, "user_message", { origin: "developer", text: "次" });
    expect(
      inboxResponseSchema.parse(await (await f.request("/api/inbox")).json()).sections[1]?.rows,
    ).toEqual([expectedRow({ status: "方針は?", notice: "方針は?" })]);
  });
  it("スレッドの判断待ちを畳み、未読のidleスレッドを数え、最新活動を全会話から取る", async () => {
    f.issue("i", 1, { state: "ready" });
    f.conversation("impl", { kind: "impl", issueId: "i" });
    f.conversation("old-design", { kind: "design", issueId: "i", lastActivityAt: 700 });
    f.conversation("t", {
      kind: "thread",
      parentConversationId: "impl",
      runState: "failed",
      stopReason: "error",
      lastActivityAt: 500,
    });
    f.event("t", 1, "error", { message: "失敗\n続き" });
    f.conversation("answer", { kind: "thread", parentConversationId: "impl", lastActivityAt: 400 });
    f.event("answer", 1, "assistant_text", { text: "回答" });
    f.conversation("closed-thread", {
      kind: "thread",
      parentConversationId: "impl",
      runState: "waiting_permission",
      closedAt: 1,
    });
    f.issueEvent("i", 1, "comment", { text: "更新" }, 800);
    expect(
      inboxResponseSchema.parse(await (await f.request("/api/inbox")).json()).sections,
    ).toEqual([
      {
        name: "decision",
        rows: [
          expectedRow({
            key: "issue:i",
            kind: "issue",
            id: "i",
            title: "#1 i",
            section: "decision",
            reason: "thread",
            status: "スレッドの回答 1 件 · スレッド: 失敗: 失敗",
            notice: "失敗: 失敗",
            unread: true,
            threadAnswers: 1,
            lastActivityAt: 800,
            issue: { number: 1, state: "ready", stopReason: null },
          }),
        ],
      },
      { name: "instruction", rows: [] },
      { name: "working", rows: [] },
    ]);
  });
  it("idleスレッドの未読回答は既読の位置を進めると件数と印が消える", async () => {
    f.conversation("c");
    f.conversation("t", { kind: "thread", parentConversationId: "c", closedAt: 1 });
    f.event("t", 1, "assistant_text", { text: "回答" });
    expect(
      inboxResponseSchema.parse(await (await f.request("/api/inbox")).json()).sections[1]?.rows,
    ).toEqual([expectedRow({ status: "スレッドの回答 1 件 · ", threadAnswers: 1, unread: true })]);
    f.db.update(conversations).set({ lastReadSeq: 1 }).where(eq(conversations.id, "t")).run();
    expect(
      inboxResponseSchema.parse(await (await f.request("/api/inbox")).json()).sections[1]?.rows,
    ).toEqual([expectedRow({})]);
  });
  it("実装中のactivityは最新段階と今の番の最後のツールを使い未読にしない", async () => {
    f.issue("i", 1, { state: "implementing" });
    f.conversation("impl", { kind: "impl", issueId: "i", runState: "working" });
    f.conversation("a-later", { kind: "impl", issueId: "i", runState: "idle" });
    f.issueEvent("i", 1, "state_changed", { to: "implementing" }, 40);
    f.issueEvent("i", 2, "stage_changed", { stage: "review" }, 60);
    f.event("impl", 1, "user_message", { origin: "flow" }, 50);
    f.event("impl", 2, "tool_use", { name: "Read", input: { file_path: "/p/src/app.ts" } }, 70);
    expect(
      inboxResponseSchema.parse(await (await f.request("/api/inbox")).json()).sections[2]?.rows,
    ).toEqual([
      expectedRow({
        key: "issue:i",
        kind: "issue",
        id: "i",
        title: "#1 i",
        section: "working",
        reason: "working",
        issue: { number: 1, state: "implementing", stopReason: null },
        activity: {
          stage: "review",
          stageLabel: "レビュー",
          stageStartedAt: 60,
          lastAction: "Read(src/app.ts)",
          lastActionAt: 70,
        },
      }),
    ]);
  });
  it("ツリーは登録順・開始順・番号順で返し、解除したプロジェクトは全APIから除く", async () => {
    f.conversation("z");
    f.conversation("a");
    f.conversation("thread", { kind: "thread", parentConversationId: "a" });
    f.conversation("closed", { closedAt: 1 });
    f.issue("second", 2);
    f.issue("first", 1, { state: "draft" });
    f.issue("done", 3, { state: "done" });
    f.conversation("q-chat", { projectId: "q" });
    expect(projectsResponseSchema.parse(await (await f.request("/api/projects")).json())).toEqual({
      projects: [
        {
          id: "p",
          name: "project-p",
          flowPaused: false,
          conversations: [
            { id: "z", title: "z" },
            { id: "a", title: "a" },
          ],
          issues: [
            { id: "first", number: 1, title: "first", state: "draft" },
            { id: "second", number: 2, title: "second", state: "triage" },
          ],
        },
        {
          id: "q",
          name: "project-q",
          flowPaused: false,
          conversations: [{ id: "q-chat", title: "q-chat" }],
          issues: [],
        },
      ],
    });
    f.db.update(projects).set({ removedAt: 1 }).where(eq(projects.id, "p")).run();
    expect(projectsResponseSchema.parse(await (await f.request("/api/projects")).json())).toEqual({
      projects: [
        {
          id: "q",
          name: "project-q",
          flowPaused: false,
          conversations: [{ id: "q-chat", title: "q-chat" }],
          issues: [],
        },
      ],
    });
    expect(
      inboxResponseSchema.parse(await (await f.request("/api/inbox")).json()).sections,
    ).toEqual([
      { name: "decision", rows: [] },
      {
        name: "instruction",
        rows: [
          expectedRow({
            key: "conversation:q-chat",
            id: "q-chat",
            title: "会話: q-chat",
            project: { id: "q", name: "project-q" },
          }),
        ],
      },
      { name: "working", rows: [] },
    ]);
    for (const id of ["p", "missing"]) {
      const response = await f.request(`/api/projects/${id}/overview`);
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 404,
        body: {
          error: {
            code: "not_found",
            message: "プロジェクトが見つかりません。読み直してください。",
          },
        },
      });
    }
  });
  it("識別子の大小にかかわらず登録した順にプロジェクトを返す", async () => {
    f.db
      .insert(projects)
      .values({ id: "a", name: "last", path: "/a", defaultBranch: "main" })
      .run();
    expect(projectsResponseSchema.parse(await (await f.request("/api/projects")).json())).toEqual({
      projects: [
        { id: "p", name: "project-p", flowPaused: false, conversations: [], issues: [] },
        { id: "q", name: "project-q", flowPaused: false, conversations: [], issues: [] },
        { id: "a", name: "last", flowPaused: false, conversations: [], issues: [] },
      ],
    });
  });
  it.each([
    ["chat", null, "working", "reply", "応答", ""],
    ["triage", "triage", "working", "triage", "精査", ""],
    ["design", "design", "working", "design", "設計", ""],
    ["impl", "implementing", "working", "implement", "実装", ""],
    ["impl", "implementing", "working", "review", "レビュー", ""],
    ["impl", "implementing", "working", "pr", "PR", ""],
    ["impl", "implementing", "working", "ci", "CI 待ち", ""],
    ["impl", "implementing", "working", "merge", "merge", ""],
    ["chat", null, "idle", "reply", "応答", "回答"],
    ["triage", "triage", "stopped", "triage", "精査", "止めました"],
    ["design", "design", "idle", "design", "設計", "回答"],
    ["impl", "implementing", "idle", "implement", "実装", "回答"],
  ] as const)(
    "概要の %s/%s/%s/%s は既存のactivityと状況の文を返す",
    async (kind, state, runState, stage, stageLabel, status) => {
      if (state !== null) {
        f.issue("i", 1, { state });
        f.issueEvent(
          "i",
          1,
          "state_changed",
          stateChangedSchema.parse({
            from: state === "triage" ? "draft" : state === "design" ? "triage" : "ready",
            to: state,
            stopReason: null,
            detail: null,
            cause:
              state === "triage"
                ? "confirm"
                : state === "design"
                  ? "triage_reported"
                  : "impl_started",
          }),
          40,
        );
        if (["review", "pr", "ci", "merge"].includes(stage))
          f.issueEvent("i", 2, "stage_changed", { stage }, 60);
      }
      f.conversation("c", {
        kind,
        issueId: state === null ? null : "i",
        runState,
        stopReason: runState === "stopped" ? "user" : null,
        lastSeq: runState === "working" ? 2 : 4,
        recapSeq: runState === "working" ? 0 : 4,
      });
      record(
        f,
        "c",
        1,
        { type: "user_message", payload: { origin: "developer", text: "依頼", images: [] } },
        20,
      );
      record(
        f,
        "c",
        2,
        {
          type: "tool_use",
          payload: {
            tool_use_id: "tool-1",
            parent_tool_use_id: null,
            name: "Bash",
            input: { command: "vp test" },
          },
        },
        70,
      );
      if (runState !== "working") {
        record(
          f,
          "c",
          3,
          { type: "assistant_text", payload: { text: "回答", parent_tool_use_id: null } },
          80,
        );
        record(
          f,
          "c",
          4,
          runState === "stopped"
            ? { type: "stopped", payload: { reason: "user" } }
            : {
                type: "turn_end",
                payload: {
                  subtype: "success",
                  usage: {
                    input_tokens: 1,
                    output_tokens: 1,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                  },
                  cost_usd: 0,
                  duration_ms: 1,
                  permission_denials: 0,
                },
              },
          90,
        );
      }
      const activity =
        runState === "working"
          ? {
              stage,
              stageLabel,
              stageStartedAt:
                state === null ? 20 : ["review", "pr", "ci", "merge"].includes(stage) ? 60 : 40,
              lastAction: "Bash(vp test)",
              lastActionAt: 70,
            }
          : null;
      const common = { status, lastActivityAt: 100, unread: runState !== "working", activity };
      const response = await f.request("/api/projects/p/overview");
      const body = await response.json();
      expect({ status: response.status, body: overviewResponseSchema.parse(body) }).toEqual({
        status: 200,
        body: {
          project: { id: "p", name: "project-p", flowPaused: false },
          issueSections:
            state === null
              ? []
              : [
                  {
                    state,
                    total: 1,
                    rows: [{ key: "issue:i", id: "i", number: 1, title: "i", ...common }],
                  },
                ],
          conversations:
            state === null ? [{ key: "conversation:c", id: "c", title: "c", ...common }] : [],
        },
      });
    },
  );
  it("プロジェクトのissueを状態順・優先度順で返し完了と取り下げは10件に畳む", async () => {
    f.issue("draft", 1, { state: "draft" });
    f.issue("low", 2, { state: "triage", priority: "low" });
    f.issue("high", 3, { state: "triage", priority: "high" });
    for (const state of ["done", "withdrawn"] as const)
      for (let n = 1; n <= 11; n++)
        f.issue(`${state}-${n}`, (state === "done" ? 10 : 30) + n, { state, closedAt: n });
    const summary = (id: string, number: number, status = "—") => ({
      key: `issue:${id}`,
      id,
      number,
      title: id,
      status,
      lastActivityAt: 10,
      unread: false,
      activity: null,
    });
    const sections = [
      {
        state: "triage",
        total: 2,
        rows: [summary("high", 3, "開始を待っています"), summary("low", 2, "開始を待っています")],
      },
      { state: "draft", total: 1, rows: [summary("draft", 1)] },
      ...(["done", "withdrawn"] as const).map((state) => ({
        state,
        total: 11,
        rows: Array.from({ length: 10 }, (_, i) =>
          summary(`${state}-${11 - i}`, (state === "done" ? 10 : 30) + 11 - i),
        ),
      })),
    ];
    expect(
      overviewResponseSchema.parse(await (await f.request("/api/projects/p/overview")).json()),
    ).toEqual({
      project: { id: "p", name: "project-p", flowPaused: false },
      issueSections: sections,
      conversations: [],
    });
    expect(
      overviewResponseSchema.parse(
        await (await f.request("/api/projects/p/overview?closed=all")).json(),
      ),
    ).toEqual({
      project: { id: "p", name: "project-p", flowPaused: false },
      issueSections: sections.map((s) =>
        s.state === "done" || s.state === "withdrawn"
          ? { ...s, rows: [...s.rows, summary(`${s.state}-1`, s.state === "done" ? 11 : 31)] }
          : s,
      ),
      conversations: [],
    });
  });
  it("最後の発言を使い、閉じたスレッドの更新も経過に反映する", async () => {
    f.conversation("c", { lastSeq: 5, recapSeq: 5 });
    f.event("c", 1, "assistant_text", { text: "前の番" });
    f.event("c", 2, "turn_end");
    f.event("c", 3, "user_message", { origin: "developer" });
    f.event("c", 4, "assistant_text", { text: "最新の発言\n二行目" });
    f.event("c", 5, "turn_end");
    f.conversation("t", {
      kind: "thread",
      parentConversationId: "c",
      closedAt: 200,
      lastActivityAt: 300,
    });
    expect(
      inboxResponseSchema.parse(await (await f.request("/api/inbox")).json()).sections[1]?.rows,
    ).toEqual([
      expectedRow({
        status: "最新の発言",
        notice: "最新の発言",
        unread: true,
        lastActivityAt: 300,
      }),
    ]);
  });
  it("停止前の担当の会話から利用枠の戻る時刻を使い、無いときは再試行を案内する", async () => {
    f.issue("i", 1, { state: "stopped", stopReason: "usage_limit" });
    f.issueEvent("i", 1, "state_changed", { from: "design", to: "stopped" });
    f.conversation("design", { issueId: "i", kind: "design", resetsAt: 1000 });
    f.conversation("impl", { issueId: "i", kind: "impl", resetsAt: 2000 });
    const expected = expectedRow({
      key: "issue:i",
      kind: "issue",
      id: "i",
      title: "#1 i",
      section: "decision",
      reason: "usage_limit",
      status: "利用枠切れで停止 (12:34 に再開)",
      notice: "利用枠を使い切りました。12:34 に自動で再開します",
      issue: { number: 1, state: "stopped", stopReason: "usage_limit" },
    });
    expect(
      inboxResponseSchema.parse(await (await f.request("/api/inbox")).json()).sections[0]?.rows,
    ).toEqual([expected]);
    f.db.update(conversations).set({ resetsAt: null }).where(eq(conversations.id, "design")).run();
    expect(
      inboxResponseSchema.parse(await (await f.request("/api/inbox")).json()).sections[0]?.rows,
    ).toEqual([
      {
        ...expected,
        status: "利用枠切れで停止 (15 分ごとに再開を試みる)",
        notice: "利用枠を使い切りました。15 分ごとに再開を試みます",
      },
    ]);
  });
  it("実装待ちの理由を子・依存・親設計・一時停止・対象段階・空きの順で返す", async () => {
    f.issue("parent", 1, { state: "design" });
    f.issue("dep-low", 2);
    f.issue("dep-high", 3);
    f.issue("child", 4, { state: "ready" });
    f.issue("child-member", 5, { parentId: "child" });
    f.issue("dependency", 6, { state: "ready", parentId: "parent" });
    f.db
      .insert(issueDependencies)
      .values([
        { issueId: "dependency", dependsOnId: "dep-high" },
        { issueId: "dependency", dependsOnId: "dep-low" },
      ])
      .run();
    f.issue("parent-wait", 7, { state: "ready", parentId: "parent" });
    f.issue("slot", 8, { state: "ready" });
    const ready = async () =>
      overviewResponseSchema
        .parse(await (await f.request("/api/projects/p/overview")).json())
        .issueSections.find((s) => s.state === "ready");
    const summary = (id: string, number: number, status: string) => ({
      key: `issue:${id}`,
      id,
      number,
      title: id,
      status,
      lastActivityAt: 10,
      unread: false,
      activity: null,
    });
    const expected = [
      summary("child", 4, "子の完了を待つ"),
      summary("dependency", 6, "#2 の完了を待つ"),
      summary("parent-wait", 7, "親 #1 の設計を待つ"),
      summary("slot", 8, "実装の空きを待つ"),
    ];
    expect(await ready()).toEqual({ state: "ready", total: 4, rows: expected });
    f.db.insert(settings).values({ key: "flow_paused", value: true }).run();
    expect(await ready()).toEqual({
      state: "ready",
      total: 4,
      rows: expected.map((r) =>
        r.id === "slot" ? { ...r, status: "自動フローを一時停止しています" } : r,
      ),
    });
    f.db.delete(settings).run();
    f.db.update(projects).set({ autoStages: [] }).where(eq(projects.id, "p")).run();
    expect(await ready()).toEqual({
      state: "ready",
      total: 4,
      rows: expected.map((r) =>
        r.id === "slot" ? { ...r, status: "自動で処理しない段階です" } : r,
      ),
    });
  });
  it("完了・取り下げの残したworktreeは未削除だけ表示し、会話は更新順に返す", async () => {
    f.issue("done", 1, { state: "done" });
    f.issue("withdrawn", 2, { state: "withdrawn" });
    f.db
      .insert(worktrees)
      .values([
        { id: "w", projectId: "p", path: "/p/w", branch: "w", origin: "flow" },
        {
          id: "removed",
          projectId: "p",
          path: "/p/removed",
          branch: "r",
          origin: "flow",
          removedAt: 1,
        },
      ])
      .run();
    f.issueEvent("done", 1, "worktree_kept", { worktreeId: "w" });
    f.issueEvent("withdrawn", 1, "worktree_kept", { worktreeId: "removed" });
    f.conversation("old", { lastActivityAt: 20 });
    f.conversation("new", { lastActivityAt: 30 });
    expect(
      overviewResponseSchema.parse(await (await f.request("/api/projects/p/overview")).json()),
    ).toEqual({
      project: { id: "p", name: "project-p", flowPaused: false },
      issueSections: [
        {
          state: "done",
          total: 1,
          rows: [
            {
              key: "issue:done",
              id: "done",
              number: 1,
              title: "done",
              status: "worktree を残しました: /p/w",
              lastActivityAt: 100,
              unread: false,
              activity: null,
            },
          ],
        },
        {
          state: "withdrawn",
          total: 1,
          rows: [
            {
              key: "issue:withdrawn",
              id: "withdrawn",
              number: 2,
              title: "withdrawn",
              status: "—",
              lastActivityAt: 100,
              unread: false,
              activity: null,
            },
          ],
        },
      ],
      conversations: [
        {
          key: "conversation:new",
          id: "new",
          title: "new",
          status: "",
          lastActivityAt: 30,
          unread: false,
          activity: null,
        },
        {
          key: "conversation:old",
          id: "old",
          title: "old",
          status: "",
          lastActivityAt: 20,
          unread: false,
          activity: null,
        },
      ],
    });
  });
  it("DBの取得に失敗したときはJSONのinternalを返す", async () => {
    f.sqlite.exec("DROP TABLE questions");
    f.conversation("c");
    const response = await f.request("/api/inbox");
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 500,
      body: {
        error: { code: "internal", message: "一覧を取得できませんでした。読み直してください。" },
      },
    });
  });
  it.each(
    [
      [
        "Bash",
        "command",
        "pwd",
        "printf application-application-application-application-production",
        "command",
      ],
      [
        "Read",
        "file_path",
        "src/config.ts",
        "config/application-application-application-application-production.env",
        "path",
      ],
      [
        "Edit",
        "file_path",
        "src/config.ts",
        "config/application-application-application-application-production.env",
        "path",
      ],
      [
        "Write",
        "file_path",
        "src/config.ts",
        "config/application-application-application-application-production.env",
        "path",
      ],
      [
        "NotebookEdit",
        "notebook_path",
        "notes/check.ipynb",
        "notes/application-application-application-application-production.ipynb",
        "path",
      ],
      [
        "Grep",
        "pattern",
        "record",
        "application-application-application-application-production-record",
        "text",
      ],
      [
        "Glob",
        "pattern",
        "src/*.ts",
        "application-application-application-application-production/*.ts",
        "text",
      ],
      [
        "WebFetch",
        "url",
        "https://example.com",
        "https://example.com/application-application-application-production",
        "text",
      ],
      [
        "Task",
        "description",
        "設定を調べる",
        "application-application-application-application-production を調べる",
        "text",
      ],
      [
        "Agent",
        "description",
        "設定を調べる",
        "application-application-application-application-production を調べる",
        "text",
      ],
    ].flatMap(([tool, field, short, long, kind]) => [
      { tool, field, target: short!, kind, length: "短い" },
      { tool, field, target: long!, kind, length: "60字を超える" },
      {
        tool,
        field,
        target: `${long!}/${"additional/".repeat(14)}end`,
        kind,
        length: "通知120字を超える",
      },
    ]),
  )(
    "許可通知の $tool の $length 対象は入力を保ち最終通知だけを整形する",
    async ({ tool, field, target, kind }) => {
      const value =
        kind === "path"
          ? `/p/${target}`
          : kind === "command"
            ? `${target}\r\nsecond command`
            : target;
      const input = { [field!]: value };
      f.conversation("c", { runState: "waiting_permission" });
      record(f, "c", 1, {
        type: "permission_request",
        payload: { request_id: "permission-1", tool_name: tool, input },
      });
      f.conversation("w", { runState: "working" });
      record(
        f,
        "w",
        1,
        { type: "user_message", payload: { origin: "developer", text: "依頼", images: [] } },
        20,
      );
      record(
        f,
        "w",
        2,
        {
          type: "tool_use",
          payload: { tool_use_id: "tool-1", parent_tool_use_id: null, name: tool, input },
        },
        30,
      );
      const notice = `許可の確認: ${tool}(${target})`;
      const action = `${tool}(${target})`;
      const response = await f.request("/api/inbox");
      expect({
        status: response.status,
        body: inboxResponseSchema.parse(await response.json()),
      }).toEqual({
        status: 200,
        body: {
          sections: [
            {
              name: "decision",
              rows: [
                expectedRow({
                  section: "decision",
                  reason: "permission",
                  status: `許可の確認: ${tool}`,
                  notice: notice.length > 120 ? `${notice.slice(0, 120)}…` : notice,
                  unread: true,
                }),
              ],
            },
            { name: "instruction", rows: [] },
            {
              name: "working",
              rows: [
                expectedRow({
                  key: "conversation:w",
                  id: "w",
                  title: "会話: w",
                  section: "working",
                  reason: "working",
                  activity: {
                    stage: "reply",
                    stageLabel: "応答",
                    stageStartedAt: 20,
                    lastAction: action.length > 60 ? `${action.slice(0, 60)}…` : action,
                    lastActionAt: 30,
                  },
                }),
              ],
            },
          ],
        },
      });
    },
  );
  it.each(["mcp__server__list", "List"])(
    "対象の無い許可 %s は対象を付けずworkingのツール名も保つ",
    async (tool) => {
      const input = {
        command: "unrelated",
        file_path: "/p/unrelated",
        pattern: "unrelated",
        description: "unrelated",
      };
      f.conversation("c", { runState: "waiting_permission" });
      record(f, "c", 1, {
        type: "permission_request",
        payload: { request_id: "permission-1", tool_name: tool, input },
      });
      f.conversation("w", { runState: "working" });
      record(
        f,
        "w",
        1,
        {
          type: "tool_use",
          payload: { tool_use_id: "tool-1", parent_tool_use_id: null, name: tool, input },
        },
        30,
      );
      expect(inboxResponseSchema.parse(await (await f.request("/api/inbox")).json())).toEqual({
        sections: [
          {
            name: "decision",
            rows: [
              expectedRow({
                section: "decision",
                reason: "permission",
                status: `許可の確認: ${tool}`,
                notice: `許可の確認: ${tool}`,
                unread: true,
              }),
            ],
          },
          { name: "instruction", rows: [] },
          {
            name: "working",
            rows: [
              expectedRow({
                key: "conversation:w",
                id: "w",
                title: "会話: w",
                section: "working",
                reason: "working",
                activity: {
                  stage: "reply",
                  stageLabel: "応答",
                  stageStartedAt: 0,
                  lastAction: tool === "List" ? "List" : "list",
                  lastActionAt: 30,
                },
              }),
            ],
          },
        ],
      });
    },
  );
});

function record(
  f: ReturnType<typeof inboxFixture>,
  id: string,
  seq: number,
  event: unknown,
  at = 100,
) {
  const parsed = eventSchema.parse(event);
  f.event(id, seq, parsed.type, parsed.payload, at);
}
