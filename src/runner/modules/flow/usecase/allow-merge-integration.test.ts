import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { fixture, flowText, pauseOld, scenarios } from "../merge-integration-test-support";
import { issueInstructions } from "../../issue/domain/issue-instructions";
it.each(scenarios)(
  "公開許可は古いSDKの$boundary完了後に$modeの現作業場所へ一度送り、queueを分離する",
  async ({ mode, boundary }) => {
    const f = await fixture();
    const sessionId = f.runner.runtime.store.get("c")!.sessionId;
    const current = f.change(mode);
    const paused = pauseOld(f, boundary);
    const pending = f.permit();
    try {
      await Promise.race([
        paused.entered,
        pending.then(() => {
          throw new Error("古いSDKの終了を待っていません");
        }),
      ]);
      f.sql
        .prepare("UPDATE projects SET model='haiku',permission_mode='default' WHERE id='p'")
        .run();
      expect({
        opened: f.observed.opened.length,
        delivered: f.observed.delivered.map((x) => x.text),
        events: f.state().events,
        queue: f.runner.runtime.store.queue("c"),
      }).toEqual({ opened: 1, delivered: ["initial"], events: [], queue: [f.queued] });
      paused.release();
      expect(await pending).toEqual({ status: 202, body: { state: "implementing" } });
      const opened = f.observed.opened[1]!;
      expect({
        sessionId: opened.sessionId,
        resume: opened.resume,
        cwd: opened.cwd,
        model: opened.model,
        permissionMode: opened.permissionMode,
        appendSystemPrompt: opened.appendSystemPrompt,
        context: opened.context,
        tools: opened.appTools.map((t) => t.name).sort(),
      }).toEqual({
        sessionId,
        resume: true,
        cwd: current.cwd,
        model: "haiku",
        permissionMode: "default",
        appendSystemPrompt: `${issueInstructions()}\n\nこの会話で決まったことの一覧は ${join(f.home, "docs/decisions/c.md")} にある。前に決めたことを尋ねられたら、このファイルを読んで答える。目次はツール recap_read で読める。`,
        context: { conversationId: "c", projectId: "p", issueId: "i" },
        tools: [
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
          "recap_read",
        ].sort(),
      });
      expect({
        opened: f.observed.opened.length,
        delivered: f.observed.delivered.map((x) => x.text),
        messages: f.rawMessages().slice(1),
        queue: f.runner.runtime.store.queue("c"),
        receipt: f.runner.runtime.store.duplicate("c", "queued-client", 0),
        stock: f.state().stock,
        eventTypes: f.state().events.map((row) => (row as { type: string }).type),
      }).toEqual({
        opened: 2,
        delivered: ["initial", flowText],
        messages: [
          {
            text: flowText,
            images: [],
            origin: "flow",
            client_ids: [],
            queued_ids: [],
            client_receipts: [],
          },
        ],
        queue: [f.queued],
        receipt: { result: "queued", queuedId: "q" },
        stock: { id: "s", state: "sent", sent_seq: null },
        eventTypes: ["merge_allowed", "state_changed", "stage_changed"],
      });
      f.finishFlow.resolve();
      await expect
        .poll(() => f.observed.delivered.map((x) => x.text))
        .toEqual(["initial", flowText, "queued instruction"]);
      await expect.poll(() => f.runner.runtime.store.get("c")?.runState).toBe("idle");
      const queuedEvent = f.runner.runtime.store
        .events("c")
        .find((e) => e.type === "user_message" && e.payload.origin === "queued")!;
      expect({
        queue: f.runner.runtime.store.queue("c"),
        receipt: f.runner.runtime.store.duplicate("c", "queued-client", 0),
        stock: f.state().stock,
        queuedMessage: f.rawMessages().at(-1),
      }).toEqual({
        queue: [],
        receipt: { result: "queued", queuedId: "q" },
        stock: { id: "s", state: "sent", sent_seq: queuedEvent.seq },
        queuedMessage: {
          text: "queued instruction",
          images: [],
          origin: "queued",
          client_ids: ["queued-client"],
          queued_ids: ["q"],
          client_receipts: [
            { client_id: "queued-client", result: "queued", queued_id: "q", received_at: 1000 },
          ],
        },
      });
    } finally {
      paused.release();
      f.finishFlow.resolve();
      await pending;
    }
  },
);
it.each(scenarios)(
  "古いSDKの$boundary待ちでshutdownすると$modeでも許可・発言・新実行を残さない",
  async ({ mode, boundary }) => {
    const f = await fixture();
    f.change(mode);
    const before = f.state();
    const paused = pauseOld(f, boundary);
    const pending = f.permit();
    let stopping: Promise<void> | undefined;
    try {
      await Promise.race([
        paused.entered,
        pending.then(() => {
          throw new Error("終了待ちに入りませんでした");
        }),
      ]);
      stopping = f.runner.runtime.shutdown();
      paused.release();
      expect(await pending).toEqual({
        status: 409,
        body: {
          error: {
            code: "conflict",
            message: "会話の状態が変わりました。もう一度操作してください。",
          },
        },
      });
      await stopping;
      expect({
        state: f.state(),
        opened: f.observed.opened.length,
        delivered: f.observed.delivered.map((x) => x.text),
        executions: [...f.runner.runtime.executions.keys()],
      }).toEqual({ state: before, opened: 1, delivered: ["initial"], executions: [] });
    } finally {
      paused.release();
      f.finishFlow.resolve();
      await pending;
      await stopping;
    }
  },
);
it("別flow worktreeのlease拒否でsaveStateChangeがnullでも全体を戻し、解放後の同じ許可を通す", async () => {
  const f = await fixture();
  const lease = f.holdOtherFlow();
  const before = f.state();
  try {
    expect(await f.permit()).toEqual({
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: "worktree を削除しています。完了してから、もう一度操作してください",
        },
      },
    });
    expect({
      state: f.state(),
      opened: f.observed.opened.length,
      delivered: f.observed.delivered.map((x) => x.text),
    }).toEqual({ state: before, opened: 1, delivered: ["initial"] });
  } finally {
    lease.release();
  }
  expect(await f.permit()).toEqual({ status: 202, body: { state: "implementing" } });
  expect(f.state().events.map((row) => (row as { type: string }).type)).toEqual([
    "merge_allowed",
    "state_changed",
    "stage_changed",
  ]);
  expect(f.rawMessages().filter((m) => m.origin === "flow")).toEqual([
    {
      text: flowText,
      images: [],
      origin: "flow",
      client_ids: [],
      queued_ids: [],
      client_receipts: [],
    },
  ]);
});

