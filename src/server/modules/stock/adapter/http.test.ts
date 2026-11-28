import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { AsyncQueue } from "../../../../shared/async-queue";
import type { AgentOutput } from "../../../../runner/modules/conversation/domain/agent-port";
import { turnEnd } from "../../../../runner/modules/conversation/adapter/scripted-agent";
import { openDatabase } from "../../../../shared/db/open";
import { createConversationDependencies } from "../../conversation/adapter/dependencies";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
  type OpenedDatabase,
} from "../../../../shared/db/test-helpers";
import { createApp } from "../../../app";
import { incomingWith } from "../../identity/test-support";
import { createTailscaleLocalApi } from "../../identity/adapter/tailscale-local-api";
import { createWorkspaceDependencies } from "../../workspace/adapter/dependencies";
import { createStockDependencies } from "./dependencies";
import { startRunnerApp } from "../../../../runner/app";
import { ScriptedAgent } from "../../../../runner/modules/conversation/adapter/scripted-agent";
import { readEnvironment } from "../../../../shared/env";
import { RunnerLink } from "../../../runner-link";
import { WsHub } from "../../../ws-hub";
import {
  stockItemSchema,
  stockResponseSchema,
  threadsResponseSchema,
} from "../../../../shared/stock";
import type { StockItem, Quote } from "../../../../shared/stock";

