import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ok } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
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
  let home: string;
  let cwd: string;
  let database: OpenedDatabase;
  let runner: Awaited<ReturnType<typeof startRunnerApp>>;
  let link: RunnerLink;
  let app: ReturnType<typeof createApp>;
  let deps: ReturnType<typeof createStockDependencies>;
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
  const request = (path: string, method = "GET", body?: unknown) =>
    app.request(
      path,
      {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      },
      incomingWith("127.0.0.1", 50000),
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
    const agent = new ScriptedAgent({
      rules: [{ match: "idle", steps: [{ end: "success" }] }],
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
    runner = await startRunnerApp({
      clock: {
        now: () => Date.now(),
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
        log: () => {},
        notice: (notice) => hub.notice(notice),
        connection: (connected) => {
          if (connected) resolve();
        },
      });
      link.start();
    });
    let id = 0;
    deps = createStockDependencies({
      database: () => database.db,
      workspace: createWorkspaceDependencies(() => database.db),
      runner: () => link,
      now: () => 1234,
      id: () => `s${String(++id).padStart(3, "0")}`,
      changed: (id, parts) =>
        hub.notice({ kind: "conversation_parts", conversation_id: id, parts }),
    });
    app = createApp({
      build: "test",
      identity: {
        login: "dev@example.com",
        devIdentity: "dev@example.com",
        tailscale: createTailscaleLocalApi(),
        clock: { now: () => 0 },
      },
      stock: deps,
    });
  });
  afterEach(async () => {
    agentFailure = undefined;
    link.stop();
    await runner.shutdown();
    database.close();
    removeTempHome(home);
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