it.each(scenarios)(
  "公開withdrawが古いSDKの$boundary待ち中に成功すると$modeの許可は新SDKを開かず409",
  async ({ mode, boundary }) => {
    const f = await fixture();
    f.change(mode);
    const paused = pauseOld(f, boundary);
    const pending = f.permit();
    let withdrawal: Promise<void> | undefined;
    try {
      await Promise.race([
        paused.entered,
        pending.then(() => {
          throw new Error("旧SDKの終了待ちに入りませんでした");
        }),
      ]);
      withdrawal = f.withdraw();
      await expect
        .poll(() => f.state().issue)
        .toEqual({ state: "withdrawn", stop_reason: null, updated_at: 1000 });
      const withdrawn = f.state();
      paused.release();
      expect(await pending).toEqual({
        status: 409,
        body: {
          error: {
            code: "conflict",
            message: "issue の状態が変わりました。読み直してから操作してください。",
          },
        },
      });
      await withdrawal;
      expect({
        state: f.state(),
        opened: f.observed.opened.length,
        delivered: f.observed.delivered.map((x) => x.text),
        receipt: f.runner.runtime.store.duplicate("c", "queued-client", 0),
      }).toEqual({
        state: withdrawn,
        opened: 1,
        delivered: ["initial"],
        receipt: { result: "queued", queuedId: "q" },
      });
    } finally {
      paused.release();
      f.finishFlow.resolve();
      await pending;
      await withdrawal;
    }
  },
);
it.each(["database", "sdk"])(
  "状態競合と異なる %s の障害は許可の保存を戻し500のまま返す",
  async (failure) => {
    const f = await fixture({ failSdkOpen: failure === "sdk" });
    f.change("move");
    if (failure === "database")
      f.sql.exec(
        "CREATE TRIGGER reject_ci BEFORE INSERT ON issue_events WHEN NEW.type='stage_changed' BEGIN SELECT RAISE(ABORT,'database failed'); END",
      );
    const before = f.state();
    expect(await f.permit()).toEqual({
      status: 500,
      body: {
        error: {
          code: "internal",
          message: "会話の操作に失敗しました。もう一度操作してください。",
        },
      },
    });
    expect({
      state: f.state(),
      opened: f.observed.opened.length,
      delivered: f.observed.delivered.map((x) => x.text),
    }).toEqual({ state: before, opened: 1, delivered: ["initial"] });
  },
);
