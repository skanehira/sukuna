import { ok } from "neverthrow";
import { it, expect } from "vite-plus/test";
import { prFixture, headSha } from "../merge-test-support";
it("同時の許可は先の一件だけを記録し指示を届ける", async () => {
  const f = prFixture();
  const result = await Promise.all([f.allowMerge("i", headSha), f.allowMerge("i", headSha)]);
  expect(result.map((r) => (r.isOk() ? r.value : r.error))).toEqual([
    { state: "implementing" },
    { code: "conflict", message: "issue の状態が変わりました。読み直してから操作してください。" },
  ]);
  expect(f.eventRows().map(({ type }) => ({ type }))).toEqual([
    { type: "merge_allowed" },
    { type: "state_changed" },
    { type: "stage_changed" },
  ]);
  expect(f.agent.sent).toEqual([
    {
      sessionId: "session",
      text: "merge を許可されました。merge の手順で CI を待って merge してください",
    },
  ]);
});
it("会話が無い許可は状態とイベントを変えず409", async () => {
  const f = prFixture();
  f.removeConversation();
  const result = await f.allowMerge("i", headSha);
  expect(result.isErr() ? result.error : result.value).toEqual({
    code: "conflict",
    message: "issue の状態が変わりました。読み直してから操作してください。",
  });
  expect(f.issueRows().map(({ state }) => ({ state }))).toEqual([{ state: "stopped" }]);
  expect(f.eventRows()).toEqual([]);
});
it("状態の更新が失敗した許可は会話の発言もロールバックする", async () => {
  const f = prFixture();
  f.database.sqlite.exec(
    "CREATE TRIGGER reject_ci BEFORE INSERT ON issue_events WHEN NEW.type = 'stage_changed' BEGIN SELECT RAISE(ABORT, 'reject'); END",
  );
  const result = await f.allowMerge("i", headSha);
  expect(result.isErr() ? result.error.code : "ok").toBe("internal");
  expect(f.issueRows().map(({ state }) => ({ state }))).toEqual([{ state: "stopped" }]);
  expect(f.eventRows()).toEqual([]);
  expect(f.userMessages()).toEqual([]);
  expect(f.agent.sent).toEqual([]);
});
it("内部IPCの許可は不正なhead_shaを400にする", async () => {
  const f = prFixture();
  const r = await f.ipc.request("/flow/issues/i/pr/allow-merge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ head_sha: "invalid" }),
  });
  expect([r.status, await r.json()]).toEqual([
    400,
    { error: { code: "invalid_input", message: "入力を確認してください。" } },
  ]);
});

it.each([true, false])(
  "許可が直列処理を待つ間に終了が始まると GitHub=%s でも許可と送信を記録しない",
  async (usesGithub) => {
    let beginInterrupt!: () => void;
    let releaseInterrupt!: () => void;
    const interrupted = new Promise<void>((resolve) => {
      beginInterrupt = resolve;
    });
    const interruptGate = new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    });
    const f = prFixture({
      interruptBusy: async () => {
        beginInterrupt();
        await interruptGate;
      },
    });
    if (!usesGithub) f.local();
    f.addConversation("busy");
    const sent = await f.runtime.send("busy", { text: "busy", images: [], origin: "developer" });
    expect(sent.isOk()).toBe(true);
    let releaseSerial!: () => void;
    const serialGate = new Promise<void>((resolve) => {
      releaseSerial = resolve;
    });
    const waiting = f.runtime.serial("c", async () => {
      await serialGate;
      return ok(undefined);
    });
    const permitting = f.allowMerge("i", headSha);
    const stopping = f.runtime.shutdown();
    try {
      await interrupted;
      releaseSerial();
      await waiting;
      const result = await permitting;
      expect(result.isErr() ? result.error : result.value).toEqual({
        code: "conflict",
        message: "issue の状態が変わりました。読み直してから操作してください。",
      });
      expect(f.issueRows()).toEqual([{ state: "stopped", reason: "merge_confirm" }]);
      expect(f.eventRows()).toEqual([]);
      expect(f.userMessages()).toEqual([
        {
          type: "user_message",
          payload: {
            text: "busy",
            images: [],
            origin: "developer",
            client_ids: [],
            queued_ids: [],
            client_receipts: [],
          },
        },
      ]);
      expect(f.agent.sent).toEqual([{ sessionId: "session", text: "busy" }]);
    } finally {
      releaseSerial();
      releaseInterrupt();
      await stopping;
    }
    expect([...f.runtime.executions.keys()]).toEqual([]);
  },
);