describe("ストックとスレッド API", () => {
  let requestClock: number;
  let fireRequestDeadline: () => void;
  let home: string;
  let cwd: string;
  let database: OpenedDatabase;
  let screenDatabase: OpenedDatabase;
  let runner: Awaited<ReturnType<typeof startRunnerApp>>;
  let link: RunnerLink;
  let app: ReturnType<typeof createApp>;
  let conversationApp: ReturnType<typeof createApp>;
  let deps: ReturnType<typeof createStockDependencies>;
  let agent: ScriptedAgent;
  let messages: unknown[];
  let agentActions: string[];
  let agentFailure: "interrupt" | "close" | undefined;
  let beforeAgentClose: (() => void) | undefined;
  let timers: { callback: () => void | Promise<void>; milliseconds: number; cancelled: boolean }[];
  const terminal = { kind: "terminal", mode: "line", text: "保存した引用" } satisfies Quote;
  const baseItem = (id: string, changes: Partial<StockItem> = {}): StockItem => ({
    id,
    conversationId: "c",
    kind: "instruction",
    text: "指示",
    quote: terminal,
    state: "stocked",
    stale: false,
    sentAt: null,
    sentSeq: null,
    thread: null,
    githubCommentUrl: null,
    ...changes,
  });
  const request = (path: string, method = "GET", body?: unknown, port = 50000) =>
    (path.includes("/queue/") || path.includes("/permissions/") || path.endsWith("/messages")
      ? conversationApp
      : app
    ).request(
      path,
      {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      },
      incomingWith("127.0.0.1", port),
    );
  const add = async (quote: Quote = terminal) => {
    const response = await request("/api/conversations/c/stock", "POST", {
      kind: "instruction",
      text: "指示",
      quote,
    });
    expect(response.status).toBe(201);
    return stockItemSchema.parse(((await response.json()) as { item: unknown }).item);
  };
  beforeEach(async () => {
    home = createTempHome();
    cwd = join(home, "workspace");
    mkdirSync(cwd);
    database = openMigratedDatabase(home);
    screenDatabase = openDatabase(home);
    database.sqlite
      .prepare("INSERT INTO projects (id,name,path,default_branch) VALUES ('p','fixture',?,'main')")
      .run(cwd);
    database.sqlite
      .prepare(
        "INSERT INTO conversations (id,project_id,kind,cwd,title) VALUES ('c','p','chat',?,'会話')",
      )
      .run(cwd);
    agentActions = [];
    agentFailure = undefined;
    beforeAgentClose = undefined;
    agent = new ScriptedAgent({
      rules: [
        { match: "^hold:", steps: [{ hold: true }] },
        { match: "^idle 元の会話$", steps: [{ text: "元の会話への応答" }, { end: "success" }] },
        {
          match: "^tool:本文なし$",
          steps: [{ tool: "Read", input: {}, result: "確認" }, { end: "success" }],
        },
        { match: "^error:案$", steps: [{ text: "失敗した案" }, { end: "error_during_execution" }] },

        {
          match: "^作業を開始",
          steps: [{ permission: { tool_name: "Write", input: {} } }, { end: "success" }],
        },
        { match: "idle", steps: [{ end: "success" }] },
        { match: "確定した事項を", steps: [{ text: "案の文" }, { end: "success" }] },
      ],
      fallback: [{ text: "作業中" }, { hold: true }],
    });
    const open = agent.open.bind(agent);
    agent.open = (params) => {
      const session = open(params);
      return {
        ...session,
        interrupt: async () => {
          agentActions.push("interrupt");
          if (agentFailure === "interrupt") throw new Error("fixture stop failure");
          await session.interrupt();
        },
        close: () => {
          agentActions.push("close");
          beforeAgentClose?.();
          if (agentFailure === "close") throw new Error("fixture release failure");
          session.close();
        },
      };
    };
    timers = [];
    requestClock = Date.now();
    fireRequestDeadline = () => {
      throw new Error("IPC の期限が設定されていません");
    };
    runner = await startRunnerApp({
      clock: {
        now: () => requestClock,
        setTimeout: (callback, milliseconds) => {
          const timer = { callback, milliseconds, cancelled: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
      },
      database,
      environment: readEnvironment(
        "runner",
        { SUKUNA_HOME: home },
        home,
        () => true,
      )._unsafeUnwrap(),
      agent,
      log: () => {},
    });
    const hub = new WsHub(database.sqlite);
    messages = [];
    const client = {
      bufferedAmount: 0,
      send: (message: string) => messages.push(JSON.parse(message)),
      close: () => {},
    };
    hub.add(client);
    for (const topic of ["conversation:c", "conversation:t", "inbox"])
      hub.receive(client, { op: "subscribe", topic });
    await new Promise<void>((resolve) => {
      link = new RunnerLink({
        socket: join(home, "runner.sock"),
        now: () => requestClock,
        clock: {
          setTimeout: (callback, delay) => {
            const timer = setTimeout(callback, delay);
            timer.unref();
            fireRequestDeadline = callback;
            return () => clearTimeout(timer);
          },
        },
        log: () => {},
        notice: (notice) => hub.notice(notice),
        connection: (connected) => {
          if (connected) resolve();
        },
      });
      link.start();
    });
    let id = 0;
    const changed: Parameters<typeof createConversationDependencies>[0]["changed"] = (id, parts) =>
      hub.notice({ kind: "conversation_parts", conversation_id: id, parts });
    const conversations = createConversationDependencies({
      sqlite: database.sqlite,
      home,
      runner: link,
      id: () => "unused",
      now: () => 1234,
      changed,
      reopened: (ids) => ids.forEach((id) => changed(id, [])),
    });
    deps = createStockDependencies({
      database: () => screenDatabase,
      workspace: createWorkspaceDependencies(() => database.db),
      runner: () => link,
      now: () => 1234,
      id: () => `s${String(++id).padStart(3, "0")}`,
      changed: (id, parts) =>
        hub.notice({ kind: "conversation_parts", conversation_id: id, parts }),
    });
    const appOptions = {
      build: "test",
      identity: {
        login: "dev@example.com",
        devIdentity: "dev@example.com",
        tailscale: createTailscaleLocalApi(),
        clock: { now: () => 0 },
      },
      stock: deps,
    };
    app = createApp(appOptions);
    conversationApp = createApp({ ...appOptions, conversations });
  });
  afterEach(async () => {
    agentFailure = undefined;
    link.stop();
    await runner.shutdown();
    screenDatabase.close();
    database.close();
    removeTempHome(home);
  });

  const sendStock = (body: unknown, id = "c", port?: number) =>
    request(`/api/conversations/${id}/stock/send`, "POST", body, port);
  const addQuestion = async (text: string) => {
    const response = await request("/api/conversations/c/stock", "POST", {
      kind: "question",
      text,
      quote: terminal,
    });
    expect(response.status).toBe(201);
    return stockItemSchema.parse(((await response.json()) as { item: unknown }).item);
  };
  const finish = (id: string, body: unknown) => request(`/api/threads/${id}/finish`, "POST", body);
  const idle = async (id = "c") => {
    await vi.waitFor(() => expect(runner.runtime.store.get(id)?.runState).toBe("idle"));
  };
  const send = (id: string, text: string) =>
    runner.runtime.send(id, { text, images: [], origin: "developer" });
  const listThreads = async () =>
    threadsResponseSchema.parse(await (await request("/api/conversations/c/threads")).json())
      .threads;

  it.each(["競合なし", "一時ロック", "一時ロック中の終了時刻変更"] as const)(
    "応答期限後に受理済みの指示を復元する %s",
    async (situation) => {
      expect((await send("c", "idle 元の会話")).isOk()).toBe(true);
      await idle();
      database.sqlite.prepare("UPDATE conversations SET closed_at=1 WHERE id='c'").run();
      const instruction = await add();
      const question = await addQuestion("分岐する質問");
      const fork = agent.fork.bind(agent);
      let entered!: () => void;
      const hasEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let resume!: () => void;
      const resumeFork = new Promise<void>((resolve) => {
        resume = resolve;
      });
      agent.fork = async (...args) => {
        entered();
        await resumeFork;
        return fork(...args);
      };
      const reply = Promise.resolve(sendStock({ kinds: "all" }));
      await hasEntered;
      screenDatabase.sqlite.pragma("busy_timeout = 25");
      const locked = situation !== "競合なし";
      const closedAgainAt = situation === "一時ロック中の終了時刻変更" ? 57 : null;
      const worker = locked
        ? new Worker(
            `const { parentPort, workerData } = require("node:worker_threads");
      const Database = require(workerData.modulePath);
      const db = new Database(workerData.database);
      db.exec("BEGIN IMMEDIATE");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("stock-fixture-setting", "{}");
      if (workerData.closedAgainAt !== null)
        db.prepare("UPDATE conversations SET closed_at=? WHERE id='c'").run(workerData.closedAgainAt);
      parentPort.once("message", () => {
        db.exec("COMMIT");
        db.close();
      });
      parentPort.postMessage("locked");`,
            {
              eval: true,
              workerData: {
                modulePath: createRequire(import.meta.url).resolve("better-sqlite3"),
                database: database.sqlite.name,
                closedAgainAt,
              },
            },
          )
        : null;
      const workerExit = worker
        ? new Promise<number>((resolve) => {
            worker.once("exit", resolve);
          })
        : Promise.resolve(0);
      if (worker)
        await new Promise((resolve, reject) => {
          worker.once("message", resolve);
          worker.once("error", reject);
        });
      requestClock += 10_000;
      fireRequestDeadline();
      let response: Response;
      try {
        if (worker) {
          const early = await Promise.race([
            reply.then(({ status }) => status),
            new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 150)),
          ]);
          expect(early).toBe("waiting");
          worker.postMessage("unlock");
          expect(await workerExit).toBe(0);
        }
        response = await reply;
      } finally {
        if (worker) await worker.terminate();
        await workerExit.catch(() => {});
        resume();
      }
      await runner.runtime.serial("c", async () => ok(undefined));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        instructions: { count: 1, delivery: "delivered" },
        questions: [
          {
            stockId: question.id,
            ok: false,
            error: {
              code: "fork_failed",
              message:
                "スレッドを始められませんでした。AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
            },
          },
        ],
      });
      const item = stockResponseSchema.parse(
        await (await request("/api/conversations/c/stock")).json(),
      ).items;
      expect({
        closedAt: runner.runtime.store.get("c")?.closedAt,
        states: item.map(({ id, state }) => [id, state]),
        instructionRequests: agent.sent.length,
        threads: await listThreads(),
        busyTimeout: screenDatabase.sqlite.pragma("busy_timeout", { simple: true }),
      }).toEqual({
        closedAt: closedAgainAt,
        states: [
          [instruction.id, "sent"],
          [question.id, "stocked"],
        ],
        instructionRequests: 2,
        threads: [],
        busyTimeout: 25,
      });
    },
    12000,
  );

  it.each([
    { queued: false, failure: "sdkClose" },
    { queued: true, failure: "sdkClose" },
    { queued: true, failure: "reserveSave" },
    { queued: true, failure: "closeSave" },
    { queued: true, failure: "none" },
  ])(
    "終了予約が先行処理を待つ間に自然終了しても親へ通知する $queued $failure",
    async ({ queued, failure }) => {
      expect((await send("c", "idle 元の会話")).isOk()).toBe(true);
      await idle();
      const open = agent.open.bind(agent);
      let actualOutput: AsyncQueue<AgentOutput> | undefined;
      agent.open = (params) => {
        if (params.context.conversationId === "c") return open(params);
        const output = new AsyncQueue<AgentOutput>();
        output.push({ kind: "init", sessionId: params.sessionId, commands: [] });
        actualOutput = output;
        return {
          output,
          send: () => {},
          commands: async () => [],
          interrupt: async () => {
            output.push(turnEnd("error_during_execution"));
          },
          close: () => {
            if (agentFailure === "close") throw new Error("fixture release failure");
            output.close();
          },
        };
      };
      await addQuestion("分岐する質問");
      expect((await sendStock({ kinds: "questions" })).status).toBe(200);
      const [thread] = await listThreads();
      expect(thread).toMatchObject({ runState: "working", closedAt: null });
      const countParent = () =>
        (messages as Array<{ topic: string; type: string; payload?: { parts?: string[] } }>).filter(
          (message) =>
            message.topic === "conversation:c" &&
            message.type === "changed" &&
            message.payload?.parts?.includes("threads"),
        ).length;
      await vi.waitFor(() => expect(countParent()).toBeGreaterThanOrEqual(1));
      const before = countParent();
      if (failure === "sdkClose") agentFailure = "close";
      if (failure === "reserveSave")
        database.sqlite.exec(
          "CREATE TRIGGER r2_reserve_unavailable BEFORE INSERT ON settings WHEN NEW.key LIKE 'runner-release:%' BEGIN SELECT RAISE(FAIL, 'fixture'); END",
        );
      if (failure === "closeSave")
        database.sqlite.exec(
          "CREATE TRIGGER r2_close_unavailable BEFORE UPDATE OF closed_at ON conversations BEGIN SELECT RAISE(FAIL, 'fixture'); END",
        );
      let releasePrevious!: () => void;
      const waitPrevious = new Promise<void>((resolve) => {
        releasePrevious = resolve;
      });
      const preceding = runner.runtime.serial(thread!.id, async () => {
        await waitPrevious;
        return ok(undefined);
      });
      let close: Promise<Response> | undefined;
      try {
        if (queued) {
          close = Promise.resolve(finish(thread!.id, { action: "close" }));
          await vi.waitFor(() => expect(runner.runtime.releases.has(thread!.id)).toBe(true));
        }
        actualOutput!.push(turnEnd("success"));
        await idle(thread!.id);
        if (!queued) await vi.waitFor(() => expect(countParent()).toBe(before + 1));
      } finally {
        releasePrevious();
      }
      await preceding;
      const refused = await (close ?? finish(thread!.id, { action: "close" }));
      const [after] = await listThreads();
      agentFailure = undefined;
      await vi.waitFor(() => expect(countParent() - before).toEqual(1));
      const observed = {
        status: refused.status,
        state: after?.runState,
        closedAt: after?.closedAt,
        parentNotifications: countParent() - before,
      };
      expect(observed).toEqual({
        status: failure === "none" ? 200 : failure === "closeSave" ? 500 : 503,
        state: "idle",
        closedAt: failure === "none" ? 1234 : null,
        parentNotifications: 1,
      });
    },
  );

  it.each(["応答なし", "初期化直後に指示と質問", "ツール応答あり"])(
    "最初の番で質問する前に %s ならセッションだけで分岐しない",
    async (scenario) => {
      const hasHistory = scenario === "ツール応答あり";
      const mixed = scenario === "初期化直後に指示と質問";
      expect((await send("c", hasHistory ? "作業を開始" : "hold:最初の指示")).isOk()).toBe(true);
      await vi.waitFor(() =>
        expect(runner.runtime.store.get("c")?.sessionId).toEqual(expect.any(String)),
      );
      if (hasHistory)
        await vi.waitFor(() =>
          expect(runner.runtime.store.get("c")?.runState).toBe("waiting_permission"),
        );
      const previous = runner.runtime.store.events("c");
      expect(
        previous
          .filter(
            (e) =>
              e.type === "assistant_text" ||
              e.type === "tool_use" ||
              e.type === "permission_request",
          )
          .map((e) => e.type),
      ).toEqual(hasHistory ? ["permission_request"] : []);
      const question = await addQuestion("分岐する質問");
      const instruction = mixed ? await add() : undefined;
      const result = await sendStock({ kinds: mixed ? "all" : "questions" });
      expect(runner.runtime.store.queue("c").map(({ stockItemId }) => stockItemId)).toEqual(
        instruction ? [instruction.id] : [],
      );
      expect(result.status).toBe(200);
      const threads = await listThreads();
      const body = await result.json();
      const { items } = stockResponseSchema.parse(
        await (await request("/api/conversations/c/stock")).json(),
      );
      if (!hasHistory) {
        expect({ body, threads, state: items[0].state }).toEqual({
          body: {
            instructions: mixed ? { count: 1, delivery: "queued" } : { count: 0, delivery: null },
            questions: [
              {
                stockId: question.id,
                ok: false,
                error: {
                  code: "no_session",
                  message: "元の会話に AI の応答がまだ無いため、スレッドを始められません",
                },
              },
            ],
          },
          threads: [],
          state: "stocked",
        });
      } else {
        expect({ body, titles: threads.map((t) => t.title), state: items[0].state }).toEqual({
          body: {
            instructions: { count: 0, delivery: null },
            questions: [{ stockId: question.id, ok: true, threadId: threads[0].id }],
          },
          titles: ["分岐する質問"],
          state: "sent",
        });
      }
    },
  );

  it.each(["空の最初の案", "ツールだけの案", "失敗した案", "本文のある最初の案"])(
    "確定事項をもう一度求めるときに %s を区別する",
    async (scenario) => {
      const open = agent.open.bind(agent);
      let proposalCalls = 0;
      agent.open = (params) => {
        const session = open(params);
        return {
          ...session,
          send: (message) => {
            if (message.text.includes("このスレッドで確定した事項を")) {
              proposalCalls++;
              if (proposalCalls === 1 && scenario !== "本文のある最初の案") {
                const text =
                  scenario === "空の最初の案"
                    ? "idle:案の本文なし"
                    : scenario === "ツールだけの案"
                      ? "tool:本文なし"
                      : "error:案";
                session.send({ ...message, text });
                return;
              }
            }
            session.send(message);
          },
        };
      };
      expect((await send("c", "idle 元の会話")).isOk()).toBe(true);
      await idle();
      await addQuestion("idle 質問");
      expect((await sendStock({ kinds: "questions" })).status).toBe(200);
      const [thread] = await listThreads();
      const id = thread.id;
      await idle(id);
      expect((await finish(id, { action: "propose" })).status).toBe(202);
      await vi.waitFor(() =>
        expect(runner.runtime.store.get(id)?.runState).toBe(
          scenario === "失敗した案" ? "failed" : "idle",
        ),
      );
      const texts = () =>
        runner.runtime.store
          .events(id)
          .flatMap((e) => (e.type === "assistant_text" ? [e.payload.text] : []));
      const firstTexts =
        scenario === "失敗した案"
          ? ["失敗した案"]
          : scenario === "本文のある最初の案"
            ? ["案の文"]
            : [];
      expect(texts()).toEqual(firstTexts);
      expect((await finish(id, { action: "propose" })).status).toBe(202);
      await idle(id);
      expect({ proposalCalls, texts: texts() }).toEqual({
        proposalCalls: scenario === "本文のある最初の案" ? 1 : 2,
        texts: scenario === "失敗した案" ? ["失敗した案", "案の文"] : ["案の文"],
      });
    },
  );

  it.each(["success", "closeSave", "reserveSave", "sdkClose", "sdkInterrupt"] as const)(
    "作業中スレッドの停止と終了の結果を親へ配信する %s",
    async (path) => {
      expect((await send("c", "idle 元の会話")).isOk()).toBe(true);
      await idle();
      await addQuestion("作業を続ける質問");
      expect((await sendStock({ kinds: "questions" })).status).toBe(200);
      const [active] = await listThreads();
      expect(active!.runState).toBe("working");
      const changed = () =>
        messages.filter((value) => {
          const message = value as { type: string; topic: string; payload: { parts: string[] } };
          return (
            message.topic === "conversation:c" &&
            message.type === "changed" &&
            message.payload.parts.some((part) => part === "stock" || part === "threads")
          );
        });
      await vi.waitFor(() => expect(changed()).toHaveLength(2));
      const before = changed().length;
      if (path === "closeSave")
        database.sqlite.exec(
          "CREATE TRIGGER p1_fail_active_close BEFORE UPDATE OF closed_at ON conversations BEGIN SELECT RAISE(FAIL, 'fixture'); END",
        );
      if (path === "reserveSave")
        database.sqlite.exec(
          "CREATE TRIGGER p1_fail_reserve BEFORE INSERT ON settings WHEN NEW.key LIKE 'runner-release:%' BEGIN SELECT RAISE(FAIL, 'fixture'); END",
        );
      if (path === "sdkClose") agentFailure = "close";
      if (path === "sdkInterrupt") agentFailure = "interrupt";
      const response = await finish(active!.id, { action: "close" });
      const [stopped] = await listThreads();
      expect(response.status).toBe(path === "success" ? 200 : path === "closeSave" ? 500 : 503);
      expect(stopped).toMatchObject({
        runState: path === "sdkInterrupt" ? "working" : "stopped",
        closedAt: path === "success" ? 1234 : null,
      });
      if (path === "sdkInterrupt") {
        expect(changed()).toHaveLength(before);
      } else {
        await vi.waitFor(() =>
          expect(changed().slice(before)).toEqual([
            {
              topic: "conversation:c",
              seq: runner.runtime.store.get("c")!.lastSeq,
              type: "changed",
              payload: { parts: ["stock", "threads"] },
            },
          ]),
        );
      }
    },
  );

  it.each([
    { kinds: "all", slowAt: 1, active: false },
    { kinds: "all", slowAt: 1, active: false, closedAgainAt: 2 },
    { kinds: "all", slowAt: 1, active: true },
    { kinds: "questions", slowAt: 2, active: false },
    { kinds: "questions", slowAt: 1, active: false },
    { kinds: "all", slowAt: 0, active: false },
  ] as const)(
    "応答期限までに受理した結果と遅れた分岐 $kinds $slowAt $active $closedAgainAt",
    async ({ kinds, slowAt, active, ...condition }) => {
      expect((await send("c", "idle 元の会話")).isOk()).toBe(true);
      await idle();
      if (active) {
        expect((await send("c", "先に動く作業")).isOk()).toBe(true);
        await vi.waitFor(() => expect(runner.runtime.store.get("c")?.runState).toBe("working"));
      } else {
        database.sqlite.prepare("UPDATE conversations SET closed_at=1 WHERE id='c'").run();
      }
      const closedAgainAt = "closedAgainAt" in condition ? condition.closedAgainAt : null;
      if (active)
        await vi.waitFor(() =>
          expect(runner.runtime.store.events("c").at(-1)?.type).toBe("assistant_text"),
        );
      const before = runner.runtime.store.get("c")!.lastSeq;
      const item = kinds === "all" ? await add() : undefined;
      const questions = [await addQuestion("第一の質問"), await addQuestion("第二の質問")];
      if (slowAt === 0) {
        vi.spyOn(runner.runtime.options, "id")
          .mockReturnValueOnce("01J0000000ZZZZZZZZZZZZZZZZ")
          .mockReturnValueOnce("01J00000000000000000000000");
      }
      const fork = agent.fork.bind(agent);
      let seenSlow = () => {};
      const entered = new Promise<void>((resolve) => {
        seenSlow = resolve;
      });
      let free = () => {};
      const held = new Promise<void>((resolve) => {
        free = resolve;
      });
      let count = 0;
      agent.fork = async (id, options) => {
        if (++count === slowAt) {
          seenSlow();
          await held;
        }
        return fork(id, options);
      };
      const result = sendStock({ kinds });
      if (slowAt) {
        await entered;
        if (closedAgainAt !== null)
          screenDatabase.sqlite
            .prepare("UPDATE conversations SET closed_at=? WHERE id='c'")
            .run(closedAgainAt);
        requestClock += 10_000;
        fireRequestDeadline();
      }
      let status: number;
      let body: unknown;
      try {
        const response = await result;
        status = response.status;
        body = await response.json();
      } finally {
        free();
      }
      await runner.runtime.serial("c", async () => ok(undefined));
      const expectedLastSeq = before + (item && !active ? 2 : 0);
      await vi.waitFor(() => expect(runner.runtime.store.get("c")?.lastSeq).toBe(expectedLastSeq));
      const last = runner.runtime.store.get("c")!;
      const stock = stockResponseSchema.parse(
        await (await request("/api/conversations/c/stock")).json(),
      );
      const states = stock.items.map(({ id, state, sentSeq }) => ({ id, state, sentSeq }));
      const threads = await listThreads();
      const queued = runner.runtime.store.queue("c").map(({ stockItemId }) => stockItemId);
      const acceptedQuestions = slowAt === 0 ? questions.length : slowAt - 1;
      const accepted = questions.slice(0, acceptedQuestions).map(({ id: stockId }) => {
        const threadId = stock.items.find((item) => item.id === stockId)?.thread?.id;
        if (!threadId) throw new Error(`ストック ${stockId} のスレッドがありません`);
        return { stockId, ok: true, threadId };
      });
      const listed = accepted
        .map(({ stockId, threadId }) => ({ id: threadId, stockId }))
        .sort((a, b) => a.id.localeCompare(b.id));
      if (slowAt === 1 && !item) {
        expect({ status, body }).toEqual({
          status: 503,
          body: {
            error: {
              code: "runner_unavailable",
              message:
                "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
            },
          },
        });
      } else {
        expect({ status, body }).toEqual({
          status: 200,
          body: {
            instructions: {
              count: item ? 1 : 0,
              delivery: item ? (active ? "queued" : "delivered") : null,
            },
            questions: questions.map(
              ({ id }, index) =>
                accepted[index] ?? {
                  stockId: id,
                  ok: false,
                  error: {
                    code: "fork_failed",
                    message:
                      "スレッドを始められませんでした。AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
                  },
                },
            ),
          },
        });
      }
      expect(last.closedAt).toBe(closedAgainAt ?? (active || item ? null : 1));
      expect({
        states,
        threads: threads.map(({ id, stockId }) => ({ id, stockId })),
        queued,
        lastSeq: last.lastSeq,
      }).toEqual({
        states: [
          ...(item ? [{ id: item.id, state: "sent", sentSeq: active ? null : before + 1 }] : []),
          ...questions.map(({ id }, index) => ({
            id,
            state: index < acceptedQuestions ? "sent" : "stocked",
            sentSeq: null,
          })),
        ],
        threads: listed,
        queued: active && item ? [item.id] : [],
        lastSeq: expectedLastSeq,
      });
    },
  );

  it.each([
    { action: "stock", fail: true },
    { action: "close", fail: true },
    { action: "stock", fail: false },
  ] as const)("独立対照 終了のrelease結果 $action $fail", async ({ action, fail }) => {
    thread();
    database.sqlite
      .prepare(
        "INSERT INTO drafts (conversation_id,text,updated_at,updated_by) VALUES ('t','案を編集',1,'tab')",
      )
      .run();
    expect((await send("t", "idle 普通の応答")).isOk()).toBe(true);
    await idle("t");
    const before = stockResponseSchema.parse(
      await (await request("/api/conversations/c/stock")).json(),
    );
    agentFailure = fail ? "close" : undefined;
    const response = await finish(
      "t",
      action === "stock" ? { action, text: "案を編集" } : { action },
    );
    const body = await response.json();
    const snapshot = {
      closed: runner.runtime.store.get("t")?.closedAt,
      draft: database.sqlite.prepare("SELECT text FROM drafts WHERE conversation_id='t'").get(),
      reserved: runner.runtime.releases.has("t"),
      items: stockResponseSchema.parse(await (await request("/api/conversations/c/stock")).json())
        .items,
    };

    if (fail) {
      expect(snapshot).toEqual({
        closed: null,
        draft: { text: "案を編集" },
        reserved: false,
        items: before.items,
      });
      expect({ status: response.status, body }).toMatchObject({
        status: 503,
        body: { error: { code: "runner_unavailable" } },
      });
    } else {
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ thread: { id: "t", closedAt: 1234 } });
      expect(snapshot).toMatchObject({
        closed: 1234,
        reserved: false,
        items: [
          ...before.items.map((item) => ({ ...item, thread: { ...item.thread, closed: true } })),
          { conversationId: "c", kind: "instruction", text: "案を編集", state: "stocked" },
        ],
      });
      expect(snapshot.draft).toBe(undefined);
    }
  });

  it.each(["insert", "delete"] as const)(
    "スレッドの確定事項保存の %s が失敗すると終了・指示・下書きを保つ",
    async (failure) => {
      thread();
      database.sqlite
        .prepare(
          "INSERT INTO drafts (conversation_id,text,updated_at,updated_by) VALUES ('t','保存する案',1,'tab')",
        )
        .run();
      const before = await (await request("/api/conversations/c/stock")).json();
      const target = failure === "insert" ? "INSERT ON stock_items" : "DELETE ON drafts";
      database.sqlite.exec(
        `CREATE TRIGGER fail_finish_stock BEFORE ${target} BEGIN SELECT RAISE(FAIL, 'fixture'); END`,
      );
      const refused = await finish("t", { action: "stock", text: "編集した案" });
      expect(refused.status).toBe(500);
      expect(await refused.json()).toEqual({
        error: {
          code: "internal",
          message: "質問・指示を読み書きできませんでした。もう一度操作してください",
        },
      });
      expect(runner.runtime.store.get("t")?.closedAt).toBe(null);
      expect(await (await request("/api/conversations/c/stock")).json()).toEqual(before);
      expect(
        database.sqlite.prepare("SELECT text FROM drafts WHERE conversation_id='t'").get(),
      ).toEqual({ text: "保存する案" });
      database.sqlite.exec("DROP TRIGGER fail_finish_stock");
      const retry = await finish("t", { action: "stock", text: "編集した案" });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({
        item: baseItem("s002", {
          text: "編集した案",
          thread: { id: "t", title: "質問", runState: "idle", closed: true },
        }),
        thread: { id: "t", closedAt: 1234 },
      });
    },
  );

  it("別端末で保存した指示を読み、ID指定で送り、その次は残りを順番に一括送信できる", async () => {
    await add();
    await add();
    await add();
    const list = await request("/api/conversations/c/stock", "GET", undefined, 50001);
    expect(await list.json()).toEqual({
      items: [baseItem("s001"), baseItem("s002"), baseItem("s003")],
    });
    database.sqlite.prepare("UPDATE conversations SET closed_at=1 WHERE id='c'").run();
    const selected = await sendStock(
      {
        kinds: "instructions",
        stockIds: ["not-listed", "s002", "s002"],
      },
      "c",
      50001,
    );
    expect(selected.status).toBe(200);
    expect(await selected.json()).toEqual({
      instructions: { count: 1, delivery: "delivered" },
      questions: [],
    });
    expect(runner.runtime.store.get("c")?.closedAt).toBe(null);
    expect(
      database.sqlite.prepare("SELECT id,state,sent_seq FROM stock_items ORDER BY id").all(),
    ).toEqual([
      { id: "s001", state: "stocked", sent_seq: null },
      { id: "s002", state: "sent", sent_seq: 1 },
      { id: "s003", state: "stocked", sent_seq: null },
    ]);
    expect(agent.sent.map(({ text }) => text)).toEqual([
      "ストックした指示が 1 件あります。順に対応してください。\n\n1. ターミナルの出力から\n> 保存した引用\n指示",
    ]);
    expect((await runner.runtime.stop("c")).isOk()).toBe(true);
    const all = await sendStock({ kinds: "instructions" });
    expect(all.status).toBe(200);
    expect(await all.json()).toEqual({
      instructions: { count: 2, delivery: "delivered" },
      questions: [],
    });
    expect(agent.sent.map(({ text }) => text)).toEqual([
      "ストックした指示が 1 件あります。順に対応してください。\n\n1. ターミナルの出力から\n> 保存した引用\n指示",
      "ストックした指示が 2 件あります。順に対応してください。\n\n1. ターミナルの出力から\n> 保存した引用\n指示\n\n2. ターミナルの出力から\n> 保存した引用\n指示",
    ]);
  });

  it("元の会話に応答がない質問を残して、同じ送信の指示は届ける", async () => {
    await addQuestion("元の会話の応答が必要");
    await add();
    const response = await sendStock({ kinds: "all" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      instructions: { count: 1, delivery: "delivered" },
      questions: [
        {
          stockId: "s001",
          ok: false,
          error: {
            code: "no_session",
            message: "元の会話に AI の応答がまだ無いため、スレッドを始められません",
          },
        },
      ],
    });
    expect(await (await request("/api/conversations/c/stock")).json()).toEqual({
      items: [
        baseItem("s001", { kind: "question", text: "元の会話の応答が必要" }),
        baseItem("s002", { state: "sent", sentAt: expect.any(Number), sentSeq: 1 }),
      ],
    });
  });

  it("質問だけなら元の会話を開き直さず、分岐への返信でも親の記録は維持する", async () => {
    expect((await send("c", "idle 元の会話")).isOk()).toBe(true);
    await idle();
    database.sqlite.prepare("UPDATE conversations SET closed_at=1 WHERE id='c'").run();
    const parent = runner.runtime.store.get("c")!;
    const history = runner.runtime.store.events("c");
    const fork = agent.fork.bind(agent);
    const sources: { id: string; dir: string }[] = [];
    agent.fork = (id, { dir }) => {
      sources.push({ id, dir });
      return fork(id, { dir });
    };
    await addQuestion("第1の質問");
    await addQuestion("第2の質問");
    await add();
    const response = await sendStock({ kinds: "questions" });
    expect(response.status).toBe(200);
    const listed = await listThreads();
    const first = listed.find(({ stockId }) => stockId === "s001");
    const second = listed.find(({ stockId }) => stockId === "s002");
    if (!first || !second) throw new Error("質問に対応するスレッドがありません");
    expect(listed.map(({ id }) => id)).toEqual([first.id, second.id].sort());
    expect(await response.json()).toEqual({
      instructions: { count: 0, delivery: null },
      questions: [
        { stockId: "s001", ok: true, threadId: first.id },
        { stockId: "s002", ok: true, threadId: second.id },
      ],
    });
    expect(
      [first, second].map((t) => ({ title: t?.title, stockId: t?.stockId, quote: t?.quote })),
    ).toEqual([
      { title: "第1の質問", stockId: "s001", quote: terminal },
      { title: "第2の質問", stockId: "s002", quote: terminal },
    ]);
    expect(await (await request("/api/conversations/c/stock")).json()).toEqual({
      items: [
        ...[first, second].map(({ id, title, stockId }) =>
          baseItem(stockId, {
            kind: "question",
            text: title!,
            state: "sent",
            sentAt: expect.any(Number),
            thread: { id, title, runState: "working", closed: false },
          }),
        ),
        baseItem("s003"),
      ],
    });
    expect(sources).toEqual([
      { id: parent.sessionId, dir: cwd },
      { id: parent.sessionId, dir: cwd },
    ]);
    const threads = [first, second].map((t) => runner.runtime.store.get(t.id)!);
    expect(
      threads.map(({ cwd, issueId, projectId, parentConversationId }) => ({
        cwd,
        issueId,
        projectId,
        parentConversationId,
      })),
    ).toEqual([
      { cwd, issueId: null, projectId: "p", parentConversationId: "c" },
      { cwd, issueId: null, projectId: "p", parentConversationId: "c" },
    ]);
    expect(new Set([parent.sessionId, ...threads.map(({ sessionId }) => sessionId)]).size).toBe(3);
    const id = first.id;
    expect(runner.runtime.store.get("c")).toEqual(parent);
    const changed = () =>
      messages.filter((message) => {
        const update = message as { type: string; topic: string };
        return update.type === "changed" && update.topic === "conversation:c";
      });
    const threadChanged = {
      topic: "conversation:c",
      type: "changed",
      seq: parent.lastSeq,
      payload: { parts: ["stock", "threads"] },
    };
    await vi.waitFor(() => expect(changed().slice(-2)).toEqual([threadChanged, threadChanged]));
    const beforeStop = changed().length;
    const threadRequest = (action: string, body?: unknown) =>
      conversationApp.request(
        `/api/conversations/${id}/${action}`,
        {
          method: "POST",
          ...(body === undefined
            ? {}
            : {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
        },
        incomingWith("127.0.0.1", 50001),
      );
    const stopped = await threadRequest("stop");
    expect(stopped.status).toBe(202);
    expect(await stopped.json()).toEqual({ runState: "stopped" });
    await vi.waitFor(() => expect(changed().slice(beforeStop).at(-1)).toEqual(threadChanged));
    for (const [index, text] of ["idle スレッドの返事1", "idle スレッドの返事2"].entries()) {
      const reply = await threadRequest("messages", {
        text,
        images: [],
        mode: "send",
        clientMessageId: `reply-${index}`,
      });
      expect(reply.status).toBe(202);
      expect(await reply.json()).toEqual({ result: "delivered", queueItem: null });
      await idle(id);
    }
    expect(
      agent.sent
        .filter(({ sessionId }) => sessionId === threads[0]!.sessionId)
        .map(({ text }) => text),
    ).toEqual([
      "次の箇所について質問です。\n\nターミナルの出力から\n> 保存した引用\n第1の質問",
      "idle スレッドの返事1",
      "idle スレッドの返事2",
    ]);
    expect(runner.runtime.store.events("c")).toEqual(history);
    expect(runner.runtime.store.get("c")).toEqual({ ...parent, closedAt: null });
  });

  it("分岐できない質問を残し、次の質問を別のスレッドで届ける", async () => {
    expect((await send("c", "idle 元の会話")).isOk()).toBe(true);
    await idle();
    const fork = agent.fork.bind(agent);
    let calls = 0;
    runner.runtime.options.agent.fork = (id, options) =>
      ++calls === 1
        ? Promise.resolve(err({ message: "分岐の記録がありません" }))
        : fork(id, options);
    await addQuestion("分岐できない質問");
    await addQuestion("分岐できる質問");
    const response = await sendStock({ kinds: "questions" });
    expect(response.status).toBe(200);
    const [thread] = await listThreads();
    expect(await response.json()).toEqual({
      instructions: { count: 0, delivery: null },
      questions: [
        {
          stockId: "s001",
          ok: false,
          error: {
            code: "fork_failed",
            message: "スレッドを始められませんでした。分岐の記録がありません",
          },
        },
        { stockId: "s002", ok: true, threadId: thread!.id },
      ],
    });
    expect(await (await request("/api/conversations/c/stock")).json()).toEqual({
      items: [
        baseItem("s001", { kind: "question", text: "分岐できない質問" }),
        baseItem("s002", {
          kind: "question",
          text: "分岐できる質問",
          state: "sent",
          sentAt: expect.any(Number),
          thread: {
            id: thread!.id,
            title: "分岐できる質問",
            runState: "working",
            closed: false,
          },
        }),
      ],
    });
  });

  it("作業中は指示が個別に届く前の列へ入り、編集と取消の後に残った件だけが自動で届く", async () => {
    expect((await send("c", "作業を開始")).isOk()).toBe(true);
    await vi.waitFor(() =>
      expect(runner.runtime.store.get("c")?.runState).toBe("waiting_permission"),
    );
    const pending = runner.runtime.store
      .events("c")
      .findLast((event) => event.type === "permission_request");
    if (pending?.type !== "permission_request") throw new Error("許可の依頼がありません");
    await add();
    await add();
    const response = await sendStock({ kinds: "instructions" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      instructions: { count: 2, delivery: "queued" },
      questions: [],
    });
    const queued = runner.runtime.store.queue("c");
    expect(
      queued.map(({ text, stockItemId, position }) => ({ text, stockItemId, position })),
    ).toEqual([
      { text: "ターミナルの出力から\n> 保存した引用\n指示", stockItemId: "s001", position: 1 },
      { text: "ターミナルの出力から\n> 保存した引用\n指示", stockItemId: "s002", position: 2 },
    ]);
    const state = () =>
      database.sqlite.prepare("SELECT id,state,sent_seq,text FROM stock_items ORDER BY id").all();
    expect(state()).toEqual([
      { id: "s001", state: "sent", sent_seq: null, text: "指示" },
      { id: "s002", state: "sent", sent_seq: null, text: "指示" },
    ]);
    const [first, second] = queued;
    expect((await request(`/api/conversations/c/queue/${first!.id}`, "DELETE")).status).toBe(204);
    const edited = await request(`/api/conversations/c/queue/${second!.id}`, "PATCH", {
      text: "編集した届く前の指示",
      images: [],
    });
    expect(edited.status).toBe(200);
    const allowed = await request(
      `/api/conversations/c/permissions/${pending.payload.request_id}`,
      "POST",
      { decision: "allow" },
    );
    expect(allowed.status).toBe(202);
    await vi.waitFor(() =>
      expect(agent.sent.map(({ text }) => text)).toEqual(["作業を開始", "編集した届く前の指示"]),
    );
    const delivered = runner.runtime.store
      .events("c")
      .findLast((event) => event.type === "user_message");
    if (delivered?.type !== "user_message") throw new Error("配達が記録されていません");
    expect(delivered.payload).toEqual({
      text: "編集した届く前の指示",
      images: [],
      origin: "queued",
      queued_ids: [second!.id],
      client_ids: [],
      client_receipts: [],
    });
    expect(state()).toEqual([
      { id: "s001", state: "stocked", sent_seq: null, text: "指示" },
      { id: "s002", state: "sent", sent_seq: delivered.seq, text: "指示" },
    ]);
  });

  it("元の会話が許可を待っている途中でも注記付きでスレッドを始め、親の待機は維持する", async () => {
    expect((await send("c", "作業を開始")).isOk()).toBe(true);
    await vi.waitFor(() =>
      expect(runner.runtime.store.get("c")?.runState).toBe("waiting_permission"),
    );
    const question = await addQuestion("途中の質問");
    const response = await sendStock({ kinds: "questions" });
    expect(response.status).toBe(200);
    const [thread] = await listThreads();
    expect(await response.json()).toEqual({
      instructions: { count: 0, delivery: null },
      questions: [{ stockId: question.id, ok: true, threadId: thread!.id }],
    });
    expect(agent.sent.map(({ text }) => text)).toEqual([
      "作業を開始",
      "(元の会話の AI は、このスレッドを始めた時点で作業を続けています。記録で中断と出ているツールの呼び出しは、元の会話で動いています。やり直さないでください。ファイルは元の会話と共有しています。)\n\n次の箇所について質問です。\n\nターミナルの出力から\n> 保存した引用\n途中の質問",
    ]);
    expect(runner.runtime.store.get("c")?.runState).toBe("waiting_permission");
    for (const input of [{ action: "propose" }, { action: "stock", text: "確定事項" }]) {
      const active = await finish(thread!.id, input);
      expect(active.status).toBe(409);
      expect(await active.json()).toEqual({
        error: {
          code: "conflict",
          message: "スレッドの AI が作業中です。止めるか、終わってから選んでください",
        },
      });
    }
    expect(runner.runtime.store.get(thread!.id)?.runState).toBe("working");
  });

  it("ファイルの現在の行と異なる引用には、元の会話へ送る本文に説明を付ける", async () => {
    const quote = {
      kind: "file",
      mode: "line",
      text: "前の内容",
      path: "quote.txt",
      start: { line: 1, col: 0 },
      end: { line: 1, col: 4 },
    } satisfies Quote;
    writeFileSync(join(cwd, "quote.txt"), "前の内容");
    const added = await add(quote);
    writeFileSync(join(cwd, "quote.txt"), "今の内容");
    const selected = await sendStock({ kinds: "instructions", stockIds: [added.id] });
    expect(selected.status).toBe(200);
    expect(await selected.json()).toEqual({
      instructions: { count: 1, delivery: "delivered" },
      questions: [],
    });
    expect(agent.sent.map(({ text }) => text)).toEqual([
      "ストックした指示が 1 件あります。順に対応してください。\n\n1. quote.txt 1 行目 (引用した時点の内容。いまのファイルとは違います)\n> 前の内容\n指示",
    ]);
  });

  it("ランナーに接続できないときはストックの状態を保つ", async () => {
    const item = await add();
    link.stop();
    await runner.shutdown();
    const response = await sendStock({ kinds: "instructions" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "runner_unavailable",
        message: "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
      },
    });
    expect(await (await request("/api/conversations/c/stock")).json()).toEqual({ items: [item] });
  });

  it("フォーク中に先に取り消した件は作成せず、別の質問を待たせずに始める", async () => {
    expect((await send("c", "idle 元の会話")).isOk()).toBe(true);
    await idle();
    const fork = agent.fork.bind(agent);
    let markEntered = () => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let unblock = () => {};
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let first = true;
    agent.fork = async (id, options) => {
      if (first) {
        first = false;
        markEntered();
        await blocked;
      }
      return fork(id, options);
    };
    const cancelled = await addQuestion("取り消す質問");
    const remains = await addQuestion("送る質問");
    const sending = sendStock({ kinds: "questions" });
    await entered;
    try {
      expect((await request(`/api/stock/${cancelled.id}`, "DELETE")).status).toBe(200);
    } finally {
      unblock();
    }
    const result = await sending;
    const [thread] = await listThreads();
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      instructions: { count: 0, delivery: null },
      questions: [
        {
          stockId: cancelled.id,
          ok: false,
          error: {
            code: "fork_failed",
            message:
              "スレッドを始められませんでした。質問・指示の状態が変わりました。一覧を読み直してから、もう一度操作してください。",
          },
        },
        { stockId: remains.id, ok: true, threadId: thread!.id },
      ],
    });
    expect(
      database.sqlite
        .prepare("SELECT id, state, thread_conversation_id FROM stock_items ORDER BY id")
        .all(),
    ).toEqual([
      { id: cancelled.id, state: "cancelled", thread_conversation_id: null },
      { id: remains.id, state: "sent", thread_conversation_id: thread!.id },
    ]);
  });

  it("分岐後に最初のAI実行を開けなかった質問は、スレッドを残さず送り直せる", async () => {
    expect((await send("c", "idle 元の会話")).isOk()).toBe(true);
    await idle();
    const open = agent.open.bind(agent);
    agent.open = (params) => {
      if (params.context.conversationId !== "c") throw new Error("分岐した実行を開けません");
      return open(params);
    };
    const question = await addQuestion("送り直す質問");
    const refused = await sendStock({ kinds: "questions" });
    expect(refused.status).toBe(200);
    expect(await refused.json()).toEqual({
      instructions: { count: 0, delivery: null },
      questions: [
        {
          stockId: question.id,
          ok: false,
          error: {
            code: "fork_failed",
            message: "スレッドを始められませんでした。分岐した実行を開けません",
          },
        },
      ],
    });
    expect(await listThreads()).toEqual([]);
    expect(await (await request("/api/conversations/c/stock")).json()).toEqual({
      items: [question],
    });
    agent.open = open;
    const retried = await sendStock({ kinds: "questions" });
    expect(retried.status).toBe(200);
    const [thread] = await listThreads();
    expect(await retried.json()).toEqual({
      instructions: { count: 0, delivery: null },
      questions: [{ stockId: question.id, ok: true, threadId: thread!.id }],
    });
  });

  it("確定事項の案をAIに一度求め、編集した文を同じ引用のストックに入れてスレッドを終える", async () => {
    expect((await send("c", "idle 元の会話")).isOk()).toBe(true);
    await idle();
    const question = await addQuestion("idle 第1の質問");
    expect((await sendStock({ kinds: "questions" })).status).toBe(200);
    const [thread] = await listThreads();
    const id = thread!.id;
    await idle(id);
    const proposal = await finish(id, { action: "propose" });
    expect(proposal.status).toBe(202);
    expect(await proposal.json()).toEqual({ runState: "working" });
    await idle(id);
    const again = await finish(id, { action: "propose" });
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ runState: "working" });
    const recorded = runner.runtime.store
      .events(id)
      .find((event) => event.type === "user_message" && event.payload.origin === "finish_proposal");
    expect(recorded).toBeDefined();
    expect(proposal.headers.get("X-Sukuna-Proposal-Seq")).toBe(String(recorded!.seq));
    expect(again.headers.get("X-Sukuna-Proposal-Seq")).toBe(String(recorded!.seq));
    const history = runner.runtime.store.events(id);
    expect(
      history.flatMap((entry) =>
        entry.type === "user_message" && entry.payload.origin === "finish_proposal"
          ? [entry.payload.text]
          : [],
      ),
    ).toEqual([
      "このスレッドで確定した事項を、元の会話の AI への指示として書いてください。出力は指示の文だけにしてください。確定した事項が無ければ『なし』とだけ書いてください。",
    ]);
    expect(
      history.flatMap((entry) => (entry.type === "assistant_text" ? [entry.payload.text] : [])),
    ).toEqual(["案の文"]);
    database.sqlite
      .prepare(
        "INSERT INTO drafts (conversation_id,text,updated_at,updated_by) VALUES (?,?,1,'fixture')",
      )
      .run(id, "編集した確定事項");
    const stocked = await finish(id, { action: "stock", text: "編集した確定事項" });
    expect(stocked.status).toBe(200);
    expect(await stocked.json()).toEqual({
      item: baseItem("s002", {
        text: "編集した確定事項",
        thread: { id, title: "idle 第1の質問", runState: "idle", closed: true },
      }),
      thread: { id, closedAt: 1234 },
    });
    expect(database.sqlite.prepare("SELECT text FROM drafts WHERE conversation_id=?").get(id)).toBe(
      undefined,
    );
    expect(
      database.sqlite
        .prepare("SELECT state,thread_conversation_id FROM stock_items WHERE id=?")
        .get(question.id),
    ).toEqual({ state: "sent", thread_conversation_id: id });
    expect(runner.runtime.store.get(id)?.closedAt).toBe(1234);
  });

  it("（US-020）追加した引用つきの件を一覧で見直し、編集・取消・復元でき、会話を閉じても残る", async () => {
    expect(await add()).toEqual(baseItem("s001"));
    const question = await request("/api/conversations/c/stock", "POST", {
      kind: "question",
      text: "質問",
      quote: terminal,
    });
    expect(question.status).toBe(201);
    const listed = await request("/api/conversations/c/stock");
    expect(stockResponseSchema.parse(await listed.json())).toEqual({
      items: [baseItem("s001"), baseItem("s002", { kind: "question", text: "質問" })],
    });
    const edited = await request("/api/stock/s001", "PATCH", { text: "修正した指示" });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toEqual({ item: baseItem("s001", { text: "修正した指示" }) });
    const cancelled = await request("/api/stock/s001", "DELETE");
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({
      item: baseItem("s001", { text: "修正した指示", state: "cancelled" }),
    });
    expect(await (await request("/api/conversations/c/stock")).json()).toEqual({
      items: [baseItem("s002", { kind: "question", text: "質問" })],
    });
    const restored = await request("/api/stock/s001", "PATCH", { state: "stocked" });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ item: baseItem("s001", { text: "修正した指示" }) });
    database.sqlite.prepare("UPDATE conversations SET closed_at=1 WHERE id='c'").run();
    expect(await (await request("/api/conversations/c/stock")).json()).toEqual({
      items: [
        baseItem("s001", { text: "修正した指示" }),
        baseItem("s002", { kind: "question", text: "質問" }),
      ],
    });
    expect(
      messages.filter(
        (m) =>
          (m as { type: string; topic: string }).type === "changed" &&
          (m as { topic: string }).topic === "conversation:c",
      ),
    ).toEqual(
      Array.from({ length: 5 }, () => ({
        topic: "conversation:c",
        seq: 0,
        type: "changed",
        payload: { parts: ["stock"] },
      })),
    );
  });

  it.each(["PATCH", "DELETE"])("送った件への %s は409で保存内容を変えない", async (method) => {
    await add();
    database.sqlite
      .prepare(
        "UPDATE stock_items SET state='sent',sent_at=42,sent_seq=7,github_comment_url='https://example.com/comment' WHERE id='s001'",
      )
      .run();
    const response = await request(
      "/api/stock/s001",
      method,
      method === "PATCH" ? { text: "書き換え" } : undefined,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "conflict",
        message: "この質問・指示の状態が変わっています。一覧を読み直して、もう一度操作してください",
      },
    });
    expect(await (await request("/api/conversations/c/stock")).json()).toEqual({
      items: [
        baseItem("s001", {
          state: "sent",
          sentAt: 42,
          sentSeq: 7,
          githubCommentUrl: "https://example.com/comment",
        }),
      ],
    });
  });

  it.each(["changed", "missing", "large", "binary", "symlink"])(
    "（US-023）引用後のファイルが %s のとき古い扱いにして保存した文を返す",
    async (change) => {
      writeFileSync(join(cwd, "a.txt"), "元の文\n次の文\n");
      const quote = {
        kind: "file",
        mode: "line",
        path: "a.txt",
        text: "元の文",
        start: { line: 1, col: 0 },
        end: { line: 1, col: 3 },
      } satisfies Quote;
      expect(await add(quote)).toEqual(baseItem("s001", { quote }));
      if (change === "changed") writeFileSync(join(cwd, "a.txt"), "変えた文\n次の文\n");
      if (change === "missing") rmSync(join(cwd, "a.txt"));
      if (change === "large") writeFileSync(join(cwd, "a.txt"), "a".repeat(1_048_577));
      if (change === "binary") writeFileSync(join(cwd, "a.txt"), Buffer.from([0xc3, 0x28]));
      if (change === "symlink") {
        rmSync(join(cwd, "a.txt"));
        writeFileSync(join(home, "outside.txt"), "元の文");
        symlinkSync(join(home, "outside.txt"), join(cwd, "a.txt"));
      }
      expect(await (await request("/api/conversations/c/stock")).json()).toEqual({
        items: [baseItem("s001", { quote, stale: true })],
      });
      rmSync(join(cwd, "a.txt"), { force: true });
      writeFileSync(join(cwd, "a.txt"), "元の文\n次の文\n");
      expect(await (await request("/api/conversations/c/stock")).json()).toEqual({
        items: [baseItem("s001", { quote })],
      });
    },
  );

  it.each([
    { state: "stocked", method: "PATCH", body: { state: "stocked" } },
    { state: "cancelled", method: "PATCH", body: { text: "編集" } },
    { state: "cancelled", method: "DELETE", body: undefined },
    { state: "sent", method: "PATCH", body: { state: "stocked" } },
  ])("$state に合わない $method の操作は409になる", async ({ state, method, body }) => {
    await add();
    database.sqlite.prepare("UPDATE stock_items SET state=? WHERE id='s001'").run(state);
    const response = await request("/api/stock/s001", method, body);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "conflict",
        message: "この質問・指示の状態が変わっています。一覧を読み直して、もう一度操作してください",
      },
    });
  });
  it.each([
    { path: "/api/stock/s001", method: "PATCH", body: { text: "", state: "stocked" } },
    { path: "/api/stock/s001", method: "PATCH", body: { text: "編集", state: "stocked" } },
    { path: "/api/threads/t/finish", method: "POST", body: { action: "unknown" } },
  ])("$path の不正な操作を400で断る", async ({ path, method, body }) => {
    const response = await request(path, method, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_input", message: "質問・指示と引用の入力を確認してください" },
    });
  });
  it.each([
    { path: "/api/conversations/c/stock", method: "POST" },
    { path: "/api/stock/s001", method: "PATCH" },
    { path: "/api/threads/t/finish", method: "POST" },
  ])("$path の壊れたJSONを400で断る", async ({ path, method }) => {
    const response = await app.request(
      path,
      { method, headers: { "content-type": "application/json" }, body: "{" },
      incomingWith("127.0.0.1", 50000),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_input", message: "質問・指示と引用の入力を確認してください" },
    });
  });
  function thread(id = "t", closedAt: number | null = null) {
    database.sqlite
      .prepare(
        "INSERT INTO conversations (id,project_id,kind,cwd,title,parent_conversation_id,closed_at,last_activity_at) VALUES (?,'p','thread',?,'質問','c',?,99)",
      )
      .run(id, cwd, closedAt);
    database.sqlite
      .prepare(
        "INSERT INTO stock_items (id,conversation_id,kind,text,quote,state,thread_conversation_id,sent_at) VALUES (?,'c','question','質問',?,'sent',?,12)",
      )
      .run(`q-${id}`, JSON.stringify(terminal), id);
  }
  it.each([
    { parentState: "開いていた元の会話", parentClosedAt: null },
    { parentState: "閉じていた元の会話", parentClosedAt: 4321 },
  ])(
    "（US-021）終えたスレッドに返信するとスレッドと$parentState が開く",
    async ({ parentClosedAt }) => {
      thread();
      expect((await finish("t", { action: "close" })).status).toBe(200);
      expect(runner.runtime.store.get("t")?.closedAt).toBe(1234);
      database.sqlite
        .prepare("UPDATE conversations SET closed_at=? WHERE id='c'")
        .run(parentClosedAt);

      const reply = "idle 期限についての補足です";
      const response = await request("/api/conversations/t/messages", "POST", {
        text: reply,
        images: [],
        mode: "send",
        clientMessageId: "reply-to-ended-thread",
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ result: "delivered", queueItem: null });
      expect(
        database.sqlite.prepare("SELECT id, closed_at FROM conversations ORDER BY id").all(),
      ).toEqual([
        { id: "c", closed_at: null },
        { id: "t", closed_at: null },
      ]);
      expect(agent.sent.map(({ text }) => text)).toEqual([reply]);
    },
  );

  it("（US-022）作業中のスレッドを閉じるとAIが止まり実行を手放し、ストックと書きかけは保つ", async () => {
    thread();
    database.sqlite
      .prepare(
        "INSERT INTO drafts (conversation_id,text,updated_at,updated_by) VALUES ('t','書きかけ',1,'tab')",
      )
      .run();
    const sent = await link.call("POST", "/conversations/t/messages", {
      text: "作業して",
      images: [],
      interrupt: false,
      client_id: "client",
      origin: "developer",
    });
    expect(sent._unsafeUnwrap().status).toBe(200);
    expect(runner.runtime.store.get("t")?.runState).toBe("working");
    await vi.waitFor(() =>
      expect(
        messages.find((message) => (message as { topic: string }).topic === "conversation:c"),
      ).toEqual({
        topic: "conversation:c",
        seq: 0,
        type: "changed",
        payload: { parts: ["stock", "threads"] },
      }),
    );
    const before = database.sqlite.prepare("SELECT * FROM stock_items ORDER BY id").all();
    const response = await request("/api/threads/t/finish", "POST", { action: "close" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ thread: { id: "t", closedAt: 1234 } });
    expect(
      database.sqlite
        .prepare("SELECT closed_at,run_state,stop_reason FROM conversations WHERE id='t'")
        .get(),
    ).toEqual({ closed_at: 1234, run_state: "stopped", stop_reason: "user" });
    expect(runner.runtime.executions.has("t")).toBe(false);
    expect(agentActions).toEqual(["interrupt", "close"]);
    expect(
      messages.filter(
        (message) =>
          (message as { topic: string; type: string }).type === "changed" &&
          (message as { topic: string }).topic.startsWith("conversation:") &&
          (message as { payload: { parts: string[] } }).payload.parts.some(
            (part) => part === "stock" || part === "threads",
          ),
      ),
    ).toEqual([
      {
        topic: "conversation:c",
        seq: 0,
        type: "changed",
        payload: { parts: ["stock", "threads"] },
      },
      {
        topic: "conversation:c",
        seq: 0,
        type: "changed",
        payload: { parts: ["stock", "threads"] },
      },
      {
        topic: "conversation:t",
        seq: runner.runtime.store.get("t")!.lastSeq,
        type: "changed",
        payload: { parts: ["threads"] },
      },
    ]);
    expect(database.sqlite.prepare("SELECT * FROM stock_items ORDER BY id").all()).toEqual(before);
    expect(
      database.sqlite.prepare("SELECT text FROM drafts WHERE conversation_id='t'").get(),
    ).toEqual({ text: "書きかけ" });
    expect(
      database.sqlite
        .prepare("SELECT run_state,closed_at,last_seq FROM conversations WHERE id='c'")
        .get(),
    ).toEqual({ run_state: "idle", closed_at: null, last_seq: 0 });
    const again = await request("/api/threads/t/finish", "POST", { action: "close" });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: { code: "conflict", message: "このスレッドはすでに終えています" },
    });
  });
  it.each(["interrupt", "close"] as const)(
    "AIの %s が失敗すると503で終了を断り終了状態とストックを保つ",
    async (failure) => {
      thread();
      const sent = await link.call("POST", "/conversations/t/messages", {
        text: failure === "close" ? "idle" : "作業して",
        images: [],
        interrupt: false,
        client_id: "client",
        origin: "developer",
      });
      expect(sent._unsafeUnwrap().status).toBe(200);
      if (failure === "close" && runner.runtime.store.get("t")?.runState !== "idle") {
        await new Promise<void>((resolve) => {
          const off = runner.runtime.subscribe((signal) => {
            if (
              signal.conversationId === "t" &&
              runner.runtime.store.get("t")?.runState === "idle"
            ) {
              off();
              resolve();
            }
          });
        });
      }
      const before = database.sqlite.prepare("SELECT * FROM conversations WHERE id='t'").get();
      const stock = database.sqlite.prepare("SELECT * FROM stock_items ORDER BY id").all();
      agentFailure = failure;
      const response = await request("/api/threads/t/finish", "POST", { action: "close" });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: {
          code: "runner_unavailable",
          message:
            "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
        },
      });
      expect(database.sqlite.prepare("SELECT * FROM conversations WHERE id='t'").get()).toEqual(
        before,
      );
      expect(database.sqlite.prepare("SELECT * FROM stock_items ORDER BY id").all()).toEqual(stock);
      expect(agentActions).toEqual([failure]);
      expect(runner.runtime.releases.has("t")).toBe(false);
      agentFailure = undefined;
      const retry = (
        await link.call("POST", "/conversations/t/messages", {
          text: "失敗後の返信",
          images: [],
          interrupt: true,
          client_id: "retry-after-failure",
          origin: "developer",
        })
      )._unsafeUnwrap();
      expect(retry).toEqual({
        status: 200,
        body: { result: "delivered", seq: failure === "interrupt" ? 4 : 3 },
      });
    },
  );
  it("読み取りの直後にランナーが送った件への編集は409で拒み、元の本文を保つ", async () => {
    await add();
    const get = deps.repository.get.bind(deps.repository);
    deps.repository.get = (id) => {
      const current = get(id);
      database.sqlite.prepare("UPDATE stock_items SET state='sent' WHERE id=?").run(id);
      return current;
    };
    const response = await request("/api/stock/s001", "PATCH", { text: "編集" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "conflict",
        message: "この質問・指示の状態が変わっています。一覧を読み直して、もう一度操作してください",
      },
    });
    expect(
      database.sqlite.prepare("SELECT text,state FROM stock_items WHERE id='s001'").get(),
    ).toEqual({ text: "指示", state: "sent" });
  });
  it("終了保存前に届いた返信を拒み、閉じたスレッドでAIを動かさない", async () => {
    thread();
    const release = deps.release.bind(deps);
    let raced: unknown;
    deps.release = async (id) => {
      const result = await release(id);
      raced = (
        await link.call("POST", "/conversations/t/messages", {
          text: "割り込みの返信",
          images: [],
          interrupt: false,
          client_id: "race",
          origin: "developer",
        })
      )._unsafeUnwrap();
      return result;
    };
    const response = await request("/api/threads/t/finish", "POST", { action: "close" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ thread: { id: "t", closedAt: 1234 } });
    expect(raced).toEqual({
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: "会話の状態が変わりました。もう一度操作してください。",
        },
      },
    });
    expect(
      database.sqlite.prepare("SELECT closed_at,run_state FROM conversations WHERE id='t'").get(),
    ).toEqual({ closed_at: 1234, run_state: "idle" });
    expect(runner.runtime.executions.has("t")).toBe(false);
  });
  it("終了保存に失敗しても予約を解除し、次の返信を受け付ける", async () => {
    thread();
    database.sqlite.exec(
      "CREATE TRIGGER fail_close BEFORE UPDATE OF closed_at ON conversations BEGIN SELECT RAISE(FAIL, 'fixture'); END",
    );
    const response = await request("/api/threads/t/finish", "POST", { action: "close" });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal",
        message: "質問・指示を読み書きできませんでした。もう一度操作してください",
      },
    });
    expect(
      database.sqlite.prepare("SELECT closed_at FROM conversations WHERE id='t'").get(),
    ).toEqual({ closed_at: null });
    expect(runner.runtime.releases.has("t")).toBe(false);
    expect(
      database.sqlite.prepare("SELECT key FROM settings WHERE key='runner-release:t'").all(),
    ).toEqual([]);
    const sent = (
      await link.call("POST", "/conversations/t/messages", {
        text: "保存失敗後の返信",
        images: [],
        interrupt: false,
        client_id: "after-failure",
        origin: "developer",
      })
    )._unsafeUnwrap();
    expect(sent).toEqual({ status: 200, body: { result: "delivered", seq: 1 } });
  });
  it("保存完了の通知が届かなくても期限で予約を解除し、完了後の返信を受け付ける", async () => {
    thread();
    const release = deps.release.bind(deps);
    deps.release = async (id) =>
      (await release(id)).map((reservation) => ({ ...reservation, complete: async () => {} }));
    const response = await request("/api/threads/t/finish", "POST", { action: "close" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ thread: { id: "t", closedAt: 1234 } });
    expect(runner.runtime.executions.has("t")).toBe(false);
    expect(
      (
        await link.call("POST", "/conversations/t/messages", {
          text: "予約中の返信",
          images: [],
          interrupt: false,
          client_id: "pending",
          origin: "developer",
        })
      )._unsafeUnwrap(),
    ).toEqual({
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: "会話の状態が変わりました。もう一度操作してください。",
        },
      },
    });
    await timers.find((timer) => timer.milliseconds === 10_000 && !timer.cancelled)!.callback();
    expect(runner.runtime.releases.has("t")).toBe(false);
    expect(
      (
        await link.call("POST", "/conversations/t/messages", {
          text: "完了後の返信",
          images: [],
          interrupt: false,
          client_id: "after-close",
          origin: "developer",
        })
      )._unsafeUnwrap(),
    ).toEqual({ status: 200, body: { result: "delivered", seq: 1 } });
  });
  it.each(["expired", "wrong_token"])(
    "%s の予約では遅い終了保存を拒み、実行の操作を永久に待たせない",
    async (invalid) => {
      thread();
      const release = deps.release.bind(deps);
      deps.release = async (id) => {
        const reservation = await release(id);
        if (invalid === "expired")
          database.sqlite
            .prepare(
              "UPDATE settings SET value=json_set(value, '$.expiresAt', 0) WHERE key='runner-release:t'",
            )
            .run();
        return invalid === "wrong_token"
          ? reservation.map((value) => ({ ...value, token: "wrong" }))
          : reservation;
      };
      const response = await request("/api/threads/t/finish", "POST", { action: "close" });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: {
          code: "conflict",
          message: "スレッドの終了処理の状態が変わりました。もう一度操作してください",
        },
      });
      expect(
        database.sqlite.prepare("SELECT closed_at FROM conversations WHERE id='t'").get(),
      ).toEqual({ closed_at: null });
      expect(runner.runtime.releases.has("t")).toBe(false);
      expect(
        (
          await link.call("POST", "/conversations/t/messages", {
            text: "期限後の返信",
            images: [],
            interrupt: false,
            client_id: "after-expiry",
            origin: "developer",
          })
        )._unsafeUnwrap(),
      ).toEqual({ status: 200, body: { result: "delivered", seq: 1 } });
    },
  );
  it("違う予約トークンでは操作を解放せず、shutdownは残った予約を解除する", async () => {
    thread();
    const reserved = (await deps.release("t"))._unsafeUnwrap();
    const wrong = (
      await link.call("POST", "/conversations/t/release/complete", { token: "wrong" })
    )._unsafeUnwrap();
    expect(wrong).toEqual({
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: "会話の状態が変わりました。もう一度操作してください。",
        },
      },
    });
    expect(runner.runtime.releases.has("t")).toBe(true);
    await runner.runtime.shutdown();
    expect(runner.runtime.releases.has("t")).toBe(false);
    expect(
      database.sqlite.prepare("SELECT key FROM settings WHERE key='runner-release:t'").all(),
    ).toEqual([]);
    expect(
      (
        await link.call("POST", "/conversations/t/release/complete", { token: reserved.token })
      )._unsafeUnwrap(),
    ).toEqual({
      status: 503,
      body: {
        error: {
          code: "runner_unavailable",
          message:
            "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
        },
      },
    });
  });
  it("スレッドを閉じると利用枠の戻りを待つタイマーを外し、遅れて届いた自動再開も拒む", async () => {
    thread();
    database.sqlite
      .prepare(
        "UPDATE conversations SET run_state='usage_limited',stop_reason='usage_limit' WHERE id='t'",
      )
      .run();
    let resumed = false;
    runner.runtime.timers.schedule("t", null, () => {
      resumed = true;
    });
    const usageTimer = timers.find((timer) => timer.milliseconds === 900_000)!;
    const response = await request("/api/threads/t/finish", "POST", { action: "close" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ thread: { id: "t", closedAt: 1234 } });
    expect(usageTimer.cancelled).toBe(true);
    expect(resumed).toBe(false);
    const resumedResult = await runner.runtime.resume("t", "usage_limit");
    expect(resumedResult.isErr() ? resumedResult.error : resumedResult.value).toEqual({
      code: "conflict",
      message: "会話の状態が変わりました。もう一度操作してください。",
    });
    expect(runner.runtime.executions.has("t")).toBe(false);
    const developerResume = await runner.runtime.resume("t", "developer");
    expect(developerResume._unsafeUnwrap()).toEqual({ seq: 2 });
  });
  it("終了予約より前に予定された自動配送は、終了保存の後にAIを再開しない", async () => {
    thread();
    let accept: (reservation: Awaited<ReturnType<typeof deps.release>>) => void;
    const held = new Promise<Awaited<ReturnType<typeof deps.release>>>((resolve) => {
      accept = resolve;
    });
    const off = runner.runtime.subscribe((signal) => {
      if (signal.type !== "turnEnded" || signal.conversationId !== "t") return;
      off();
      runner.runtime.store.enqueue({
        id: "queued",
        conversationId: "t",
        text: "残った指示",
        images: [],
        position: 1,
        clientId: null,
        createdAt: 1,
      });
      void runner.runtime.releases.reserve("t").then((result) =>
        accept(
          result.map(({ token }) => ({
            token,
            complete: async () => {
              await link.call("POST", "/conversations/t/release/complete", { token });
            },
          })),
        ),
      );
    });
    expect(
      (
        await link.call("POST", "/conversations/t/messages", {
          text: "idle",
          images: [],
          interrupt: false,
          client_id: "turn",
          origin: "developer",
        })
      )._unsafeUnwrap().status,
    ).toBe(200);
    const reservation = await held;
    deps.release = async () => reservation;
    const response = await request("/api/threads/t/finish", "POST", { action: "close" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ thread: { id: "t", closedAt: 1234 } });
    await runner.runtime.serial("t", () => Promise.resolve(ok(undefined)));
    expect(
      database.sqlite.prepare("SELECT closed_at,run_state FROM conversations WHERE id='t'").get(),
    ).toEqual({ closed_at: 1234, run_state: "idle" });
    expect(runner.runtime.executions.has("t")).toBe(false);
    expect(runner.runtime.store.queue("t")).toEqual([
      {
        id: "queued",
        conversationId: "t",
        text: "残った指示",
        images: [],
        position: 1,
        clientId: null,
        createdAt: 1,
      },
    ]);
  });
  it("前の予約の遅いタイマーは次の予約を解除しない", async () => {
    thread();
    const first = (await deps.release("t"))._unsafeUnwrap();
    const previousTimer = timers.find(
      (timer) => timer.milliseconds === 10_000 && !timer.cancelled,
    )!;
    expect(
      (
        await link.call("POST", "/conversations/t/release/complete", { token: first.token })
      )._unsafeUnwrap(),
    ).toEqual({ status: 200, body: {} });
    const second = (await deps.release("t"))._unsafeUnwrap();
    expect(previousTimer.cancelled).toBe(true);
    await previousTimer.callback();
    expect(runner.runtime.releases.has("t")).toBe(true);
    expect(
      database.sqlite
        .prepare(
          "SELECT json_extract(value, '$.token') AS token FROM settings WHERE key='runner-release:t'",
        )
        .get(),
    ).toEqual({ token: second.token });
    await second.complete();
    expect(runner.runtime.releases.has("t")).toBe(false);
  });
  it.each(["timer", "complete"])(
    "%s で期限切れ予約の削除が失敗しても後続を待たせず、古いトークンで保存しない",
    async (by) => {
      thread();
      const reservation = (await deps.release("t"))._unsafeUnwrap();
      database.sqlite
        .prepare(
          "UPDATE settings SET value=json_set(value, '$.expiresAt', 0) WHERE key='runner-release:t'",
        )
        .run();
      database.sqlite.exec(
        "CREATE TRIGGER fail_release_cleanup BEFORE DELETE ON settings BEGIN SELECT RAISE(FAIL, 'fixture'); END",
      );
      const logs: unknown[] = [];
      runner.runtime.options.log = (context, message) => {
        logs.push({ context, message });
      };
      if (by === "timer") {
        await timers.find((timer) => timer.milliseconds === 10_000 && !timer.cancelled)!.callback();
        expect(logs).toEqual([
          {
            context: { conversationId: "t", issueId: null },
            message: "実行の予約を解除できませんでした。",
          },
        ]);
      } else {
        expect(
          (
            await link.call("POST", "/conversations/t/release/complete", {
              token: reservation.token,
            })
          )._unsafeUnwrap(),
        ).toEqual({
          status: 500,
          body: { error: { code: "internal", message: "実行の予約を解除できませんでした。" } },
        });
      }
      expect(runner.runtime.releases.has("t")).toBe(false);
      expect(deps.repository.close("t", 1234, reservation.token)._unsafeUnwrap()).toBe(false);
      expect(
        (
          await link.call("POST", "/conversations/t/messages", {
            text: "解除失敗後の返信",
            images: [],
            interrupt: false,
            client_id: "after-delete-failure",
            origin: "developer",
          })
        )._unsafeUnwrap(),
      ).toEqual({ status: 200, body: { result: "delivered", seq: 1 } });
    },
  );
  it("実行を手放す途中にランナーが終了しても予約を残さず終了保存を断る", async () => {
    thread();
    expect(
      (
        await link.call("POST", "/conversations/t/messages", {
          text: "作業",
          images: [],
          interrupt: false,
          client_id: "before-shutdown",
          origin: "developer",
        })
      )._unsafeUnwrap().status,
    ).toBe(200);
    let stopped = Promise.resolve();
    beforeAgentClose = () => {
      beforeAgentClose = undefined;
      stopped = runner.runtime.shutdown();
    };
    const response = await request("/api/threads/t/finish", "POST", { action: "close" });
    await stopped;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "conflict",
        message: "スレッドの終了処理の状態が変わりました。もう一度操作してください",
      },
    });
    expect(runner.runtime.releases.has("t")).toBe(false);
    expect(
      database.sqlite.prepare("SELECT key FROM settings WHERE key='runner-release:t'").all(),
    ).toEqual([]);
    expect(
      database.sqlite.prepare("SELECT closed_at FROM conversations WHERE id='t'").get(),
    ).toEqual({ closed_at: null });
  });
  it("終了予約中も既に受け付けた送信の再試行は同じ結果を返し、新しい指示は拒む", async () => {
    thread();
    const input = {
      text: "元の指示",
      images: [],
      interrupt: false,
      client_id: "repeat",
      origin: "developer",
    };
    expect((await link.call("POST", "/conversations/t/messages", input))._unsafeUnwrap()).toEqual({
      status: 200,
      body: { result: "delivered", seq: 1 },
    });
    const reservation = (await deps.release("t"))._unsafeUnwrap();
    expect((await link.call("POST", "/conversations/t/messages", input))._unsafeUnwrap()).toEqual({
      status: 200,
      body: { result: "delivered", seq: 1 },
    });
    const newInput = await runner.runtime.send("t", {
      text: "新しい指示",
      images: [],
      origin: "flow",
    });
    expect(newInput.isErr() ? newInput.error : newInput.value).toEqual({
      code: "conflict",
      message: "会話の状態が変わりました。もう一度操作してください。",
    });
    expect(runner.runtime.executions.has("t")).toBe(false);
    await reservation.complete();
  });
  it("予約中は他の会話の操作だけ進み、同じ会話の明示配送は終了保存後に進む", async () => {
    thread();
    runner.runtime.store.enqueue({
      id: "held-queue",
      conversationId: "t",
      text: "明示配送",
      images: [],
      position: 1,
      clientId: null,
      createdAt: 1,
    });
    const reservation = await deps.release("t");
    const resume = runner.runtime
      .resume("t")
      .then((result) => (result.isErr() ? result.error : result.value));
    const independent = runner.runtime
      .serial("resume-other", () => Promise.resolve(ok("independent")))
      .then((result) => result._unsafeUnwrap());
    expect(await Promise.race([resume, independent])).toEqual({
      code: "conflict",
      message: "会話の状態が変わりました。もう一度操作してください。",
    });
    const delivered = runner.runtime.deliverQueue("t");
    expect(
      (await runner.runtime.serial("other", () => Promise.resolve(ok("ready"))))._unsafeUnwrap(),
    ).toBe("ready");
    expect(runner.runtime.executions.has("t")).toBe(false);
    expect(runner.runtime.store.queue("t")).toEqual([
      {
        id: "held-queue",
        conversationId: "t",
        text: "明示配送",
        images: [],
        position: 1,
        clientId: null,
        createdAt: 1,
      },
    ]);
    deps.release = async () => reservation;
    const response = await request("/api/threads/t/finish", "POST", { action: "close" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ thread: { id: "t", closedAt: 1234 } });
    expect((await delivered)._unsafeUnwrap()).toEqual({ seq: 1 });
  });
  it.each(["release", "release/reserve"])(
    "無い会話の %s は404で断り、予約を残さない",
    async (operation) => {
      const response = (
        await link.call("POST", `/conversations/missing/${operation}`)
      )._unsafeUnwrap();
      expect(response).toEqual({
        status: 404,
        body: { error: { code: "not_found", message: "会話が見つかりません。" } },
      });
      expect(runner.runtime.releases.has("missing")).toBe(false);
      expect(
        database.sqlite
          .prepare("SELECT key FROM settings WHERE key='runner-release:missing'")
          .all(),
      ).toEqual([]);
    },
  );
  it("終了予約の応答が不正なら503で断り、残った予約は期限で解除する", async () => {
    thread();
    const forward = link.forward.bind(link);
    link.forward = async (method, path, input) => {
      const response = await forward(method, path, input);
      return path.endsWith("release/reserve") ? Response.json({ token: "" }) : response;
    };
    const response = await request("/api/threads/t/finish", "POST", { action: "close" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "runner_unavailable",
        message: "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
      },
    });
    expect(
      database.sqlite.prepare("SELECT closed_at FROM conversations WHERE id='t'").get(),
    ).toEqual({ closed_at: null });
    expect(runner.runtime.releases.has("t")).toBe(true);
    await timers.find((timer) => timer.milliseconds === 10_000 && !timer.cancelled)!.callback();
    expect(runner.runtime.releases.has("t")).toBe(false);
  });
  it.each(["idle", "working"])(
    "既存のreleaseは%sの実行を手放したあとの状態を返す",
    async (state) => {
      thread();
      if (state === "working")
        expect(
          (
            await link.call("POST", "/conversations/t/messages", {
              text: "作業",
              images: [],
              interrupt: false,
              client_id: "raw-release",
              origin: "developer",
            })
          )._unsafeUnwrap().status,
        ).toBe(200);
      expect((await link.call("POST", "/conversations/t/release"))._unsafeUnwrap()).toEqual({
        status: 200,
        body: { run_state: state === "working" ? "stopped" : "idle" },
      });
      expect(runner.runtime.executions.has("t")).toBe(false);
    },
  );
  it("終了予約は実行の出力を保存し終えるまでトークンを返さない", async () => {
    thread();
    expect(
      (
        await link.call("POST", "/conversations/t/messages", {
          text: "作業",
          images: [],
          interrupt: false,
          client_id: "pending-output",
          origin: "developer",
        })
      )._unsafeUnwrap().status,
    ).toBe(200);
    const execution = runner.runtime.executions.get("t")!;
    let finishOutput: () => void;
    let closed: () => void;
    const outputGate = new Promise<void>((resolve) => {
      finishOutput = resolve;
    });
    const closeGate = new Promise<void>((resolve) => {
      closed = resolve;
    });
    execution.consuming = execution.consuming.then(() => outputGate);
    beforeAgentClose = () => {
      closed();
    };
    let ready = false;
    const reservation = runner.runtime.releases.reserve("t").then((result) => {
      ready = true;
      return result;
    });
    await closeGate;
    expect(
      (await runner.runtime.serial("other-a", () => Promise.resolve(ok("a"))))._unsafeUnwrap(),
    ).toBe("a");
    expect(
      (await runner.runtime.serial("other-b", () => Promise.resolve(ok("b"))))._unsafeUnwrap(),
    ).toBe("b");
    expect(ready).toBe(false);
    finishOutput!();
    const result = (await reservation)._unsafeUnwrap();
    expect(
      database.sqlite
        .prepare(
          "SELECT json_extract(value, '$.token') AS token FROM settings WHERE key='runner-release:t'",
        )
        .get(),
    ).toEqual({ token: result.token });
    expect(ready).toBe(true);
    expect(
      (
        await link.call("POST", "/conversations/t/release/complete", { token: result.token })
      )._unsafeUnwrap(),
    ).toEqual({ status: 200, body: {} });
  });
  it("同時にスレッドを閉じると一方だけが保存され、もう一方は409になる", async () => {
    thread();
    const responses = await Promise.all([
      request("/api/threads/t/finish", "POST", { action: "close" }),
      request("/api/threads/t/finish", "POST", { action: "close" }),
    ]);
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 409]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      { thread: { id: "t", closedAt: 1234 } },
      {
        error: {
          code: "conflict",
          message: "スレッドの終了処理の状態が変わりました。もう一度操作してください",
        },
      },
    ]);
  });
  it("終えたスレッドはランナーが不通でも409で断る", async () => {
    thread("t", 10);
    link.stop();
    const response = await request("/api/threads/t/finish", "POST", { action: "close" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "conflict", message: "このスレッドはすでに終えています" },
    });
  });
  it("親の会話が無いスレッドも閉じられ、親への通知は出さない", async () => {
    thread();
    database.sqlite
      .prepare("UPDATE conversations SET parent_conversation_id=NULL WHERE id='t'")
      .run();
    const response = await request("/api/threads/t/finish", "POST", { action: "close" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ thread: { id: "t", closedAt: 1234 } });
    expect(
      messages.filter(
        (message) =>
          (message as { topic: string; type: string }).type === "changed" &&
          (message as { topic: string }).topic.startsWith("conversation:") &&
          (message as { payload: { parts: string[] } }).payload.parts.some(
            (part) => part === "stock" || part === "threads",
          ),
      ),
    ).toEqual([
      { topic: "conversation:t", seq: 0, type: "changed", payload: { parts: ["threads"] } },
    ]);
  });
  it("会話が無いとストックを追加せず404を返す", async () => {
    const response = await request("/api/conversations/missing/stock", "POST", {
      kind: "instruction",
      text: "指示",
      quote: terminal,
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "会話がありません" },
    });
  });
  it.each([
    { path: "/api/conversations/c/stock", method: "GET" },
    { path: "/api/conversations/c/stock", method: "POST" },
    { path: "/api/conversations/c/threads", method: "GET" },
    { path: "/api/threads/t/finish", method: "POST" },
  ])("会話の読み取りが失敗すると $path は500の形で返す", async ({ path, method }) => {
    database.sqlite.prepare("DROP TABLE conversations").run();
    const response = await request(
      path,
      method,
      path.endsWith("finish")
        ? { action: "close" }
        : method === "POST"
          ? { kind: "instruction", text: "指示", quote: terminal }
          : undefined,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal",
        message: "質問・指示を読み書きできませんでした。もう一度操作してください",
      },
    });
  });
  it.each([
    { path: "/api/conversations/c/stock", method: "GET" },
    { path: "/api/stock/s001", method: "PATCH" },
    { path: "/api/conversations/c/threads", method: "GET" },
  ])("引用の保存データを読めないと $path は500の形で返す", async ({ path, method }) => {
    await add();
    thread();
    database.sqlite.prepare("UPDATE stock_items SET quote=NULL").run();
    const response = await request(path, method, method === "PATCH" ? { text: "編集" } : undefined);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal",
        message: "質問・指示を読み書きできませんでした。もう一度操作してください",
      },
    });
  });
  it.each([
    {
      path: "/api/conversations/c/stock",
      method: "POST",
      table: "stock_items",
      operation: "INSERT",
    },
    { path: "/api/stock/s001", method: "PATCH", table: "stock_items", operation: "UPDATE" },
    {
      path: "/api/threads/t/finish",
      method: "POST",
      table: "conversations",
      operation: "UPDATE OF closed_at",
    },
  ])(
    "保存が失敗すると $path は500を返し変更を配信しない",
    async ({ path, method, table, operation }) => {
      await add();
      thread();
      messages.length = 0;
      database.sqlite.exec(
        `CREATE TRIGGER fail_write BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(FAIL, 'fixture failure'); END`,
      );
      const body = path.endsWith("finish")
        ? { action: "close" }
        : method === "PATCH"
          ? { text: "編集" }
          : { kind: "instruction", text: "指示", quote: terminal };
      const response = await request(path, method, body);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: {
          code: "internal",
          message: "質問・指示を読み書きできませんでした。もう一度操作してください",
        },
      });
      expect(messages).toEqual([]);
    },
  );
  it("スレッドの一覧と質問の関連をid順に返し、削除されたスレッドの参照はnullにする", async () => {
    thread("t2", 50);
    thread("t1");
    const response = await request("/api/conversations/c/threads");
    expect(response.status).toBe(200);
    expect(threadsResponseSchema.parse(await response.json())).toEqual({
      threads: ["t1", "t2"].map((id) => ({
        id,
        title: "質問",
        stockId: `q-${id}`,
        quote: terminal,
        runState: "idle",
        closedAt: id === "t2" ? 50 : null,
        lastActivityAt: 99,
      })),
    });
    const stock = await request("/api/conversations/c/stock");
    expect(await stock.json()).toEqual({
      items: ["t1", "t2"].map((id) =>
        baseItem(`q-${id}`, {
          kind: "question",
          text: "質問",
          state: "sent",
          sentAt: 12,
          thread: { id, title: "質問", runState: "idle", closed: id === "t2" },
        }),
      ),
    });
    database.sqlite.prepare("DELETE FROM conversations WHERE id='t1'").run();
    expect(await (await request("/api/conversations/c/threads")).json()).toEqual({
      threads: [
        {
          id: "t2",
          title: "質問",
          stockId: "q-t2",
          quote: terminal,
          runState: "idle",
          closedAt: 50,
          lastActivityAt: 99,
        },
      ],
    });
    expect(
      ((await (await request("/api/conversations/c/stock")).json()) as { items: StockItem[] })
        .items,
    ).toEqual([
      baseItem("q-t1", { kind: "question", text: "質問", state: "sent", sentAt: 12 }),
      baseItem("q-t2", {
        kind: "question",
        text: "質問",
        state: "sent",
        sentAt: 12,
        thread: { id: "t2", title: "質問", runState: "idle", closed: true },
      }),
    ]);
  });
  it("ランナーが不通なら終了を503で断りスレッドの保存状態を変えない", async () => {
    thread();
    link.stop();
    const before = database.sqlite.prepare("SELECT * FROM conversations WHERE id='t'").get();
    const response = await request("/api/threads/t/finish", "POST", { action: "close" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "runner_unavailable",
        message: "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
      },
    });
    expect(database.sqlite.prepare("SELECT * FROM conversations WHERE id='t'").get()).toEqual(
      before,
    );
  });
  it.each([
    "/api/conversations/missing/stock",
    "/api/conversations/missing/threads",
    "/api/stock/missing",
    "/api/threads/missing/finish",
    "/api/threads/c/finish",
  ])("存在しない対象 %s は404を返す", async (path) => {
    const response = await request(
      path,
      path.endsWith("finish") ? "POST" : path.startsWith("/api/stock") ? "DELETE" : "GET",
      path.endsWith("finish") ? { action: "close" } : undefined,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "not_found",
        message: path.includes("threads/")
          ? "スレッドがありません"
          : path.startsWith("/api/stock")
            ? "質問・指示がありません"
            : "会話がありません",
      },
    });
  });
  it("スレッドにストックを追加する操作を409で断る", async () => {
    thread();
    const response = await request("/api/conversations/t/stock", "POST", {
      kind: "question",
      text: "質問",
      quote: terminal,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "conflict", message: "スレッドでは、i で直接返信します" },
    });
  });
  it.each([
    { kind: "instruction", text: "", quote: terminal },
    { kind: "question", text: "a", quote: { kind: "file" } },
  ])("不正な追加の入力を400で断る (%j)", async (input) => {
    const response = await request("/api/conversations/c/stock", "POST", input);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_input", message: "質問・指示と引用の入力を確認してください" },
    });
  });
});

