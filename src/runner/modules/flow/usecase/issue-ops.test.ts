import { describe, expect, it } from "vite-plus/test";
import { issueFixture, expectedIssue, ScriptedAgent } from "../issue-ops-test-support";

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
