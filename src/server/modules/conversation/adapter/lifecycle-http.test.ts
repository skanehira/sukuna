import { createStockDependencies } from "../../stock/adapter/dependencies";
import { ulid } from "ulid";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ok } from "neverthrow";
import { z } from "zod";
import { eventSchema } from "../../../../shared/events";
import type { StockSendInput } from "../../../../shared/stock";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { startRunnerApp } from "../../../../runner/app";
import { openDatabase, type OpenedDatabase } from "../../../../shared/db/open";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
} from "../../../../shared/db/test-helpers";
import { readEnvironment } from "../../../../shared/env";
import { closingSummarySchema, lifecycleSearchResponseSchema } from "../../../../shared/lifecycle";
import { createApp } from "../../../app";
import { RunnerLink } from "../../../runner-link";
import { incomingWith } from "../../identity/test-support";
import { createInboxRepository } from "../../inbox/adapter/inbox-repository";
import {
  createWorkspaceAgent,
  WorkspaceClock,
} from "../../workspace/adapter/worktree-conversation-test-support";
import { createRecapDependencies } from "../../recap/adapter/dependencies";
import { createWorkspaceDependencies } from "../../workspace/adapter/dependencies";
import { createLifecycleDependencies } from "./lifecycle-dependencies";
import { createGitCli, type GitRunner } from "../../workspace/adapter/git-cli";
import type { GhRunner } from "../../../../shared/gh/gh-runner";
import { createConversationDependencies } from "./dependencies";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const eventsResponse = z.object({ events: z.array(eventSchema) });
const hasUsageResume = (body: unknown) =>
  eventsResponse
    .parse(body)
    .events.some((event) => event.type === "resumed" && event.payload.by === "usage_limit");

const startedAt = Date.parse("2026-03-01T12:00:00Z");
const committedAt = "2026-03-01T12:01:00Z";
const closedAt = startedAt + 120_000;

function git(cwd: string, ...args: string[]) {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_DATE: committedAt, GIT_COMMITTER_DATE: committedAt },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