it("ストックの状態を条件にした更新は、先に送られた件の本文を上書きしない", async () => {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  try {
    database.sqlite
      .prepare("INSERT INTO conversations (id,project_id,kind,cwd) VALUES ('c','p','chat',?)")
      .run(home);
    const { createStockRepository } = await import("./stock-repository");
    const repository = createStockRepository(() => database.db);
    repository
      .add("s", "c", {
        kind: "instruction",
        text: "元の指示",
        quote: { kind: "terminal", mode: "line", text: "引用" },
      })
      ._unsafeUnwrap();
    expect(repository.update("s", "stocked", "sent")._unsafeUnwrap()).toEqual({
      id: "s",
      conversationId: "c",
      kind: "instruction",
      text: "元の指示",
      quote: { kind: "terminal", mode: "line", text: "引用" },
      state: "sent",
      sentAt: null,
      sentSeq: null,
      thread: null,
      githubCommentUrl: null,
    });
    expect(
      repository.update("s", "stocked", "stocked", "書き換え")._unsafeUnwrap(),
    ).toBeUndefined();
    expect(repository.get("s")._unsafeUnwrap()).toEqual({
      id: "s",
      conversationId: "c",
      kind: "instruction",
      text: "元の指示",
      quote: { kind: "terminal", mode: "line", text: "引用" },
      state: "sent",
      sentAt: null,
      sentSeq: null,
      thread: null,
      githubCommentUrl: null,
    });
  } finally {
    database.close();
    removeTempHome(home);
  }
});
