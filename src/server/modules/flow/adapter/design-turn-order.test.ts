import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { ok } from "neverthrow";
import {
  ScriptedAgent,
  turnEnd,
} from "../../../../runner/modules/conversation/adapter/scripted-agent";
import { SqliteConversationStore } from "../../../../runner/modules/conversation/adapter/sqlite-conversation-store";
import type {
  AgentOutput,
  OpenParams,
} from "../../../../runner/modules/conversation/domain/agent-port";
import { AsyncQueue } from "../../../../shared/async-queue";
import { RUNNER_IPC_TIMEOUT_MS } from "../../../../shared/ipc";
import { reserveProjectActivity } from "../../../../shared/project/sqlite-project-run-activity";
import { createApp } from "../../../app";
import { createClockFake, createTailscaleFake, incomingWith } from "../../identity/test-support";
import { createProgressRepository } from "../../conversation/adapter/progress-repository";
import { createTimelineFilePort } from "../../conversation/adapter/timeline-file";
import { designFixture } from "../design-test-support";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function holdWriteLock(path: string, milliseconds: number) {
  const writer = spawn(
    process.execPath,
    [
      "-e",
      `const Database = require("better-sqlite3");
      const db = new Database(process.argv[1]);
      db.exec("BEGIN IMMEDIATE");
      process.stdout.write("locked");
      setTimeout(() => { db.exec("ROLLBACK"); db.close(); }, Number(process.argv[2]));`,
      path,
      String(milliseconds),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const exited = once(writer, "exit");
  const stop = async () => {
    if (writer.exitCode === null && writer.signalCode === null) writer.kill();
    await exited;
  };
  try {
    const [locked] = await Promise.race([
      once(writer.stdout, "data"),
      exited.then(() => {
        throw new Error("書き込みロックを取得できませんでした。");
      }),
    ]);
    expect(locked.toString()).toBe("locked");
    return { exited, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

describe("差し戻しの番と受理した指摘", () => {
  const f = designFixture();
  const history = () => f.runner.runtime.store.events("design");
  const runState = () => f.runner.runtime.store.get("design")?.runState;
  const reject = () =>
    f.request("/api/issues/issue/design/reject", "POST", { text: "新しい設計の指摘" });
  const previousQuestion = {
    requestId: "old-question",
    questions: [{ question: "前の確認", header: "確認", options: [], multi_select: false }],
  };
  const previousPermission = {
    requestId: "old-permission",
    toolName: "Bash",
    input: { command: "pwd" },
  };
  const progress = () =>
    createApp({
      build: "review",
      identity: {
        login: "dev@example.test",
        devIdentity: "1",
        tailscale: createTailscaleFake().api,
        clock: createClockFake(),
      },
      progress: {
        repository: createProgressRepository(f.db),
        timeline: createTimelineFilePort({ configDir: f.home, sleep: async () => {} }),
      },
    }).request("/api/conversations/design/progress", {}, incomingWith("127.0.0.1", 5000));

  function useControlledAgent(
    beforeResumedInterrupt?: (closeOutput: (error?: Error) => void) => Promise<void>,
  ) {
    const entered = deferred();
    const release = deferred();
    const opened: { params: OpenParams; output: AsyncQueue<AgentOutput> }[] = [];
    const sent: { sessionId: string; text: string }[] = [];
    const agent = new ScriptedAgent({ rules: [] });
    vi.spyOn(agent, "open").mockImplementation((params) => {
      const first = opened.length === 0;
      const resumed = opened.length === 1;
      const output = new AsyncQueue<AgentOutput>();
      let outputError: Error | undefined;
      opened.push({ params, output });
      return {
        output:
          resumed && beforeResumedInterrupt
            ? {
                async *[Symbol.asyncIterator]() {
                  yield* output;
                  if (outputError) throw outputError;
                },
              }
            : output,
        send: ({ text }) => {
          sent.push({ sessionId: params.sessionId, text });
          if (!first)
            output.push({
              kind: "assistant_text",
              uuid: "new-reply",
              text: "新しい番の返答",
              parentToolUseId: null,
            });
        },
        interrupt: async () => {
          if (first) {
            entered.resolve();
            await release.promise;
          } else if (resumed && beforeResumedInterrupt) {
            let outputClosed = false;
            await beforeResumedInterrupt((error) => {
              outputClosed = true;
              outputError = error;
              output.close();
            });
            if (outputClosed) return;
          }
          output.push(turnEnd("error_during_execution"));
        },
        commands: async () => [],
        close: () => output.close(),
      };
    });
    f.runner.runtime.options.agent = agent;
    return { entered, release, opened, sent };
  }

  async function reportDesign() {
    await f.worktree();
    expect(
      (
        await f.runner.runtime.send("design", { text: "設計の元の番", images: [], origin: "flow" })
      ).isOk(),
    ).toBe(true);
    expect((await f.submit()).isOk()).toBe(true);
  }

  it("受理済みの差し戻しを届けるまでプロジェクトを解除できない", async () => {
    const { entered, release } = useControlledAgent();
    await reportDesign();
    const pending = reject();
    const databasePath = join(f.home, "sukuna.db");
    try {
      await entered.promise;
      expect((await pending).status).toBe(202);

      const removal = reserveProjectActivity(databasePath, "project", "remove");
      if (removal.isOk()) removal.value.release();
      expect(removal.isErr() && removal.error.code).toBe("conflict");

      release.resolve();
      await f.runner.design.drain();
      const origins = history().flatMap((event) =>
        event.type === "user_message" ? [event.payload.origin] : [],
      );
      expect(origins).toEqual(["flow", "developer"]);
      expect(runState()).toBe("working");

      reserveProjectActivity(databasePath, "project", "remove")._unsafeUnwrap().release();
    } finally {
      release.resolve();
      await pending;
      await f.runner.design.drain();
    }
  });

  it.each(["発言", "ツール", "質問", "許可"] as const)(
    "旧番の終了後に指摘を記録し、遅れた%sを新しい番に渡さない",
    async (kind) => {
      const { entered, release, opened, sent } = useControlledAgent();
      await reportDesign();
      const pending = reject();
      try {
        await entered.promise;
        expect((await pending).status).toBe(202);
        const old = opened[0]!;
        if (kind === "発言")
          old.output.push({
            kind: "assistant_text",
            uuid: "old-reply",
            text: "旧番の返答",
            parentToolUseId: null,
          });
        if (kind === "ツール")
          old.output.push({
            kind: "tool_use",
            uuid: "old-tool",
            toolUseId: "tool",
            name: "Read",
            input: { file_path: "design.md" },
            parentToolUseId: null,
          });
        if (kind === "質問")
          await expect(old.params.onQuestion(previousQuestion)).rejects.toThrow("終了");
        if (kind === "許可")
          await expect(old.params.onPermission(previousPermission)).resolves.toMatchObject({
            behavior: "deny",
          });
        expect(history().filter(({ type }) => type === "user_message")).toHaveLength(1);

        release.resolve();
        await f.runner.design.drain();
        await expect
          .poll(() =>
            history().find(
              (e) => e.type === "assistant_text" && e.payload.text === "新しい番の返答",
            ),
          )
          .toBeDefined();

        const entries = history();
        const messages = entries.filter(({ type }) => type === "user_message");
        expect(messages).toHaveLength(2);
        const end = entries.find(({ type }) => type === "turn_end")!;
        expect(end.seq).toBeLessThan(messages[1]!.seq);
        const oldOutput = entries.find(
          ({ sdkUuid }) => sdkUuid === "old-reply" || sdkUuid === "old-tool",
        );
        if (kind === "発言" || kind === "ツール") expect(oldOutput!.seq).toBeLessThan(end.seq);
        expect(
          entries.filter(({ type }) => type === "question" || type === "permission_request"),
        ).toEqual([]);
        expect(runState()).toBe("working");
        expect(f.state()).toBe("design");
        expect(sent).toMatchObject([
          { sessionId: "design-session", text: "設計の元の番" },
          { sessionId: "design-session", text: expect.stringContaining("新しい設計の指摘") },
        ]);
        expect(opened[1]!.params.resume).toBe(true);
        const response = await progress();
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ activity: { lastAction: "応答を作成中" } });

        await expect(old.params.onQuestion(previousQuestion)).rejects.toThrow("終了");
        await expect(old.params.onPermission(previousPermission)).resolves.toMatchObject({
          behavior: "deny",
        });
        if (kind === "質問") {
          const next = opened[1]!.params
            .onQuestion({ ...previousQuestion, requestId: "new-question" })
            .catch(() => undefined);
          expect(runState()).toBe("waiting_answer");
          expect(history().at(-1)).toMatchObject({
            type: "question",
            payload: { request_id: "new-question" },
          });
          await f.runner.runtime.stop("design");
          await next;
        }
        if (kind === "許可") {
          const next = opened[1]!.params.onPermission({
            ...previousPermission,
            requestId: "new-permission",
          });
          expect(runState()).toBe("waiting_permission");
          expect(history().at(-1)).toMatchObject({
            type: "permission_request",
            payload: { request_id: "new-permission" },
          });
          await f.runner.runtime.stop("design");
          await next;
        }
      } finally {
        release.resolve();
      }
    },
  );

  it("旧 SDK が終了を報告せず切断したら、受理済みの指摘を預かりに戻す", async () => {
    const { entered, release, opened, sent } = useControlledAgent();
    await reportDesign();
    const pending = reject();
    try {
      await entered.promise;
      expect((await pending).status).toBe(202);
      opened[0]!.output.close();
      await f.runner.design.drain();

      expect(sent).toHaveLength(1);
      expect(history().filter(({ type }) => type === "user_message")).toHaveLength(1);
      expect(runState()).toBe("failed");
      expect(f.runner.runtime.store.queue("design")).toMatchObject([
        { text: expect.stringContaining("新しい設計の指摘") },
      ]);
      await expect
        .poll(() => f.changes.filter((e) => e.kind === "notice" && e.level === "error"))
        .toHaveLength(1);
    } finally {
      release.resolve();
    }
  });

  it("別のプロセスの書き込みを待ち切れなくても受理した指摘を預かりに戻す", async () => {
    const { entered, release, opened, sent } = useControlledAgent();
    await reportDesign();
    const pending = reject();
    try {
      await entered.promise;
      expect((await pending).status).toBe(202);
      const writer = await holdWriteLock(join(f.home, "sukuna.db"), 6300);
      try {
        opened[0]!.output.close();
        release.resolve();
        await f.runner.design.drain();
        expect(await writer.exited).toEqual([0, null]);
      } finally {
        await writer.stop();
      }
      const store = f.runner.runtime.store;
      expect(sent).toHaveLength(1);
      expect(history().filter(({ type }) => type === "user_message")).toHaveLength(1);
      expect(runState()).toBe("failed");
      expect(store.queue("design")).toMatchObject([
        { text: expect.stringContaining("新しい設計の指摘") },
      ]);
      expect(store.recoverAccepted()).toBe(false);
      expect(history().filter(({ type }) => type === "stopped")).toHaveLength(1);
      await expect
        .poll(() => f.changes.filter((e) => e.kind === "notice" && e.level === "error"))
        .toHaveLength(1);
    } finally {
      release.resolve();
    }
  }, 20000);

  it.each([0, 11200])(
    "差し戻しの回収を待つ通常指示を、書き込み競合 %s ミリ秒と呼び出し期限に応じて扱う",
    async (hold) => {
      const { entered, release, opened, sent } = useControlledAgent();
      await reportDesign();
      const pending = reject();
      let writer: Awaited<ReturnType<typeof holdWriteLock>> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await entered.promise;
        expect((await pending).status).toBe(202);
        const arrived = deferred();
        const runtime = f.runner.runtime;
        const send = runtime.send;
        const text = "あとから送った通常指示";
        vi.spyOn(runtime, "send").mockImplementation((...args) => {
          const result = send(...args);
          if (args[1].text === text) arrived.resolve();
          return result;
        });
        const next = Promise.resolve(
          f.request("/api/conversations/design/messages", "POST", {
            text,
            images: [],
            mode: "send",
            clientMessageId: "subsequent-request",
          }),
        );
        await Promise.race([
          arrived.promise,
          next.then((response) => {
            throw new Error(`通常指示が待機に入る前に HTTP ${response.status} を返しました。`);
          }),
        ]);
        if (hold) {
          writer = await holdWriteLock(join(f.home, "sukuna.db"), hold);
          timer = setTimeout(() => f.disconnectAtDeadline(), RUNNER_IPC_TIMEOUT_MS);
        }
        opened[0]!.output.close();
        release.resolve();

        const response = await next;
        if (writer) expect(await writer.exited).toEqual([0, null]);
        await f.runner.design.drain();
        await runtime.serial("design", () => Promise.resolve(ok(undefined)));

        const messages = history().flatMap((event) =>
          event.type === "user_message" ? [event.payload.text] : [],
        );
        if (hold) {
          expect(response.status).toBe(503);
          expect(await response.json()).toMatchObject({
            error: { code: "runner_unavailable" },
          });
          expect(runState()).toBe("failed");
          expect(sent.map((item) => item.text)).toEqual(["設計の元の番"]);
          expect(messages).toEqual(["設計の元の番"]);
          expect(runtime.store.queue("design")).toMatchObject([
            { text: expect.stringContaining("新しい設計の指摘") },
          ]);
        } else {
          expect(response.status).toBe(202);
          expect(sent.at(-1)?.text).toContain(text);
          expect(messages).toEqual(["設計の元の番", expect.stringContaining(text)]);
        }
      } finally {
        release.resolve();
        if (timer) clearTimeout(timer);
        await writer?.stop();
      }
    },
    24000,
  );

  it.each([
    "期限内",
    "停止開始前に期限切れ",
    "停止待ちに期限切れ",
    "停止失敗",
    "指示の記録中に期限切れ",
    "期限切れ後に出力終了",
    "期限切れ後に出力例外",
    "期限切れ後に出力終了と停止拒否",
    "期限切れ後の停止拒否に続いて出力終了",
    "期限内に出力終了",
    "出力終了後の記録中に期限切れ",
  ] as const)(
    "差し戻しに続く割り込みが%sのとき、終了した番と未受理の指示を区別する",
    async (ending) => {
      const interrupting = deferred();
      const completeInterrupt = deferred();
      let interruptionFailed = false;
      const { entered, release, opened, sent } = useControlledAgent(async (closeOutput) => {
        interrupting.resolve();
        await completeInterrupt.promise;
        if (ending === "期限切れ後に出力終了と停止拒否") {
          closeOutput();
          throw new Error("閉じた SDK を停止できません。");
        }
        if (
          (ending === "停止失敗" || ending === "期限切れ後の停止拒否に続いて出力終了") &&
          !interruptionFailed
        ) {
          interruptionFailed = true;
          throw new Error("SDK の停止に失敗");
        }
        if (
          ending === "期限切れ後に出力終了" ||
          ending === "期限内に出力終了" ||
          ending === "出力終了後の記録中に期限切れ"
        )
          closeOutput();
        if (ending === "期限切れ後に出力例外")
          closeOutput(new Error("AI の出力を読めませんでした。"));
      });
      await reportDesign();
      const rejection = reject();
      try {
        await entered.promise;
        expect((await rejection).status).toBe(202);
        const waiting = deferred();
        const runtime = f.runner.runtime;
        const send = runtime.send;
        const text = "差し戻しに続く割り込み指示";
        vi.spyOn(runtime, "send").mockImplementation((...args) => {
          const result = send(...args);
          if (args[1].text === text) waiting.resolve();
          return result;
        });
        const next = Promise.resolve(
          f.request("/api/conversations/design/messages", "POST", {
            text,
            images: [],
            mode: "interrupt",
            clientMessageId: "next-interrupt",
          }),
        );
        const premature = next.then((response) => {
          throw new Error(`割り込みが待機している間に HTTP ${response.status} を返しました。`);
        });
        await Promise.race([waiting.promise, premature]);
        expect(sent.map((item) => item.text)).toEqual(["設計の元の番"]);
        if (ending === "停止開始前に期限切れ") f.disconnectAtDeadline();
        release.resolve();
        if (ending !== "停止開始前に期限切れ") {
          await Promise.race([interrupting.promise, premature]);
          if (
            ending === "停止待ちに期限切れ" ||
            ending === "停止失敗" ||
            ending.startsWith("期限切れ後")
          )
            f.disconnectAtDeadline();
          if (ending === "指示の記録中に期限切れ" || ending === "出力終了後の記録中に期限切れ")
            f.expireAfterInsert("conversation_events", "user_message");
          completeInterrupt.resolve();
        }

        const response = await next;
        await runtime.serial("design", () => Promise.resolve(ok(undefined)));
        if (ending === "期限切れ後の停止拒否に続いて出力終了") {
          expect(runState()).toBe("working");
          opened[1]!.output.close();
          await expect.poll(runState).toBe("failed");
        }
        const messages = ["設計の元の番", expect.stringContaining("新しい設計の指摘")];
        const withinDeadline = ending === "期限内" || ending === "期限内に出力終了";
        if (withinDeadline) {
          expect(response.status).toBe(202);
          messages.push(text);
        } else {
          expect(response.status).toBe(503);
          expect(await response.json()).toMatchObject({ error: { code: "runner_unavailable" } });
        }
        expect(sent.map((item) => item.text)).toEqual(messages);
        expect(
          history().flatMap((event) => (event.type === "user_message" ? [event.payload.text] : [])),
        ).toEqual(messages);
        const streamEnded =
          ending.startsWith("期限切れ後") || ending === "出力終了後の記録中に期限切れ";
        const stopped =
          ending === "停止待ちに期限切れ" || ending === "指示の記録中に期限切れ" || streamEnded;
        const interrupted = (stopped && !streamEnded) || ending === "期限内";
        expect(history().filter(({ type }) => type === "turn_end")).toHaveLength(
          interrupted ? 2 : 1,
        );
        expect(history().filter(({ type }) => type === "stopped")).toHaveLength(stopped ? 1 : 0);
        expect(runState()).toBe(stopped ? "failed" : "working");
        if (ending === "期限内に出力終了") expect(opened).toHaveLength(3);
        if (stopped)
          await expect
            .poll(() =>
              f.changes.find(
                (event) =>
                  event.kind === "conversation" &&
                  event.conversation_id === "design" &&
                  event.run_state === "failed",
              ),
            )
            .toBeDefined();
        if (ending === "停止待ちに期限切れ" || streamEnded) {
          if (ending === "出力終了後の記録中に期限切れ") f.clearExpiryTrigger();
          const following = "停止確定後に届ける指示";
          const after = await f.request("/api/conversations/design/messages", "POST", {
            text: following,
            images: [],
            mode: "send",
            clientMessageId: "after-expired-interrupt",
          });
          expect(after.status).toBe(202);
          expect(await after.json()).toMatchObject({ result: "delivered" });
          expect(
            history().find(
              (record) => record.type === "user_message" && record.payload.text === following,
            ),
          ).toBeDefined();
          expect(sent.at(-1)?.text).toBe(following);
          expect(opened).toHaveLength(
            ending === "出力終了後の記録中に期限切れ" ? 4 : streamEnded ? 3 : 2,
          );
          expect(runState()).toBe("working");
        }
        if (ending === "停止失敗") {
          opened[1]!.output.push(turnEnd("error_during_execution"));
          await expect.poll(runState).toBe("failed");
          expect(history().at(-1)).toMatchObject({
            type: "stopped",
            payload: { reason: "error" },
          });
        }
      } finally {
        release.resolve();
        completeInterrupt.resolve();
      }
    },
  );

  it.each(["EOF", "送信例外", "出力例外", "正常終了"] as const)(
    "再接続した SDK の%sに応じて失敗を知らせ、会話に記録済みの指摘を残す",
    async (ending) => {
      const opened: OpenParams[] = [];
      const agent = new ScriptedAgent({ rules: [] });
      vi.spyOn(agent, "open").mockImplementation((params) => {
        opened.push(params);
        const first = opened.length === 1;
        const output = new AsyncQueue<AgentOutput>();
        return {
          output: {
            async *[Symbol.asyncIterator]() {
              yield* output;
              if (!first && ending === "出力例外") throw new Error("通信の読み取りに失敗");
            },
          },
          send: () => {
            if (first) return;
            if (ending === "正常終了") output.push(turnEnd("success"));
            output.close();
            if (ending === "送信例外") throw new Error("通信の送信に失敗");
          },
          interrupt: async () => output.push(turnEnd("error_during_execution")),
          commands: async () => [],
          close: () => output.close(),
        };
      });
      f.runner.runtime.options.agent = agent;

      await reportDesign();
      expect((await reject()).status).toBe(202);
      await f.runner.design.drain();
      const succeeded = ending === "正常終了";
      await expect.poll(runState).toBe(succeeded ? "idle" : "failed");
      expect(opened.map(({ resume, sessionId }) => ({ resume, sessionId }))).toEqual([
        { resume: true, sessionId: "design-session" },
        { resume: true, sessionId: "design-session" },
      ]);
      expect(history().filter(({ type }) => type === "user_message")).toMatchObject([
        { payload: { text: "設計の元の番" } },
        { payload: { text: expect.stringContaining("新しい設計の指摘") } },
      ]);
      expect(f.runner.runtime.store.queue("design")).toEqual([]);
      await expect
        .poll(() => f.changes.filter((e) => e.kind === "notice" && e.level === "error"))
        .toHaveLength(succeeded ? 0 : 1);
    },
  );

  it("応答済みでまだ配達されていない指摘を起動時に1回だけ預かりへ戻せる", async () => {
    const { entered, release } = useControlledAgent();
    await reportDesign();
    const pending = reject();
    try {
      await entered.promise;
      expect((await pending).status).toBe(202);
      const copy = join(f.home, "before-delivery.db");
      await f.backupDatabase(copy);
      const db = new Database(copy);
      try {
        const recovered = new SqliteConversationStore(db);
        expect(recovered.queue("design")).toEqual([]);
        expect(recovered.recoverAccepted()).toBe(true);
        expect(recovered.recoverAccepted()).toBe(false);
        expect(recovered.queue("design")).toMatchObject([
          { text: expect.stringContaining("新しい設計の指摘") },
        ]);
        expect(
          recovered.events("design").filter(({ type }) => type === "user_message"),
        ).toHaveLength(1);
      } finally {
        db.close();
      }
    } finally {
      release.resolve();
    }
  });
});