async function fixture(
  options: {
    git?: GitRunner;
    gitDeadline?: () => AbortSignal;
    gh?: GhRunner;
    clock?: WorkspaceClock;
    seed?: (sqlite: OpenedDatabase["sqlite"], project: string) => void;
  } = {},
) {
  const home = realpathSync(createTempHome());
  const project = join(home, "project");
  mkdirSync(project);
  git(project, "init", "-b", "main");
  git(project, "switch", "-c", "topic");
  git(project, "commit", "--allow-empty", "-m", "確認用の変更");
  const hash = git(project, "rev-parse", "HEAD");
  writeFileSync(join(project, "unfinished.txt"), "uncommitted");
  const database = openMigratedDatabase(home);
  const runnerDb = openDatabase(home);
  const sqlite = database.sqlite;
  sqlite
    .prepare(
      "INSERT INTO projects(id,name,path,default_branch,uses_github) VALUES ('p','Project',?,'main',1)",
    )
    .run(project);
  options.seed?.(sqlite, project);
  const sdk = createWorkspaceAgent("scripted");
  const environment = readEnvironment(
    "runner",
    { SUKUNA_HOME: home },
    home,
    () => true,
  )._unsafeUnwrap();
  const runnerRequests: string[] = [];
  const releaseReplies: { path: string; status: number }[] = [];
  const launchRunner = () =>
    startRunnerApp({
      database: runnerDb,
      environment,
      agent: sdk.agent,
      clock: options.clock,
      log: ({ component, message }) => {
        if (component === "runner.ipc") runnerRequests.push(message);
      },
    });
  let runner = await launchRunner();
  let connected = false;
  const link = new RunnerLink({
    socket: environment.socket,
    now: options.clock?.now,
    connection: (value) => {
      connected = value;
    },
    notice: () => {},
    log: () => {},
  });
  cleanups.push(async () => {
    link.stop();
    await runner.shutdown();
    await sdk.dispose();
    runnerDb.close();
    database.close();
    removeTempHome(home);
  });
  link.start();
  await expect.poll(() => connected).toBe(true);
  const inboxChanges: string[][] = [];
  const withdrawals: { ids: string[]; present: unknown[] }[] = [];
  const ghCalls: string[][] = [];
  const pull = {
    number: 7,
    title: "変更",
    url: "https://github.com/example/project/pull/7",
    state: "OPEN",
    createdAt: committedAt,
  };
  let beforeReserve: (() => Promise<void>) | undefined;
  let beforeComplete: ((path: string) => Promise<void>) | undefined;
  let beforeWithdraw: (() => Promise<void>) | undefined;
  const app = createApp({
    build: "test",
    conversations: createConversationDependencies({
      sqlite,
      home,
      runner: link,
      id: () => "image",
      now: () => closedAt,
      changed: () => {},
      reopened: (ids) => inboxChanges.push(ids),
    }),
    stock: createStockDependencies({
      database: () => database,
      workspace: createWorkspaceDependencies(() => database.db),
      runner: () => link,
      changed: () => {},
      id: ulid,
      now: () => closedAt,
    }),
    lifecycle: createLifecycleDependencies({
      database: () => database,
      home,
      now: () => closedAt,
      runner: {
        forward: async (method, path, input) => {
          if (path.endsWith("/release/reserve") && beforeReserve) {
            const before = beforeReserve;
            beforeReserve = undefined;
            await before();
          }
          if (path.endsWith("/release/complete")) await beforeComplete?.(path);
          const response = await link.forward(method, path, input);
          if (path.endsWith("/release/complete"))
            releaseReplies.push({ path, status: response.status });
          return response;
        },
      },
      git: options.git,
      gitDeadline: options.gitDeadline,
      workspace: createWorkspaceDependencies(() => database.db),
      log: () => {},
      gh: options.gh ?? {
        run: async (args) => {
          ghCalls.push(args);
          return { exitCode: 0, stdout: JSON.stringify([pull]), stderr: "" };
        },
      },
      withdraw: async ({ kind, ids }) => {
        const present = sqlite.prepare("SELECT id FROM notifications ORDER BY id").all();
        withdrawals.push({ ids, present });
        await beforeWithdraw?.();
        const dismiss = sqlite.prepare(
          kind === "notifications"
            ? "UPDATE notifications SET dismissed_at=? WHERE id=? AND dismissed_at IS NULL"
            : "UPDATE notifications SET dismissed_at=? WHERE target_kind='conversation' AND target_id=? AND dismissed_at IS NULL",
        );
        for (const id of ids) dismiss.run(closedAt, id);
      },
      changed: (_project, ids) => inboxChanges.push(ids),
    }),
    recap: createRecapDependencies(
      () => database.db,
      link,
      () => {},
    ),
    inbox: { repository: createInboxRepository(() => database.db), resetTime: String },
  });
  async function request(method: string, path: string, input?: unknown) {
    const response = await app.request(
      `/api${path}`,
      {
        method,
        ...(input === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(input),
            }),
      },
      incomingWith("127.0.0.1", 1),
    );
    return {
      status: response.status,
      body: response.headers.get("content-type")?.includes("application/json")
        ? await response.json()
        : await response.text(),
    };
  }
  function addConversation(
    id: string,
    input: {
      title?: string;
      parentId?: string;
      issueId?: string;
      runState?: string;
      closedAt?: number;
      lastActivityAt?: number;
      cwd?: string;
    } = {},
  ) {
    sqlite
      .prepare(
        `INSERT INTO conversations (id,project_id,kind,issue_id,parent_conversation_id,title,cwd,run_state,closed_at,last_activity_at)
       VALUES (?, 'p', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.parentId ? "thread" : input.issueId ? "impl" : "chat",
        input.issueId ?? null,
        input.parentId ?? null,
        input.title ?? id,
        input.cwd ?? project,
        input.runState ?? "idle",
        input.closedAt ?? null,
        input.lastActivityAt ?? startedAt,
      );
  }
  function addIssue(
    id: string,
    number: number,
    title: string,
    body: string,
    createdConversationId?: string,
  ) {
    sqlite
      .prepare(
        `INSERT INTO issues (id,project_id,number,title,body,state,created_conversation_id,created_at,updated_at)
       VALUES (?, 'p', ?, ?, ?, 'draft', ?, ?, ?)`,
      )
      .run(id, number, title, body, createdConversationId ?? null, startedAt, startedAt);
  }
  function event(id: string, seq: number, type: string, payload: unknown) {
    sqlite
      .prepare(
        "INSERT INTO conversation_events(conversation_id,seq,type,payload,created_at) VALUES(?,?,?,?,?)",
      )
      .run(id, seq, type, JSON.stringify(payload), startedAt);
    sqlite.prepare("UPDATE conversations SET last_seq=? WHERE id=?").run(seq, id);
  }
  function stock(
    id: string,
    conversation: string,
    kind: string,
    state = "stocked",
    threadId: string | null = null,
  ) {
    sqlite
      .prepare(
        "INSERT INTO stock_items(id,conversation_id,kind,text,state,thread_conversation_id) VALUES(?,?,?,?,?,?)",
      )
      .run(id, conversation, kind, id, state, threadId);
  }
  function notice(id: string, conversationId = id) {
    sqlite
      .prepare(
        "INSERT INTO notifications(id,target_kind,target_id,reason,title,body,created_at) VALUES(?, 'conversation', ?, 'waiting', 'title', 'body', ?)",
      )
      .run(id, conversationId, startedAt);
  }
  const send = (id: string, text: string) =>
    request("POST", `/conversations/${id}/messages`, {
      text,
      images: [],
      mode: "send",
      clientMessageId: text,
    });
  return {
    home,
    project,
    runnerRequests,
    releaseReplies,
    hash,
    sqlite,
    request,
    addConversation,
    addIssue,
    event,
    stock,
    notice,
    send,
    sdk,
    link,
    inboxChanges,
    withdrawals,
    ghCalls,
    pull,
    beforeComplete(callback: (path: string) => Promise<void>) {
      beforeComplete = callback;
    },
    beforeWithdraw(callback: () => Promise<void>) {
      beforeWithdraw = callback;
    },
    get runtime() {
      return runner.runtime;
    },
    async restartRunner() {
      link.stop();
      await runner.shutdown();
      runner = await launchRunner();
      link.start();
      await expect.poll(() => connected).toBe(true);
    },
    beforeReserve(callback: () => Promise<void>) {
      beforeReserve = callback;
    },
  };
}

it("締めくくりに会話の成果と Git・ストック・スレッドの残りを返す", async () => {
  const f = await fixture();
  f.addConversation("chat");
  f.addConversation("active-thread", { parentId: "chat", runState: "waiting_permission" });
  f.addConversation("idle-thread", { parentId: "chat" });
  f.addIssue("created", 47, "作った issue", "", "chat");
  f.addIssue("unrelated", 48, "別の issue", "");
  f.event("chat", 1, "user_message", { text: "指示", images: [], origin: "developer" });
  f.event("chat", 2, "diff", {
    tool_use_id: "tool-1",
    path: "created.txt",
    change: "create",
    content: "hello\n",
    hunks: [],
    truncated: false,
  });
  f.event("idle-thread", 1, "diff", {
    tool_use_id: "tool-2",
    path: "thread.txt",
    change: "create",
    content: "other",
    hunks: [],
    truncated: false,
  });
  f.stock("i", "chat", "instruction");
  f.stock("q", "chat", "question");
  f.stock("sent", "chat", "instruction", "sent");

  expect(await f.request("GET", "/conversations/chat/closing-summary")).toEqual({
    status: 200,
    body: {
      working: false,
      outputs: {
        issues: {
          ok: true,
          items: [{ id: "created", number: 47, title: "作った issue", state: "draft" }],
        },
        files: { ok: true, items: ["created.txt"] },
        commits: { ok: true, items: [{ hash: f.hash, subject: "確認用の変更" }], more: 0 },
        prs: { ok: true, items: [{ number: 7, title: "変更", url: f.pull.url, state: "OPEN" }] },
      },
      remaining: {
        uncommitted: { ok: true, items: ["unfinished.txt"], more: 0 },
        unpushed: { ok: true, count: 1, upstream: false },
        stock: { questions: 1, instructions: 1 },
        runningThreads: [
          { id: "active-thread", title: "active-thread", runState: "waiting_permission" },
        ],
      },
      git: true,
    },
  });
  expect(f.ghCalls).toEqual([
    [
      "pr",
      "list",
      "--head",
      "topic",
      "--state",
      "all",
      "--json",
      "number,title,url,state,createdAt",
      "--limit",
      "100",
    ],
  ]);
});

it("閉じた会話を一覧とツリーから外し、開いて読んだあと送って再開すると戻す", async () => {
  const f = await fixture();
  f.addConversation("chat", { title: "会話の題名" });
  f.addConversation("thread", { parentId: "chat" });
  f.event("chat", 1, "user_message", { text: "以前の指示", images: [], origin: "developer" });
  f.stock("stock", "chat", "instruction");
  f.notice("chat");
  f.notice("thread");
  f.sqlite
    .prepare(
      "INSERT INTO drafts(conversation_id,text,updated_at,updated_by) VALUES ('chat','書きかけ',?, 'tab')",
    )
    .run(startedAt);
  f.sqlite
    .prepare(
      "INSERT INTO queued_instructions(id,conversation_id,text,position,created_at) VALUES ('queued','chat','届く前の指示',1,?)",
    )
    .run(startedAt);
  f.sqlite
    .prepare(
      "INSERT INTO pending_answers(conversation_id,question_seq,answers,updated_at) VALUES ('chat',1,'{}',?)",
    )
    .run(startedAt);
  f.sqlite
    .prepare(
      "INSERT INTO toc_entries(conversation_id,position,title,start_seq) VALUES ('chat',1,'目次あり',1)",
    )
    .run();
  for (const path of ["/inbox", "/projects"]) {
    expect(JSON.stringify((await f.request("GET", path)).body)).toContain('"chat"');
  }
  const close = () => f.request("POST", "/conversations/chat/close", { stopIfWorking: false });
  expect(await Promise.all([close(), close()])).toEqual([
    { status: 200, body: { closedAt } },
    { status: 200, body: { closedAt } },
  ]);
  expect(f.withdrawals).toEqual([
    { ids: ["chat", "thread"], present: [{ id: "chat" }, { id: "thread" }] },
  ]);
  expect(f.inboxChanges).toEqual([["chat"]]);
  expect(f.sqlite.prepare("SELECT id,dismissed_at FROM notifications ORDER BY id").all()).toEqual([
    { id: "chat", dismissed_at: closedAt },
    { id: "thread", dismissed_at: closedAt },
  ]);
  expect(f.sqlite.prepare("SELECT text FROM drafts WHERE conversation_id='chat'").get()).toEqual({
    text: "書きかけ",
  });
  expect(
    f.sqlite.prepare("SELECT text FROM queued_instructions WHERE conversation_id='chat'").get(),
  ).toEqual({ text: "届く前の指示" });
  expect(
    f.sqlite.prepare("SELECT answers FROM pending_answers WHERE conversation_id='chat'").get(),
  ).toEqual({ answers: "{}" });
  expect(
    f.sqlite.prepare("SELECT title FROM toc_entries WHERE conversation_id='chat'").get(),
  ).toEqual({ title: "目次あり" });
  expect(await f.request("GET", "/conversations/chat")).toMatchObject({
    status: 200,
    body: { conversation: { closedAt } },
  });
  expect(await f.request("GET", "/conversations/chat/events?after=0")).toMatchObject({
    status: 200,
    body: { events: [{ seq: 1, type: "user_message" }] },
  });
  expect(
    await f.request("POST", "/conversations/chat/read", { readSeq: 1, position: 1 }),
  ).toMatchObject({ status: 204 });
  expect(
    f.sqlite.prepare("SELECT closed_at,last_read_seq FROM conversations WHERE id='chat'").get(),
  ).toEqual({ closed_at: closedAt, last_read_seq: 1 });
  for (const path of ["/inbox", "/projects"]) {
    expect(JSON.stringify((await f.request("GET", path)).body)).not.toContain('"chat"');
  }
  expect(await f.request("GET", "/projects/p/conversations")).toMatchObject({
    status: 200,
    body: {
      conversations: [{ id: "chat", closedAt, threads: [{ id: "thread", closedAt: null }] }],
    },
  });
  expect(await f.send("chat", "続き")).toMatchObject({ status: 202 });
  expect(await f.request("GET", "/conversations/chat")).toMatchObject({
    status: 200,
    body: { conversation: { closedAt: null } },
  });
  expect(JSON.stringify((await f.request("GET", "/inbox")).body)).toContain('"chat"');
  expect(f.sqlite.prepare("SELECT state FROM stock_items WHERE id='stock'").get()).toEqual({
    state: "stocked",
  });
});

it("作業中に止める指定がないと拒み、指定があると会話と動いているスレッドを止める", async () => {
  const f = await fixture();
  f.addConversation("chat");
  f.addConversation("thread", { parentId: "chat" });
  for (const id of ["chat", "thread"]) {
    expect(await f.send(id, "first-hold")).toMatchObject({ status: 202 });
    await expect
      .poll(() => f.sqlite.prepare("SELECT run_state FROM conversations WHERE id=?").get(id))
      .toEqual({ run_state: "working" });
  }
  expect(
    await f.request("POST", "/conversations/chat/close", { stopIfWorking: false }),
  ).toMatchObject({ status: 409, body: { error: { code: "conflict" } } });
  expect(await f.request("POST", "/conversations/chat/close", { stopIfWorking: true })).toEqual({
    status: 200,
    body: { closedAt },
  });
  expect(
    f.sqlite.prepare("SELECT id,run_state,closed_at FROM conversations ORDER BY id").all(),
  ).toEqual([
    { id: "chat", run_state: "stopped", closed_at: closedAt },
    { id: "thread", run_state: "stopped", closed_at: null },
  ]);
  expect(f.sdk.closed).toEqual([0, 1]);
});

it("通知を先に取り下げて会話と子のデータと画像を消し、作業ファイルと作成した issue を残す", async () => {
  const f = await fixture();
  f.addConversation("chat");
  f.addConversation("thread", { parentId: "chat" });
  f.addIssue("issue", 43, "作った issue", "", "chat");
  f.addConversation("issue-conversation", { issueId: "issue" });
  const actualWorktree = join(f.home, "actual-worktree");
  git(f.project, "worktree", "add", "-b", "untouched", actualWorktree, "HEAD");
  f.sqlite
    .prepare(
      "INSERT INTO worktrees(id,project_id,path,branch,origin) VALUES ('wt','p',?,'untouched','user')",
    )
    .run(actualWorktree);
  f.sqlite
    .prepare("UPDATE conversations SET cwd=?,worktree_id='wt' WHERE id IN ('chat','thread')")
    .run(actualWorktree);
  const decisions = join(actualWorktree, "decisions.md");
  writeFileSync(decisions, "残す決定");
  for (const id of ["chat", "thread"]) {
    f.notice(id);
    f.stock(`stock-${id}`, id, "instruction");
    f.event(id, 1, "user_message", { text: id, images: [], origin: "developer" });
    f.sqlite
      .prepare(
        "INSERT INTO drafts(conversation_id,text,updated_at,updated_by) VALUES (?, 'draft', ?, 'tab')",
      )
      .run(id, startedAt);
    f.sqlite
      .prepare(
        "INSERT INTO queued_instructions(id,conversation_id,text,position,created_at) VALUES (?, ?, 'queued', 1, ?)",
      )
      .run(id, id, startedAt);
    f.sqlite
      .prepare(
        "INSERT INTO pending_answers(conversation_id,question_seq,answers,updated_at) VALUES (?,1,'{}',?)",
      )
      .run(id, startedAt);
    f.sqlite
      .prepare(
        "INSERT INTO toc_entries(conversation_id,position,title,start_seq) VALUES (?,1,'chapter',1)",
      )
      .run(id);
    f.sqlite
      .prepare(
        "INSERT INTO questions(id,conversation_id,seq,kind,text) VALUES (?,?,1,'text','question')",
      )
      .run(id, id);
    const dir = join(f.home, "images", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "image.png"), "example");
  }
  expect(await f.request("DELETE", "/conversations/issue-conversation")).toMatchObject({
    status: 409,
    body: { error: { code: "conflict" } },
  });
  expect(await f.request("DELETE", "/conversations/chat")).toEqual({
    status: 200,
    body: { deleted: ["chat", "thread"] },
  });
  expect(f.withdrawals).toEqual([
    { ids: ["chat", "thread"], present: [{ id: "chat" }, { id: "thread" }] },
  ]);
  expect(f.inboxChanges).toEqual([["chat", "thread"]]);
  for (const table of [
    "conversation_events",
    "stock_items",
    "notifications",
    "drafts",
    "queued_instructions",
    "pending_answers",
    "toc_entries",
    "questions",
  ])
    expect(f.sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
  expect(f.sqlite.prepare("SELECT id FROM conversations").all()).toEqual([
    { id: "issue-conversation" },
  ]);
  expect(f.sqlite.prepare("SELECT created_conversation_id FROM issues").get()).toEqual({
    created_conversation_id: "chat",
  });
  for (const id of ["chat", "thread"]) expect(existsSync(join(f.home, "images", id))).toBe(false);
  expect(git(f.project, "worktree", "list", "--porcelain")).toContain(actualWorktree);
  expect(f.sqlite.prepare("SELECT removed_at FROM worktrees WHERE id='wt'").get()).toEqual({
    removed_at: null,
  });
  expect(existsSync(decisions)).toBe(true);
  expect(existsSync(join(f.project, "unfinished.txt"))).toBe(true);
  expect(await f.request("DELETE", "/conversations/chat")).toMatchObject({ status: 404 });
});

it("スレッドだけを削除すると元の会話とストックが残り、スレッドへの参照を外す", async () => {
  const f = await fixture();
  f.addConversation("chat");
  f.addConversation("thread", { parentId: "chat" });
  f.stock("question", "chat", "question", "sent", "thread");
  expect(await f.request("DELETE", "/conversations/thread")).toEqual({
    status: 200,
    body: { deleted: ["thread"] },
  });
  expect(f.sqlite.prepare("SELECT id FROM conversations").all()).toEqual([{ id: "chat" }]);
  expect(f.sqlite.prepare("SELECT id,state,thread_conversation_id FROM stock_items").all()).toEqual(
    [{ id: "question", state: "sent", thread_conversation_id: null }],
  );
});

it("会話と閉じたスレッドをまとめ、issue のスレッドを issue ごとに並べる", async () => {
  const f = await fixture();
  f.addConversation("older");
  f.addConversation("newer", { closedAt, lastActivityAt: startedAt + 1 });
  f.addConversation("t2", { parentId: "newer" });
  f.addConversation("t1", { parentId: "newer", closedAt });
  f.addIssue("i", 1, "issue", "");
  f.addConversation("impl", { issueId: "i" });
  f.addConversation("it", { parentId: "impl", issueId: "i" });
  const row = (id: string, lastActivityAt = startedAt, end: number | null = null) => ({
    id,
    title: id,
    runState: "idle",
    closedAt: end,
    lastActivityAt,
  });
  expect(await f.request("GET", "/projects/p/conversations")).toEqual({
    status: 200,
    body: {
      conversations: [
        {
          ...row("newer", startedAt + 1, closedAt),
          threads: [row("t1", startedAt, closedAt), row("t2")],
        },
        { ...row("older"), threads: [] },
      ],
      issueThreads: [{ issue: { id: "i", number: 1, title: "issue" }, threads: [row("it")] }],
    },
  });
  f.sqlite.prepare("UPDATE projects SET removed_at=? WHERE id='p'").run(closedAt);
  expect(await f.request("GET", "/projects/p/conversations")).toMatchObject({ status: 404 });
});

it("空白で語を分け、番号と本文を検索して、閉じた会話とスレッドを含める", async () => {
  const f = await fixture();
  f.addConversation("c", { title: "ALPHA 100%_match", closedAt, lastActivityAt: startedAt + 2 });
  f.addConversation("t", {
    title: "alpha 100%_match",
    parentId: "c",
    closedAt,
    lastActivityAt: startedAt + 1,
  });
  f.addConversation("other", { title: "Alpha 100abcXmatch" });
  f.addIssue("i12", 12, "題名", "alpha 100%_match");
  f.addIssue("i123", 123, "alpha", "100abcXmatch");
  const search = (q: string) => f.request("GET", "/search?" + new URLSearchParams({ q }));
  expect(await search("  AlPhA\t%_  ")).toEqual({
    status: 200,
    body: {
      truncated: false,
      results: [
        {
          type: "conversation",
          id: "c",
          projectId: "p",
          kind: "chat",
          title: "ALPHA 100%_match",
          closedAt,
          runState: "idle",
          lastActivityAt: startedAt + 2,
        },
        {
          type: "conversation",
          id: "t",
          projectId: "p",
          kind: "thread",
          parentId: "c",
          title: "alpha 100%_match",
          closedAt,
          runState: "idle",
          lastActivityAt: startedAt + 1,
        },
        {
          type: "issue",
          id: "i12",
          projectId: "p",
          title: "題名",
          number: 12,
          state: "draft",
          lastActivityAt: startedAt,
        },
      ],
    },
  });
  for (const q of ["#12 alpha", "12 alpha"])
    expect(await search(q)).toMatchObject({
      status: 200,
      body: { truncated: false, results: [{ id: "i12" }] },
    });
  expect(await search("   ")).toMatchObject({ status: 400 });
  expect(await search("a".repeat(201))).toMatchObject({ status: 400 });
});

it("issue と会話を合わせて新しい順に100件を返し、101件目だけを打ち切る", async () => {
  const f = await fixture();
  for (let index = 0; index < 100; index += 1) {
    f.addConversation(`chat-${index}`, {
      title: "上限で一致",
      lastActivityAt: startedAt + index + 1,
    });
  }
  const list = () => f.request("GET", "/search?" + new URLSearchParams({ q: "上限で一致" }));
  const ids = Array.from({ length: 100 }, (_, index) => `chat-${99 - index}`);
  const exactly = await list();
  expect(exactly).toMatchObject({ status: 200, body: { truncated: false } });
  expect(lifecycleSearchResponseSchema.parse(exactly.body).results.map(({ id }) => id)).toEqual(
    ids,
  );
  f.addIssue("too-old", 1, "上限で一致", "");
  const truncated = await list();
  expect(truncated).toMatchObject({ status: 200, body: { truncated: true } });
  expect(lifecycleSearchResponseSchema.parse(truncated.body).results.map(({ id }) => id)).toEqual(
    ids,
  );
});

it("閉じる直前に別の送信で作業中になった会話を、停止指定なしで止めない", async () => {
  const f = await fixture();
  f.addConversation("chat");
  f.beforeReserve(async () => {
    expect(await f.send("chat", "first-hold")).toMatchObject({ status: 202 });
    await expect
      .poll(() => f.sqlite.prepare("SELECT run_state FROM conversations WHERE id='chat'").get())
      .toEqual({ run_state: "working" });
  });
  expect(await f.request("POST", "/conversations/chat/close", {})).toEqual({
    status: 409,
    body: {
      error: { code: "conflict", message: "AI が作業中です。止めて閉じるか、やめてください" },
    },
  });
  expect(
    f.sqlite.prepare("SELECT run_state,closed_at FROM conversations WHERE id='chat'").get(),
  ).toEqual({ run_state: "working", closed_at: null });
  expect(f.sdk.closed).toEqual([]);
  expect(await f.request("POST", "/conversations/chat/close", { stopIfWorking: true })).toEqual({
    status: 200,
    body: { closedAt },
  });
  expect(f.sdk.closed).toEqual([0]);
});

it("ランナーに接続できない場合は閉じず、削除の前処理にも進まない", async () => {
  const f = await fixture();
  f.addConversation("chat");
  f.addConversation("thread", { parentId: "chat" });
  f.notice("chat");
  f.notice("thread");
  f.link.stop();
  expect(await f.request("POST", "/conversations/chat/close", {})).toMatchObject({
    status: 503,
    body: { error: { code: "runner_unavailable" } },
  });
  expect(await f.request("DELETE", "/conversations/chat")).toMatchObject({
    status: 503,
    body: { error: { code: "runner_unavailable" } },
  });
  expect(f.sqlite.prepare("SELECT id,closed_at FROM conversations ORDER BY id").all()).toEqual([
    { id: "chat", closed_at: null },
    { id: "thread", closed_at: null },
  ]);
  expect(f.sqlite.prepare("SELECT id,dismissed_at FROM notifications ORDER BY id").all()).toEqual([
    { id: "chat", dismissed_at: null },
    { id: "thread", dismissed_at: null },
  ]);
  expect(f.withdrawals).toEqual([]);
});

it("Git 管理外の会話には Git の4項目を返さず、既定ブランチの会話は gh を呼ばない", async () => {
  const f = await fixture();
  f.addConversation("plain", { cwd: f.home });
  expect(await f.request("GET", "/conversations/plain/closing-summary")).toEqual({
    status: 200,
    body: {
      working: false,
      git: false,
      outputs: { issues: { ok: true, items: [] }, files: { ok: true, items: [] } },
      remaining: { stock: { questions: 0, instructions: 0 }, runningThreads: [] },
    },
  });
  f.addConversation("main");
  f.event("main", 1, "user_message", { text: "確認", images: [], origin: "developer" });
  git(f.project, "switch", "-c", "main");
  expect(await f.request("GET", "/conversations/main/closing-summary")).toMatchObject({
    status: 200,
    body: {
      git: true,
      outputs: { prs: { ok: true, items: [] }, commits: { ok: true, items: [{ hash: f.hash }] } },
    },
  });
  expect(f.ghCalls).toEqual([]);
});

it("Git の取得が締切を越えても他の項目を返し、会話を閉じられる", async () => {
  let timedOutSignal: AbortSignal | undefined;
  const controllers = new Map<AbortSignal, AbortController>();
  const realGit = createGitCli();
  const f = await fixture({
    gitDeadline: () => {
      const controller = new AbortController();
      controllers.set(controller.signal, controller);
      return controller.signal;
    },
    git: {
      run: (args, opts) => {
        if (args[0] !== "status") return realGit.run(args, opts);
        timedOutSignal = opts.signal!;
        controllers.get(timedOutSignal)!.abort();
        return new Promise(() => {});
      },
    },
    gh: {
      run: async () => ({ exitCode: 1, stdout: "", stderr: "gh が GitHub にログインしていません" }),
    },
  });
  f.addConversation("chat");
  f.event("chat", 1, "user_message", { text: "確認", images: [], origin: "developer" });
  expect(await f.request("GET", "/conversations/chat/closing-summary")).toMatchObject({
    status: 200,
    body: {
      git: true,
      outputs: {
        commits: { ok: true, items: [{ hash: f.hash }] },
        prs: { ok: false, error: "gh が GitHub にログインしていません" },
      },
      remaining: {
        uncommitted: { ok: false, error: "10 秒で取得を打ち切りました" },
        unpushed: { ok: true, count: 1, upstream: false },
      },
    },
  });
  expect(timedOutSignal?.aborted).toBe(true);
  expect(await f.request("POST", "/conversations/chat/close", {})).toEqual({
    status: 200,
    body: { closedAt },
  });
});

it("コミットと未コミットを上限まで返し、上流にないコミットを数える", async () => {
  const f = await fixture();
  f.addConversation("chat");
  f.event("chat", 1, "user_message", { text: "確認", images: [], origin: "developer" });
  git(f.project, "branch", "upstream", f.hash);
  git(f.project, "branch", "--set-upstream-to=upstream");
  for (let number = 1; number <= 50; number += 1)
    git(f.project, "commit", "--allow-empty", "-m", `変更${number}`);
  for (let index = 0; index < 20; index += 1) {
    writeFileSync(join(f.project, `f-${String(index).padStart(2, "0")}.txt`), "new");
  }
  const result = await f.request("GET", "/conversations/chat/closing-summary");
  expect(result).toMatchObject({
    status: 200,
    body: {
      outputs: { commits: { ok: true, more: 1 } },
      remaining: {
        uncommitted: {
          ok: true,
          more: 1,
          items: Array.from(
            { length: 20 },
            (_, index) => `f-${String(index).padStart(2, "0")}.txt`,
          ),
        },
        unpushed: { ok: true, count: 50, upstream: true },
      },
    },
  });
  const commits = closingSummarySchema.parse(result.body).outputs.commits;
  expect(commits?.ok && commits.items.map(({ subject }) => subject)).toEqual(
    Array.from({ length: 50 }, (_, index) => `変更${50 - index}`),
  );
});

it("検索語の200文字をサロゲートペアも1文字と数える", async () => {
  const f = await fixture();
  const word = "😀".repeat(200);
  f.addConversation("unicode", { title: word });
  const search = (q: string) => f.request("GET", "/search?" + new URLSearchParams({ q }));
  expect(await search(word)).toMatchObject({
    status: 200,
    body: { results: [{ id: "unicode", title: word }], truncated: false },
  });
  expect(await search(word + "😀")).toMatchObject({ status: 400 });
});

it("ランナーを起動しても、閉じた会話のスレッドへ利用枠の自動再開を送らない", async () => {
  const clock = new WorkspaceClock();
  const resetAt = clock.now() + 100;
  const f = await fixture({
    clock,
    seed(sqlite, project) {
      const root = sqlite.prepare(
        "INSERT INTO conversations(id,project_id,kind,cwd,closed_at) VALUES(?,'p','chat',?,?)",
      );
      const thread = sqlite.prepare(
        "INSERT INTO conversations(id,project_id,kind,cwd,parent_conversation_id,run_state,resets_at) VALUES(?,'p','thread',?,?,'usage_limited',?)",
      );
      root.run("closed-chat", project, closedAt);
      root.run("open-chat", project, null);
      thread.run("closed-child", project, "closed-chat", resetAt);
      thread.run("open-child", project, "open-chat", resetAt);
    },
  });
  await clock.advance(60_100);
  expect(await f.request("GET", "/conversations/open-child/events")).toMatchObject({
    status: 200,
    body: {
      events: expect.arrayContaining([
        { seq: 1, type: "resumed", payload: { by: "usage_limit" }, createdAt: clock.now() },
      ]),
    },
  });
  expect(await f.request("GET", "/conversations/closed-child/events")).toMatchObject({
    status: 200,
    body: { events: [] },
  });
});

it("会話の削除を予約している間に分岐を頼んでも、削除済みの会話にスレッドを作らない", async () => {
  const f = await fixture();
  f.addConversation("chat");
  expect(await f.send("chat", "セッションを作る")).toMatchObject({ status: 202 });
  await expect
    .poll(() => f.sqlite.prepare("SELECT run_state FROM conversations WHERE id='chat'").get())
    .toEqual({ run_state: "idle" });

  let proceed = () => {};
  const entered = new Promise<void>((ready) =>
    f.beforeWithdraw(() => {
      ready();
      return new Promise<void>((resolve) => {
        proceed = resolve;
      });
    }),
  );
  const deletion = f.request("DELETE", "/conversations/chat");
  await entered;
  try {
    const forked = f.runtime.fork("chat", { kind: "thread", title: "分岐" });
    await new Promise<void>((next) => setImmediate(next));
    expect(f.sqlite.prepare("SELECT id FROM conversations ORDER BY id").all()).toEqual([
      { id: "chat" },
    ]);
    proceed();
    expect(await deletion).toEqual({ status: 200, body: { deleted: ["chat"] } });
    expect((await forked)._unsafeUnwrapErr()).toMatchObject({ code: "not_found" });
    expect(f.sqlite.prepare("SELECT id FROM conversations").all()).toEqual([]);
  } finally {
    proceed();
  }
});

it.each(["close", "delete", "untouched", "successful-close"] as const)(
  "会話とスレッドの終了予約の結果に応じて利用枠の自動再開を続ける %s",
  async (operation) => {
    const clock = new WorkspaceClock();
    const f = await fixture({
      clock,
      seed(sqlite, project) {
        sqlite
          .prepare(
            "INSERT INTO conversations (id,project_id,kind,cwd,run_state,resets_at) VALUES ('parent','p','chat',?,'usage_limited',?)",
          )
          .run(project, clock.now() + 100);
        sqlite
          .prepare(
            "INSERT INTO conversations (id,project_id,kind,cwd,parent_conversation_id,run_state,resets_at) VALUES ('a','p','thread',?,'parent','usage_limited',?),('b','p','thread',?,'parent','usage_limited',?)",
          )
          .run(project, clock.now() + 100, project, clock.now() + 100);
      },
    });
    if (operation === "close" || operation === "delete") {
      const other = await f.link.forward("POST", "/conversations/b/release/reserve", {
        only_idle: false,
      });
      expect(other.status).toBe(200);
      const request =
        operation === "close"
          ? f.request("POST", "/conversations/parent/close", { stopIfWorking: false })
          : f.request("DELETE", "/conversations/parent");
      expect(await request).toMatchObject({ status: 409, body: { error: { code: "conflict" } } });
      expect(
        (await f.link.forward("POST", "/conversations/b/release/complete", await other.json()))
          .status,
      ).toBe(200);
      expect(f.sqlite.prepare("SELECT id,closed_at FROM conversations ORDER BY id").all()).toEqual([
        { id: "a", closed_at: null },
        { id: "b", closed_at: null },
        { id: "parent", closed_at: null },
      ]);
    }
    if (operation === "successful-close") {
      expect(
        await f.request("POST", "/conversations/parent/close", { stopIfWorking: false }),
      ).toMatchObject({ status: 200, body: { closedAt } });
      expect(f.sqlite.prepare("SELECT id,closed_at FROM conversations ORDER BY id").all()).toEqual([
        { id: "a", closed_at: null },
        { id: "b", closed_at: null },
        { id: "parent", closed_at: closedAt },
      ]);
    }
    await clock.advance(60_100);
    const read = (id: string) => f.request("GET", "/conversations/" + id + "/events");
    const actual = await Promise.all([read("parent"), read("a")]);
    const seen = actual.map(({ status, body }) => ({
      status,
      resumed: hasUsageResume(body),
    }));
    expect(seen).toEqual(
      Array.from({ length: 2 }, () => ({
        status: 200,
        resumed: operation !== "successful-close",
      })),
    );
  },
);

it.each(["close", "delete"] as const)(
  "手放す途中で期限切れになった %s でも利用枠が戻れば再開する",
  async (operation) => {
    const clock = new WorkspaceClock();
    const f = await fixture({ clock });
    f.addConversation("parent");
    expect(await f.send("parent", "first-usage")).toMatchObject({ status: 202 });
    await expect
      .poll(() => f.sqlite.prepare("SELECT run_state FROM conversations WHERE id='parent'").get())
      .toEqual({ run_state: "usage_limited" });
    let proceed = () => {};
    const entered = new Promise<void>((ready) =>
      f.sdk.delayClose((finish) => {
        proceed = finish;
        ready();
      }),
    );
    const reviewed =
      operation === "close"
        ? f.request("POST", "/conversations/parent/close", { stopIfWorking: false })
        : f.request("DELETE", "/conversations/parent");
    await entered;
    try {
      await clock.advance(10_001);
      f.sdk.delayClose((finish) => finish());
      proceed();
      expect(await reviewed).toMatchObject({
        status: 503,
        body: { error: { code: "runner_unavailable" } },
      });
      expect(
        f.sqlite.prepare("SELECT run_state,closed_at FROM conversations WHERE id='parent'").get(),
      ).toEqual({ run_state: "usage_limited", closed_at: null });
      await clock.advance(100_000);
      const after = await f.request("GET", "/conversations/parent/events");
      const resumed = hasUsageResume(after.body);
      expect(resumed).toBe(true);
    } finally {
      f.sdk.delayClose((finish) => finish());
      proceed();
    }
  },
);

it.each(["close", "delete"] as const)(
  "SDK が手放せず %s が失敗しても利用枠が戻れば再開する",
  async (operation) => {
    const clock = new WorkspaceClock();
    const f = await fixture({ clock });
    f.addConversation("parent");
    expect(await f.send("parent", "first-usage")).toMatchObject({ status: 202 });
    await expect
      .poll(() => f.sqlite.prepare("SELECT run_state FROM conversations WHERE id='parent'").get())
      .toEqual({ run_state: "usage_limited" });
    f.sdk.delayClose(() => {
      throw new Error("review fake SDK close failure");
    });
    try {
      const result = await (operation === "close"
        ? f.request("POST", "/conversations/parent/close", { stopIfWorking: false })
        : f.request("DELETE", "/conversations/parent"));
      expect(result.status).toBe(500);
      expect(
        f.sqlite.prepare("SELECT run_state,closed_at FROM conversations WHERE id='parent'").get(),
      ).toEqual({ run_state: "usage_limited", closed_at: null });
      f.sdk.delayClose((finish) => finish());
      await clock.advance(100_000);
      const after = await f.request("GET", "/conversations/parent/events");
      const resumed = hasUsageResume(after.body);
      expect(resumed).toBe(true);
    } finally {
      f.sdk.delayClose((finish) => finish());
    }
  },
);

it("閉じた親がスレッドへの通常の返信で開く", async () => {
  const f = await fixture();
  f.addConversation("parent");
  f.addConversation("child", { parentId: "parent" });
  expect(await f.send("child", "first-hold")).toMatchObject({ status: 202 });
  await expect
    .poll(() => f.sqlite.prepare("SELECT run_state FROM conversations WHERE id='child'").get())
    .toEqual({ run_state: "working" });
  expect(await f.request("POST", "/conversations/parent/close", { stopIfWorking: true })).toEqual({
    status: 200,
    body: { closedAt },
  });
  expect(
    f.sqlite.prepare("SELECT id,run_state,closed_at FROM conversations ORDER BY id").all(),
  ).toEqual([
    { id: "child", run_state: "stopped", closed_at: null },
    { id: "parent", run_state: "idle", closed_at: closedAt },
  ]);
  expect(await f.send("child", "返信")).toMatchObject({ status: 202 });
  expect(f.sqlite.prepare("SELECT id,closed_at FROM conversations ORDER BY id").all()).toEqual([
    { id: "child", closed_at: null },
    { id: "parent", closed_at: null },
  ]);
});
function commitAt(cwd: string, subject: string, date: string) {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      subject,
    ],
    {
      cwd,
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

it.each([
  { label: "単調な履歴", clockRollback: false },
  { label: "コミッター時刻が一時的に戻った履歴", clockRollback: true },
])("$label でも会話開始後のコミットを全件返す", async ({ clockRollback }) => {
  const f = await fixture();
  f.addConversation("chat");
  f.event("chat", 1, "user_message", { text: "確認", images: [], origin: "developer" });
  if (clockRollback) commitAt(f.project, "時刻が戻った変更", "2026-03-01T11:59:59Z");
  commitAt(f.project, "新しい変更", "2026-03-01T12:02:00Z");
  const result = await f.request("GET", "/conversations/chat/closing-summary");
  expect(result.status).toBe(200);
  const commits = closingSummarySchema.parse(result.body).outputs.commits;
  expect(commits?.ok && commits.items.map(({ subject }) => subject)).toEqual([
    "新しい変更",
    "確認用の変更",
  ]);
});

it.each([30, 31, 101])(
  "同じブランチに PR が %i 件ある場合、会話開始後の全件を返す",
  async (count) => {
    const pulls = Array.from({ length: count }, (_, i) => ({
      number: count - i,
      title: "確認" + (count - i),
      url: "https://example.test/pr/" + (count - i),
      state: "MERGED",
      createdAt: "2026-03-01T12:01:00Z",
    }));
    const ghCalls: string[][] = [];
    const f = await fixture({
      gh: {
        run: async (args) => {
          ghCalls.push(args);
          const limitOption = args.findIndex((value) => value === "--limit" || value === "-L");
          const limit = limitOption === -1 ? 30 : Number(args[limitOption + 1]);
          return { stdout: JSON.stringify(pulls.slice(0, limit)), stderr: "", exitCode: 0 };
        },
      },
    });
    f.addConversation("chat");
    f.event("chat", 1, "user_message", { text: "確認", images: [], origin: "developer" });
    const result = await f.request("GET", "/conversations/chat/closing-summary");
    expect(result.status).toBe(200);
    expect(ghCalls.every((call) => call.slice(0, 4).join(" ") === "pr list --head topic")).toBe(
      true,
    );
    const value = closingSummarySchema.parse(result.body).outputs.prs;
    expect(value?.ok && value.items.map(({ number }) => number)).toEqual(
      pulls.map(({ number }) => number),
    );
  },
);

it.each(["start", "fork"] as const)(
  "親の削除中に届いたスレッドの作成を404にする %s",
  async (entry) => {
    const f = await fixture();
    f.addConversation("parent");
    expect(await f.send("parent", "セッションを作る")).toMatchObject({ status: 202 });
    await expect
      .poll(() => f.sqlite.prepare("SELECT run_state FROM conversations WHERE id='parent'").get())
      .toEqual({ run_state: "idle" });
    let proceed = () => {};
    const entered = new Promise<void>((ready) =>
      f.beforeWithdraw(() => {
        ready();
        return new Promise<void>((done) => {
          proceed = done;
        });
      }),
    );
    const deleting = f.request("DELETE", "/conversations/parent");
    await entered;
    try {
      const path = entry === "start" ? "/conversations" : "/conversations/parent/fork";
      const body =
        entry === "start"
          ? {
              kind: "thread",
              project_id: "p",
              cwd: f.project,
              title: "新しいスレッド",
              parent_conversation_id: "parent",
            }
          : { kind: "thread", title: "分岐" };
      const append = f.link.forward("POST", path, body);
      await expect.poll(() => f.runnerRequests.includes("POST " + path)).toBe(true);
      proceed();
      expect(await deleting).toEqual({ status: 200, body: { deleted: ["parent"] } });
      expect((await append).status).toBe(404);
      expect(f.sqlite.prepare("SELECT id FROM conversations").all()).toEqual([]);
    } finally {
      proceed();
    }
  },
);

it.each(["start", "fork"] as const)(
  "閉じる途中で届いた別スレッドの作成は409になる %s",
  async (entry) => {
    const f = await fixture();
    f.addConversation("parent");
    f.addConversation("existing", { parentId: "parent" });
    expect(await f.send("parent", "セッションを作る")).toMatchObject({ status: 202 });
    await expect
      .poll(() => f.sqlite.prepare("SELECT run_state FROM conversations WHERE id='parent'").get())
      .toEqual({ run_state: "idle" });
    let release = () => {};
    const blocking = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocked = f.runtime.serial("existing", async () => ok(await blocking));
    const closing = f.request("POST", "/conversations/parent/close", { stopIfWorking: true });
    await expect.poll(() => f.runtime.releases.has("existing")).toBe(true);
    try {
      const path = entry === "start" ? "/conversations" : "/conversations/parent/fork";
      const body =
        entry === "start"
          ? {
              kind: "thread",
              project_id: "p",
              cwd: f.project,
              title: "新しいスレッド",
              parent_conversation_id: "parent",
              message: "first-hold",
            }
          : { kind: "thread", title: "分岐" };
      const append = f.link.forward("POST", path, body);
      await expect.poll(() => f.runnerRequests.includes("POST " + path)).toBe(true);
      release();
      await blocked;
      expect(await closing).toEqual({ status: 200, body: { closedAt } });
      expect((await append).status).toBe(409);
      expect(f.sqlite.prepare("SELECT id,closed_at FROM conversations ORDER BY id").all()).toEqual([
        { id: "existing", closed_at: null },
        { id: "parent", closed_at: closedAt },
      ]);
      expect(await f.send("existing", "通常の返信")).toMatchObject({ status: 202 });
      expect(
        f.sqlite.prepare("SELECT closed_at FROM conversations WHERE id='parent'").get(),
      ).toEqual({ closed_at: null });
    } finally {
      release();
    }
  },
);

it("閉鎖後に取り下げが失敗しても一覧へ配信し、再試行で未処理の通知だけを取り下げる", async () => {
  const f = await fixture();
  f.addConversation("chat");
  f.addConversation("thread", { parentId: "chat" });
  f.notice("chat");
  f.notice("thread");
  const close = () => f.request("POST", "/conversations/chat/close", {});
  const notices = () =>
    f.sqlite.prepare("SELECT id,dismissed_at FROM notifications ORDER BY id").all();
  let shouldFail = true;
  f.beforeWithdraw(async () => {
    if (shouldFail) {
      shouldFail = false;
      throw new Error("一時的な通知の保存失敗");
    }
  });
  const first = await close();
  expect(f.sqlite.prepare("SELECT closed_at FROM conversations WHERE id='chat'").get()).toEqual({
    closed_at: closedAt,
  });
  expect(notices()).toEqual([
    { id: "chat", dismissed_at: null },
    { id: "thread", dismissed_at: null },
  ]);
  expect(first).toEqual({ status: 200, body: { closedAt } });
  expect(f.inboxChanges).toEqual([["chat"]]);
  expect(await Promise.all([close(), close()])).toEqual([first, first]);
  expect(notices()).toEqual([
    { id: "chat", dismissed_at: closedAt },
    { id: "thread", dismissed_at: closedAt },
  ]);
  expect(f.withdrawals.map(({ ids }) => ids)).toEqual([
    ["chat", "thread"],
    ["chat", "thread"],
  ]);
  expect(f.inboxChanges).toEqual([["chat"]]);
});

it.each(["reserve", "release"] as const)(
  "利用枠の戻り時刻が不明でも、予約だけは元の再試行時刻を保つ %s",
  async (operation) => {
    const clock = new WorkspaceClock();
    const f = await fixture({
      clock,
      seed(sqlite, project) {
        sqlite
          .prepare(
            "INSERT INTO conversations(id,project_id,kind,cwd,run_state) VALUES('chat','p','chat',?,'usage_limited')",
          )
          .run(project);
      },
    });
    await clock.advance(15 * 60 * 1000 - 1);
    const path = "/conversations/chat/release";
    const reserved = await f.link.forward(
      "POST",
      operation === "reserve" ? path + "/reserve" : path,
    );
    expect(reserved.status).toBe(200);
    await clock.advance(1);
    expect(await f.request("GET", "/conversations/chat/events")).toMatchObject({
      status: 200,
      body: { events: [] },
    });
    if (operation === "reserve") {
      expect((await f.link.forward("POST", path + "/complete", await reserved.json())).status).toBe(
        200,
      );
      await clock.advance(0);
      expect(await f.request("GET", "/conversations/chat/events")).toMatchObject({
        status: 200,
        body: {
          events: expect.arrayContaining([
            expect.objectContaining({ type: "resumed", payload: { by: "usage_limit" } }),
          ]),
        },
      });
    } else {
      await clock.advance(15 * 60 * 1000);
      expect(await f.request("GET", "/conversations/chat/events")).toMatchObject({
        status: 200,
        body: { events: [] },
      });
    }
  },
);

it.each(["start", "fork"] as const)(
  "親の予約待ちで期限を過ぎたスレッド作成を保存しない %s",
  async (entry) => {
    const clock = new WorkspaceClock();
    const f = await fixture({ clock });
    f.addConversation("parent");
    expect(await f.send("parent", "セッションを作る")).toMatchObject({ status: 202 });
    await expect
      .poll(() => f.sqlite.prepare("SELECT run_state FROM conversations WHERE id='parent'").get())
      .toEqual({ run_state: "idle" });
    const reserved = await f.link.forward("POST", "/conversations/parent/release/reserve");
    expect(reserved.status).toBe(200);
    const path = entry === "start" ? "/conversations" : "/conversations/parent/fork";
    const body =
      entry === "start"
        ? {
            project_id: "p",
            kind: "thread",
            parent_conversation_id: "parent",
            title: "遅れたスレッド",
            cwd: f.project,
          }
        : { kind: "thread", title: "遅れた分岐" };
    const appended = f.link.forward("POST", path, body);
    await expect.poll(() => f.runnerRequests.includes("POST " + path)).toBe(true);
    await clock.advance(10_001);
    expect((await appended).status).toBe(503);
    expect(f.sqlite.prepare("SELECT id FROM conversations ORDER BY id").all()).toEqual([
      { id: "parent" },
    ]);
  },
);

it("2 回目の PR 取得が失敗すると項目の失敗を返し、取得済み 100 件だけを表示しない", async () => {
  const limits: number[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const f = await fixture({
    gh: {
      run: async (args, options) => {
        const limit = Number(args.at(-1));
        limits.push(limit);
        signals.push(options.signal);
        if (limit > 100) return { stdout: "", stderr: "次の取得に失敗", exitCode: 1 };
        const rows = Array.from({ length: 100 }, (_, index) => ({
          number: 100 - index,
          title: "変更",
          state: "CLOSED",
          url: "https://example.test/pr/" + (100 - index),
          createdAt: committedAt,
        }));
        return { stdout: JSON.stringify(rows), stderr: "", exitCode: 0 };
      },
    },
  });
  f.addConversation("chat");
  f.event("chat", 1, "user_message", { text: "確認", images: [], origin: "developer" });
  expect(await f.request("GET", "/conversations/chat/closing-summary")).toMatchObject({
    status: 200,
    body: {
      outputs: {
        commits: { ok: true, items: [{ hash: f.hash }] },
        prs: { ok: false, error: "次の取得に失敗" },
      },
    },
  });
  expect(limits).toEqual([100, 200]);
  expect(signals[0]).toBeInstanceOf(AbortSignal);
  expect(signals[1]).toBe(signals[0]);
});

it("閉鎖の保存に失敗した場合は通知を取り下げず、一覧に閉鎖を配信しない", async () => {
  const f = await fixture();
  f.addConversation("chat");
  f.notice("chat");
  f.sqlite.exec(
    "CREATE TRIGGER fail_chat_close BEFORE UPDATE OF closed_at ON conversations BEGIN SELECT RAISE(ABORT,'unavailable'); END",
  );
  const close = () => f.request("POST", "/conversations/chat/close", {});
  expect(await close()).toMatchObject({ status: 500, body: { error: { code: "internal" } } });
  expect(f.sqlite.prepare("SELECT closed_at FROM conversations WHERE id='chat'").get()).toEqual({
    closed_at: null,
  });
  expect(f.withdrawals).toEqual([]);
  expect(f.inboxChanges).toEqual([]);
  f.sqlite.exec("DROP TRIGGER fail_chat_close");
  expect(await close()).toEqual({ status: 200, body: { closedAt } });
  expect(f.inboxChanges).toEqual([["chat"]]);
});

it("開始後のコミットは時計が戻った場合も時刻の新しい順に返す", async () => {
  const f = await fixture();
  f.addConversation("chat");
  f.event("chat", 1, "user_message", { text: "確認", images: [], origin: "developer" });
  commitAt(f.project, "日時は新しい親", "2026-03-01T12:02:00Z");
  commitAt(f.project, "日時が戻った先端", "2026-03-01T12:01:30Z");
  const summary = await f.request("GET", "/conversations/chat/closing-summary");
  expect(summary.status).toBe(200);
  const commits = closingSummarySchema.parse(summary.body).outputs.commits;
  expect(commits?.ok && commits.items.map(({ subject }) => subject)).toEqual([
    "日時は新しい親",
    "日時が戻った先端",
    "確認用の変更",
  ]);
});

it.each(["現行ランナー", "再起動したランナー"])(
  "閉鎖を確定したあと予約解除前にスレッドから開き直しても、親の古い利用枠タイマーは戻さない %s",
  async (backend) => {
    const clock = new WorkspaceClock();
    const f = await fixture({
      clock,
      seed(sqlite, project) {
        sqlite
          .prepare(
            "INSERT INTO conversations (id,project_id,kind,cwd,run_state,resets_at) VALUES ('parent','p','chat',?,'usage_limited',?)",
          )
          .run(project, clock.now() + 100);
      },
    });
    f.addConversation("child", { parentId: "parent" });
    let proceed = () => {};
    const entered = new Promise<void>((ready) =>
      f.beforeComplete(async (path) => {
        if (path !== "/conversations/parent/release/complete") return;
        ready();
        await new Promise<void>((done) => {
          proceed = done;
        });
      }),
    );
    const closed = f.request("POST", "/conversations/parent/close", {});
    await entered;
    try {
      expect(
        f.sqlite.prepare("SELECT closed_at FROM conversations WHERE id='parent'").get(),
      ).toEqual({ closed_at: closedAt });
      expect(await f.send("child", "スレッドへの返信")).toMatchObject({ status: 202 });
      expect(
        f.sqlite.prepare("SELECT closed_at FROM conversations WHERE id='parent'").get(),
      ).toEqual({ closed_at: null });
      proceed();
      expect(await closed).toEqual({ status: 200, body: { closedAt } });
      if (backend === "再起動したランナー") await f.restartRunner();
      await clock.advance(60_100);
      expect(await f.request("GET", "/conversations/parent/events")).toMatchObject({
        status: 200,
        body: { events: [] },
      });
    } finally {
      proceed();
    }
  },
);

function holdSqliteWriter(file: string) {
  const program = `
    const Database = require("better-sqlite3");
    const database = new Database(process.argv[1]);
    database.exec("BEGIN IMMEDIATE");
    const timer = setTimeout(() => process.exit(2), 20_000);
    process.stdin.once("data", () => {
      clearTimeout(timer);
      database.exec("ROLLBACK");
      database.close();
      process.stdin.destroy();
    });
    process.stdout.write("locked\\n");
  `;
  const child = spawn(process.execPath, ["-e", program, file], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const stopped = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`SQLite writer exit ${code}`)),
    );
  });
  const locked = new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`SQLite writer exited before locking: ${code}`)));
  });
  return {
    locked,
    async release() {
      child.stdin.end("release");
      await stopped;
    },
  };
}

it.each(["failed-close", "failed-delete", "successful-close", "successful-delete"] as const)(
  "親の終了予約解除が別プロセスの書き込みと競合した場合に、確定結果に従って自動再開する %s",
  async (mode) => {
    const clock = new WorkspaceClock();
    const f = await fixture({
      clock,
      seed(sqlite, project) {
        sqlite
          .prepare(
            "INSERT INTO conversations(id,project_id,kind,cwd,run_state,resets_at) VALUES('parent','p','chat',?,'usage_limited',?)",
          )
          .run(project, clock.now() + 100);
        sqlite
          .prepare(
            "INSERT INTO conversations(id,project_id,kind,cwd,parent_conversation_id,run_state,resets_at) VALUES('child','p','thread',?,'parent','usage_limited',?)",
          )
          .run(project, clock.now() + 100);
      },
    });
    const failed = mode.startsWith("failed");
    const childLease = failed
      ? await f.link.forward("POST", "/conversations/child/release/reserve")
      : undefined;
    if (childLease) expect(childLease.status).toBe(200);
    let writer: ReturnType<typeof holdSqliteWriter> | undefined;
    const completePath = "/conversations/parent/release/complete";
    f.beforeComplete(async (path) => {
      if (path !== completePath || writer) return;
      writer = holdSqliteWriter(f.sqlite.name);
      await writer.locked;
    });
    try {
      const result = mode.endsWith("delete")
        ? await f.request("DELETE", "/conversations/parent")
        : await f.request("POST", "/conversations/parent/close", {});
      expect(result.status).toBe(failed ? 409 : 200);
      expect(f.releaseReplies.filter(({ path }) => path === completePath)).toEqual([
        { path: completePath, status: 500 },
      ]);
      const held = f.runtime.releases.has("parent");
      const token = () =>
        f.sqlite.prepare("SELECT key FROM settings WHERE key='runner-release:parent'").get();
      expect(token()).toEqual({ key: "runner-release:parent" });

      await writer!.release();
      writer = undefined;
      if (childLease)
        expect(
          (
            await f.link.forward(
              "POST",
              "/conversations/child/release/complete",
              await childLease.json(),
            )
          ).status,
        ).toBe(200);
      await clock.advance(60_100);
      const parent = await f.request("GET", "/conversations/parent/events");
      const child = await f.request("GET", "/conversations/child/events");
      if (mode === "successful-delete") {
        expect([parent.status, child.status]).toEqual([404, 404]);
      } else {
        expect({
          parent: parent.status === 200 && hasUsageResume(parent.body),
          child: child.status === 200 && hasUsageResume(child.body),
        }).toEqual({ parent: failed, child: failed });
      }
      expect(held).toBe(true);
      expect(token()).toBeUndefined();
      expect(f.runtime.releases.has("parent")).toBe(false);
    } finally {
      if (writer) await writer.release();
    }
  },
  20_000,
);

it.each([false, true])(
  "使われなかった予約を期限満了で解除し、元の予定で自動再開する 書き込み競合=%s",
  async (busy) => {
    const clock = new WorkspaceClock();
    const f = await fixture({
      clock,
      seed(sqlite, project) {
        sqlite
          .prepare(
            "INSERT INTO conversations(id,project_id,kind,cwd,run_state,resets_at) VALUES('parent','p','chat',?,'usage_limited',?)",
          )
          .run(project, clock.now() + 100);
      },
    });
    const path = "/conversations/parent/release";
    const expiredLease = await f.link.forward("POST", path + "/reserve");
    expect(expiredLease.status).toBe(200);
    const expiredToken: unknown = await expiredLease.json();
    const writer = busy ? holdSqliteWriter(f.sqlite.name) : undefined;
    let held = false;
    try {
      await writer?.locked;
      await clock.advance(10_000);
      held = f.runtime.releases.has("parent");
    } finally {
      await writer?.release();
    }
    await clock.advance(250);
    const freshLease = await f.link.forward("POST", path + "/reserve");
    expect(freshLease.status).toBe(200);
    expect((await f.link.forward("POST", path + "/complete", expiredToken)).status).toBe(409);
    expect(f.runtime.releases.has("parent")).toBe(true);
    expect((await f.link.forward("POST", path + "/complete", await freshLease.json())).status).toBe(
      200,
    );
    await clock.advance(49_850);
    const events = await f.request("GET", "/conversations/parent/events");
    expect(events.status).toBe(200);
    expect(hasUsageResume(events.body)).toBe(true);
    expect(held).toBe(busy);
    expect(
      f.sqlite.prepare("SELECT key FROM settings WHERE key='runner-release:parent'").get(),
    ).toBeUndefined();
  },
  18_000,
);

it.each([false, true])(
  "古い閉鎖の通知を再試行し、新しい番の通知を保つ 開き直し=%s",
  async (reopened) => {
    const f = await fixture();
    f.addConversation("parent");
    f.addConversation("child", { parentId: "parent" });
    f.notice("old-parent", "parent");
    f.notice("old-child", "child");
    f.notice("dismissed", "child");
    f.sqlite.prepare("UPDATE notifications SET dismissed_at=? WHERE id='dismissed'").run(startedAt);
    const close = () => f.request("POST", "/conversations/parent/close", {});
    f.beforeWithdraw(async () => {
      throw new Error("一時的な通知保存失敗");
    });
    const first = await close();
    expect(first).toEqual({ status: 200, body: { closedAt } });
    let release = () => {};
    const holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((ready) =>
      f.beforeWithdraw(async () => {
        ready();
        await holding;
      }),
    );
    const retry = close();
    await entered;
    try {
      if (reopened) {
        expect(await f.send("parent", "新しい番を始める")).toMatchObject({ status: 202 });
        expect(
          f.sqlite.prepare("SELECT closed_at FROM conversations WHERE id='parent'").get(),
        ).toEqual({ closed_at: null });
        f.notice("new-parent", "parent");
        f.notice("new-child", "child");
      }
    } finally {
      release();
    }
    expect(await retry).toEqual(first);
    expect(f.sqlite.prepare("SELECT id,dismissed_at FROM notifications ORDER BY id").all()).toEqual(
      [
        { id: "dismissed", dismissed_at: startedAt },
        ...(reopened
          ? [
              { id: "new-child", dismissed_at: null },
              { id: "new-parent", dismissed_at: null },
            ]
          : []),
        { id: "old-child", dismissed_at: closedAt },
        { id: "old-parent", dismissed_at: closedAt },
      ],
    );
    expect(f.withdrawals.map(({ ids }) => ids)).toEqual([
      ["old-child", "old-parent"],
      ["old-child", "old-parent"],
    ]);
  },
);

it("書き込みトランザクションで使えないと確認した予約は、削除処理が失敗しても元の予定で自動再開する", async () => {
  const clock = new WorkspaceClock();
  const f = await fixture({
    clock,
    seed(sqlite, project) {
      sqlite
        .prepare(
          "INSERT INTO conversations(id,project_id,kind,cwd,run_state,resets_at) VALUES('parent','p','chat',?,'usage_limited',?)",
        )
        .run(project, clock.now() + 100);
    },
  });
  const path = "/conversations/parent/release";
  const reserve = await f.link.forward("POST", path + "/reserve");
  expect(reserve.status).toBe(200);
  f.sqlite
    .prepare(
      "UPDATE settings SET value=json_set(value,'$.expiresAt',0) WHERE key='runner-release:parent'",
    )
    .run();
  f.sqlite.exec(
    "CREATE TRIGGER reject_expired_release BEFORE DELETE ON settings WHEN OLD.key='runner-release:parent' BEGIN SELECT RAISE(FAIL,'fixture'); END",
  );
  expect((await f.link.forward("POST", path + "/complete", await reserve.json())).status).toBe(500);
  expect(f.runtime.releases.has("parent")).toBe(false);
  expect(
    f.sqlite.prepare("SELECT key FROM settings WHERE key='runner-release:parent'").get(),
  ).toEqual({ key: "runner-release:parent" });
  await clock.advance(60_100);
  const events = await f.request("GET", "/conversations/parent/events");
  expect(events.status).toBe(200);
  expect(hasUsageResume(events.body)).toBe(true);
});

type StockSendKind = StockSendInput["kinds"];

async function seedStockParent(f: Awaited<ReturnType<typeof fixture>>) {
  f.addConversation("parent");
  expect(await f.send("parent", "元の会話の履歴を作る")).toMatchObject({ status: 202 });
  await expect.poll(() => f.runtime.store.get("parent")?.runState).toBe("idle");
  for (const [kind, text] of [
    ["question", "このログについて尋ねる"],
    ["instruction", "このログを確認する"],
  ]) {
    expect(
      await f.request("POST", "/conversations/parent/stock", {
        kind,
        text,
        quote: { kind: "terminal", mode: "line", text: "作業ログ" },
      }),
    ).toMatchObject({ status: 201 });
  }
}

function pendingStock(f: Awaited<ReturnType<typeof fixture>>) {
  return f.sqlite
    .prepare("SELECT kind,state FROM stock_items WHERE conversation_id='parent' ORDER BY kind")
    .all();
}

const sendStockInTest = (f: Awaited<ReturnType<typeof fixture>>, kinds: StockSendKind) =>
  f.request("POST", "/conversations/parent/stock/send", { kinds });

it("親に先に届いたストックは後から並んだ閉鎖より先に受け付ける", async () => {
  const f = await fixture();
  await seedStockParent(f);
  let unblock = () => {};
  const held = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const pending = f.runtime.serial("parent", async () => ok(await held));
  const serial = vi.spyOn(f.runtime, "serial");
  let sending: ReturnType<typeof f.request> | undefined;
  let closing: ReturnType<typeof f.request> | undefined;
  try {
    sending = sendStockInTest(f, "questions");
    await expect.poll(() => serial.mock.calls.map(([id]) => id)).toEqual(["parent"]);
    expect(f.runtime.releases.has("parent")).toBe(false);
    expect(f.runtime.store.get("parent")?.closedAt).toBeNull();

    closing = f.request("POST", "/conversations/parent/close", { stopIfWorking: false });
    await expect.poll(() => serial.mock.calls.map(([id]) => id)).toEqual(["parent", "parent"]);
    expect(f.runtime.releases.has("parent")).toBe(true);
    expect(f.runtime.store.get("parent")?.closedAt).toBeNull();
    unblock();

    expect(await sending).toMatchObject({ status: 200, body: { questions: [{ ok: true }] } });
    expect(await closing).toEqual({ status: 200, body: { closedAt } });
    expect(pendingStock(f)).toEqual([
      { kind: "instruction", state: "stocked" },
      { kind: "question", state: "sent" },
    ]);
    const children = f.sqlite
      .prepare("SELECT id FROM conversations WHERE parent_conversation_id='parent'")
      .all();
    expect(children).toHaveLength(1);
    expect(
      f.sqlite
        .prepare(
          "SELECT thread_conversation_id AS id FROM stock_items WHERE conversation_id='parent' AND kind='question'",
        )
        .all(),
    ).toEqual(children);
    expect(
      f.sqlite
        .prepare("SELECT key FROM settings WHERE key GLOB 'runner-stock-send:*:outcome:question:*'")
        .all(),
    ).toHaveLength(1);
  } finally {
    unblock();
    await Promise.allSettled([pending, sending, closing]);
    serial.mockRestore();
  }
}, 15_000);

const endingCases = [
  { operation: "close", kinds: "questions" },
  { operation: "close", kinds: "instructions" },
  { operation: "close", kinds: "all" },
  { operation: "delete", kinds: "all" },
  { operation: "conflict", kinds: "all" },
  { operation: "deadline", kinds: "all" },
] as const;

it.each(endingCases)(
  "終了予約を待つ間に届いたストックを受け付けない $operation $kinds",
  async ({ operation, kinds }) => {
    const clock = operation === "deadline" ? new WorkspaceClock() : undefined;
    const f = await fixture({ clock });
    await seedStockParent(f);
    f.addConversation("existing", { parentId: "parent" });
    const lastSeq = f.runtime.store.get("parent")?.lastSeq;

    let unblock = () => {};
    let entered = () => {};
    const held = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let busyChild: Response | undefined;
    let childPending: Promise<unknown> | undefined;
    if (operation === "delete") {
      f.beforeWithdraw(async () => {
        entered();
        await held;
      });
    } else if (operation === "conflict") {
      busyChild = await f.link.forward("POST", "/conversations/existing/release/reserve");
      expect(busyChild.status).toBe(200);
      f.beforeComplete(async (path) => {
        if (path !== "/conversations/parent/release/complete") return;
        entered();
        await held;
      });
    } else {
      childPending = f.runtime.serial("existing", async () => ok(await held));
    }
    const ending =
      operation === "delete"
        ? f.request("DELETE", "/conversations/parent")
        : f.request("POST", "/conversations/parent/close", { stopIfWorking: true });
    try {
      if (childPending) {
        await expect.poll(() => f.runtime.releases.has("existing")).toBe(true);
      } else {
        await waiting;
      }
      expect(f.runtime.releases.has("parent")).toBe(true);
      expect(f.runtime.store.get("parent")?.closedAt).toBeNull();
      const sending = sendStockInTest(f, kinds);
      await expect
        .poll(() => f.runnerRequests.includes("POST /conversations/parent/stock/send"))
        .toBe(true);
      if (clock) await clock.advance(10_001);
      unblock();
      await childPending;
      const end = await ending;
      const sent = await sending;
      if (operation === "delete") {
        expect(end).toEqual({ status: 200, body: { deleted: ["parent", "existing"] } });
        expect(sent).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
        expect(f.sqlite.prepare("SELECT id FROM conversations ORDER BY id").all()).toEqual([]);
      } else {
        expect(end.status).toBe(operation === "close" ? 200 : operation === "deadline" ? 503 : 409);
        expect(sent).toMatchObject({
          status: operation === "deadline" ? 503 : 409,
          body: { error: { code: operation === "deadline" ? "runner_unavailable" : "conflict" } },
        });
        expect(f.runtime.store.get("parent")).toMatchObject({
          closedAt: operation === "close" ? closedAt : null,
          lastSeq,
        });
        expect(
          f.sqlite
            .prepare(
              "SELECT id FROM conversations WHERE parent_conversation_id='parent' ORDER BY id",
            )
            .all(),
        ).toEqual([{ id: "existing" }]);
        expect(pendingStock(f)).toEqual([
          { kind: "instruction", state: "stocked" },
          { kind: "question", state: "stocked" },
        ]);
      }
      if (clock) {
        expect(
          f.sqlite
            .prepare("SELECT key FROM settings WHERE key GLOB 'runner-stock-send:*:outcome:*'")
            .all(),
        ).toEqual([]);
      } else {
        expect(
          f.sqlite.prepare("SELECT key FROM settings WHERE key GLOB 'runner-stock-send:*'").all(),
        ).toEqual([]);
      }
      if (busyChild) {
        const token: unknown = await busyChild.json();
        expect(
          (await f.link.forward("POST", "/conversations/existing/release/complete", token)).status,
        ).toBe(200);
        busyChild = undefined;
        expect(await sendStockInTest(f, kinds)).toMatchObject({ status: 200 });
      }
    } finally {
      unblock();
      if (busyChild)
        await f.link.forward(
          "POST",
          "/conversations/existing/release/complete",
          await busyChild.json(),
        );
    }
  },
  15_000,
);

const ordinaryCases = [
  { closed: false, kinds: "all" },
  { closed: true, kinds: "questions" },
  { closed: true, kinds: "instructions" },
  { closed: true, kinds: "all" },
] as const;

it.each(ordinaryCases)(
  "終了予約との競合がないストックを送る 閉鎖済み=$closed $kinds",
  async ({ closed, kinds }) => {
    const f = await fixture();
    await seedStockParent(f);
    if (closed) {
      expect(
        await f.request("POST", "/conversations/parent/close", { stopIfWorking: true }),
      ).toEqual({ status: 200, body: { closedAt } });
    }
    const sendQuestions = kinds !== "instructions";
    const sendInstructions = kinds !== "questions";
    expect(await sendStockInTest(f, kinds)).toMatchObject({
      status: 200,
      body: {
        questions: sendQuestions ? [{ ok: true }] : [],
        instructions: {
          count: Number(sendInstructions),
          delivery: sendInstructions ? "delivered" : null,
        },
      },
    });
    expect(f.runtime.store.get("parent")?.closedAt).toBe(
      closed && !sendInstructions ? closedAt : null,
    );
    expect(
      f.sqlite
        .prepare(
          "SELECT count(*) AS children FROM conversations WHERE parent_conversation_id='parent'",
        )
        .get(),
    ).toEqual({ children: Number(sendQuestions) });
    expect(pendingStock(f)).toEqual([
      { kind: "instruction", state: sendInstructions ? "sent" : "stocked" },
      { kind: "question", state: sendQuestions ? "sent" : "stocked" },
    ]);
  },
);
