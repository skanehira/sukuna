import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { startRunnerApp } from "../../../../runner/app";
import type { PublicConversation } from "../../../../shared/conversation/api";
import { openDatabase } from "../../../../shared/db/open";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
} from "../../../../shared/db/test-helpers";
import { readEnvironment } from "../../../../shared/env";
import { createWorktreeActivity } from "../../../../shared/workspace/sqlite-worktree-activity";
import { createApp } from "../../../app";
import { RunnerLink } from "../../../runner-link";
import { incomingWith } from "../../identity/test-support";
import {
  createWorkspaceAgent,
  WorkspaceClock,
} from "../../workspace/adapter/worktree-conversation-test-support";
import { createWorktreeDependencies } from "../../workspace/adapter/worktree-dependencies";
import { createGitCli, type GitRunner } from "../../workspace/adapter/git-cli";
import { createConversationDependencies } from "./dependencies";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function openProxy(path: string, upstreamPath: string) {
  const links = new Map<Socket, Socket>();
  const proxy = createServer((client) => {
    const upstream = connect(upstreamPath);
    links.set(client, upstream);
    client.on("error", () => client.destroy());
    upstream.on("error", () => upstream.destroy());
    client.on("close", () => {
      if (links.delete(client)) upstream.destroy();
    });
    upstream.on("close", () => {
      links.delete(client);
      client.destroy();
    });
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(path, resolve);
  });
  const disconnected = new Set<Socket>();
  return {
    path,
    holdReplies() {
      for (const [client, upstream] of links) upstream.unpipe(client);
    },
    disconnect() {
      for (const [client, upstream] of links) {
        links.delete(client);
        client.unpipe(upstream);
        upstream.unpipe(client);
        disconnected.add(upstream);
        upstream.once("close", () => disconnected.delete(upstream));
        client.destroy();
      }
    },
    async close() {
      for (const client of links.keys()) client.destroy();
      for (const upstream of disconnected) upstream.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    },
  };
}

async function fixture(
  options: { git?: GitRunner; deadlineClock?: boolean; proxy?: boolean } = {},
) {
  const home = realpathSync(createTempHome());
  const project = join(home, "project");
  mkdirSync(project);
  git(project, "init", "-b", "main");
  git(
    project,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "Initial",
  );

  const serverDb = openMigratedDatabase(home);
  const runnerDb = openDatabase(home);
  serverDb.sqlite
    .prepare("INSERT INTO projects (id,name,path,default_branch) VALUES ('p','Project',?,'main')")
    .run(project);
  const environment = readEnvironment(
    "runner",
    { SUKUNA_HOME: home },
    home,
    () => true,
  )._unsafeUnwrap();
  const sdk = createWorkspaceAgent("scripted");
  const clock = new WorkspaceClock();
  const date = new Date(2026, 10, 26, 10, 30);
  const runner = await startRunnerApp({
    database: runnerDb,
    agent: sdk.agent,
    environment,
    clock,
    log: () => {},
  });
  const notices: unknown[] = [];
  const linkClock = new WorkspaceClock();
  const proxy = options.proxy
    ? await openProxy(join(home, "test-ipc.sock"), environment.socket)
    : null;
  let connected = false;
  const link = new RunnerLink({
    socket: proxy?.path ?? environment.socket,
    ...(options.deadlineClock ? { clock: linkClock, now: clock.now } : {}),
    log: () => {},
    notice: (notice) => notices.push(notice),
    connection: (value) => {
      connected = value;
    },
  });
  const app = createApp({
    build: "test",
    conversations: createConversationDependencies({
      sqlite: serverDb.sqlite,
      home,
      runner: link,
      id: () => "image",
      now: clock.now,
      changed: () => {},
      reopened: () => {},
    }),
    worktrees: createWorktreeDependencies(() => serverDb, {
      now: () => date.getTime(),
      ...(options.git ? { git: options.git } : {}),
    }),
  });

  cleanups.push(async () => {
    link.stop();
    await proxy?.close();
    sdk.delayClose((finish) => finish());
    await runner.shutdown();
    await sdk.dispose();
    runnerDb.close();
    serverDb.close();
    removeTempHome(home);
  });

  link.start();
  await expect.poll(() => connected).toBe(true);

  async function request<T = unknown>(method: string, path: string, input?: unknown) {
    const response = await app.request(
      `/api${path}`,
      {
        method,
        ...(input === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(input) }),
      },
      incomingWith("127.0.0.1", 1),
    );
    const body: unknown = response.headers.get("content-type")?.includes("application/json")
      ? await response.json()
      : await response.text();
    return { status: response.status, body: body as T };
  }

  async function start(workspace: {
    kind: "project" | "new_worktree" | "worktree";
    name?: string;
    worktreeId?: string;
  }) {
    return request<{ conversation: PublicConversation }>("POST", "/conversations", {
      projectId: "p",
      workspace,
    });
  }

  async function startChat() {
    const response = await start({ kind: "project" });
    expect(response.status).toBe(201);
    return response.body.conversation.id;
  }

  async function waitFor(id: string, state: string) {
    await expect.poll(() => runner.runtime.store.get(id)?.runState).toBe(state);
  }

  async function send(id: string, text: string) {
    const response = await request("POST", `/conversations/${id}/messages`, {
      text,
      clientMessageId: text,
      images: [],
      mode: "send",
    });
    expect(response.status).toBe(202);
  }

  async function createWorktree(name: string) {
    const response = await request<{ id: string; path: string }>("POST", "/projects/p/worktrees", {
      name,
    });
    expect(response.status).toBe(201);
    return response.body;
  }

  function switchTo(id: string, worktreeId: string | null) {
    return request<{ conversation: PublicConversation }>("PUT", `/conversations/${id}/workspace`, {
      worktreeId,
    });
  }

  return {
    serverDb,
    runnerDb,
    project,
    runner,
    sdk,
    notices,
    clock,
    link,
    linkClock,
    proxy,
    request,
    start,
    startChat,
    waitFor,
    send,
    createWorktree,
    switchTo,
  };
}

it("名前を付けて新しい worktree で会話を始めると、空の会話の最初の指示がその場所で実行される", async () => {
  const f = await fixture();

  const response = await f.start({ kind: "new_worktree", name: "draft-api" });

  expect(response.status).toBe(201);
  const c = response.body.conversation;
  const path = join(f.project, ".claude/worktrees/draft-api");
  const worktree = f.serverDb.sqlite.prepare("SELECT id,path,branch FROM worktrees").get();
  expect(worktree).toEqual({ id: c.worktree?.id, path, branch: "draft-api" });
  expect(c).toMatchObject({
    kind: "chat",
    runState: "idle",
    lastSeq: 0,
    cwd: path,
    worktree: { name: "draft-api", branch: "draft-api" },
  });
  expect(f.runner.runtime.store.get(c.id)).toMatchObject({ cwd: path, worktreeId: c.worktree?.id });
  expect(f.sdk.opened).toEqual([]);
  expect(git(path, "branch", "--show-current")).toBe("draft-api");
  await f.send(c.id, "first");
  await f.waitFor(c.id, "idle");
  expect(f.sdk.opened).toMatchObject([{ cwd: path, resume: false }]);
  expect(f.runner.runtime.store.events(c.id)).toContainEqual(
    expect.objectContaining({
      type: "tool_result",
      payload: expect.objectContaining({ content: expect.stringContaining(path) }),
    }),
  );
});

it("名前を省くと、同時刻の未使用の番号で新たなブランチを作る", async () => {
  const f = await fixture();
  git(f.project, "branch", "chat-20261126-1030");
  await f.createWorktree("chat-20261126-1030-2");

  const response = await f.start({ kind: "new_worktree" });

  expect(response.status).toBe(201);
  expect(response.body.conversation).toMatchObject({
    cwd: join(f.project, ".claude/worktrees/chat-20261126-1030-3"),
    worktree: { name: "chat-20261126-1030-3", branch: "chat-20261126-1030-3" },
  });
  expect(
    f.serverDb.sqlite
      .prepare("SELECT branch_created FROM worktrees WHERE branch=?")
      .get("chat-20261126-1030-3"),
  ).toEqual({ branch_created: 1 });
});

it("既存 worktree の ID で会話を始めるとその場所を使い、存在しない ID には会話を作らない", async () => {
  const f = await fixture();
  const target = await f.createWorktree("existing");

  const response = await f.start({ kind: "worktree", worktreeId: target.id });
  const missing = await f.start({ kind: "worktree", worktreeId: "missing" });

  expect(response.status).toBe(201);
  expect(response.body.conversation).toMatchObject({
    cwd: target.path,
    worktree: { id: target.id },
  });
  await f.send(response.body.conversation.id, "existing-first");
  await f.waitFor(response.body.conversation.id, "idle");
  expect(f.sdk.opened).toMatchObject([{ cwd: target.path }]);
  expect(missing).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
  expect(f.serverDb.sqlite.prepare("SELECT COUNT(*) AS n FROM conversations").get()).toEqual({
    n: 1,
  });
});

it("Git リポジトリではない場所から worktree を作ると Git の理由を返し、会話を残さない", async () => {
  const f = await fixture();
  const path = join(f.project, "../not-git");
  mkdirSync(path);
  f.serverDb.sqlite.prepare("UPDATE projects SET path=? WHERE id='p'").run(path);

  const response = await f.start({ kind: "new_worktree", name: "fail" });

  expect(response).toMatchObject({
    status: 500,
    body: {
      error: {
        code: "worktree_failed",
        message: expect.stringMatching(/^fatal: .*git repository/i),
      },
    },
  });
  expect(f.serverDb.sqlite.prepare("SELECT COUNT(*) AS n FROM conversations").get()).toEqual({
    n: 0,
  });
});

it("待機中の会話を切り替えると実行を閉じ、同じ SDK セッションで新しい場所に配達する", async () => {
  const f = await fixture();
  const id = await f.startChat();
  const target = await f.createWorktree("next");
  await f.send(id, "first");
  await f.waitFor(id, "idle");
  const previous = f.runner.runtime.store.get(id)!;

  const changed = await f.switchTo(id, target.id);

  expect(changed).toMatchObject({
    status: 200,
    body: { conversation: { id, cwd: target.path, worktree: { id: target.id } } },
  });
  expect(f.sdk.closed).toEqual([0]);
  expect(f.runner.runtime.store.get(id)).toMatchObject({
    cwd: target.path,
    worktreeId: target.id,
    sessionId: previous.sessionId,
  });
  await expect
    .poll(() => f.notices)
    .toContainEqual({ kind: "conversation_parts", conversation_id: id, parts: [] });
  await f.send(id, "second");
  await f.waitFor(id, "idle");
  expect(f.sdk.opened).toMatchObject([
    { cwd: f.project },
    { cwd: target.path, resume: true, sessionId: previous.sessionId },
  ]);
  expect(f.sdk.delivered.map((message) => message.text)).toEqual(["first", "second"]);
  expect(await f.switchTo(id, null)).toMatchObject({
    status: 200,
    body: { conversation: { cwd: f.project, worktree: null } },
  });
  expect(f.runner.runtime.store.get(id)).toMatchObject({ cwd: f.project, worktreeId: null });
});

it.each([
  ["working", "chat"],
  ["waiting_answer", "chat"],
  ["waiting_permission", "chat"],
  ["idle", "thread"],
])("runState=%s・kind=%s では切り替えずに競合を返す", async (state, kind) => {
  const f = await fixture();
  const id = await f.startChat();
  const target = await f.createWorktree("blocked");
  f.serverDb.sqlite
    .prepare("UPDATE conversations SET kind=?,run_state=? WHERE id=?")
    .run(kind, state, id);
  const previous = f.runner.runtime.store.get(id);

  expect(await f.switchTo(id, target.id)).toMatchObject({
    status: 409,
    body: { error: { code: "conflict" } },
  });
  expect(f.runner.runtime.store.get(id)).toEqual(previous);
});

it("利用枠待ちのタイマーを保ち、利用枠が戻ると切り替え先で同じセッションを再開する", async () => {
  const f = await fixture();
  const id = await f.startChat();
  const target = await f.createWorktree("limit");
  await f.send(id, "first-usage");
  await f.waitFor(id, "usage_limited");
  const previous = f.runner.runtime.store.get(id)!;
  expect(f.clock.timers.size).toBe(1);

  expect(await f.switchTo(id, target.id)).toMatchObject({
    status: 200,
    body: {
      conversation: { cwd: target.path, runState: "usage_limited", resetsAt: previous.resetsAt },
    },
  });

  expect(f.clock.timers.size).toBe(1);
  await f.clock.advance(69000);
  await f.waitFor(id, "idle");
  expect(f.sdk.opened).toMatchObject([
    { cwd: f.project },
    { cwd: target.path, resume: true, sessionId: previous.sessionId },
  ]);
});

it.each(["folder missing", "another project"])(
  "worktree が %s のときは開始も切り替えもできない",
  async (condition) => {
    const f = await fixture();
    const id = await f.startChat();
    const target = await f.createWorktree("not-selectable");
    if (condition === "folder missing") {
      git(f.project, "worktree", "remove", target.path);
    } else {
      f.serverDb.sqlite
        .prepare(
          "INSERT INTO projects (id,name,path,default_branch) VALUES ('other','Other',?,'main')",
        )
        .run(join(f.project, "../other"));
      f.serverDb.sqlite
        .prepare("UPDATE worktrees SET project_id='other' WHERE id=?")
        .run(target.id);
    }
    const previous = f.runner.runtime.store.get(id);

    const unavailable = { status: 404, body: { error: { code: "not_found" } } };
    expect(await f.start({ kind: "worktree", worktreeId: target.id })).toMatchObject(unavailable);
    expect(await f.switchTo(id, target.id)).toMatchObject(unavailable);
    expect(f.runner.runtime.store.get(id)).toEqual(previous);
    expect(f.serverDb.sqlite.prepare("SELECT COUNT(*) AS n FROM conversations").get()).toEqual({
      n: 1,
    });
  },
);

it("削除済みの worktree ID を拒否し、同じパスに作り直された新しい ID は受け入れる", async () => {
  const f = await fixture();
  const id = await f.startChat();
  const old = await f.createWorktree("replaced");
  expect((await f.request("DELETE", `/worktrees/${old.id}`)).status).toBe(200);
  const replacement = await f.createWorktree("replaced");
  const previous = f.runner.runtime.store.get(id);

  expect(replacement).toMatchObject({ path: old.path });
  expect(replacement.id).not.toBe(old.id);
  expect(await f.switchTo(id, old.id)).toMatchObject({
    status: 404,
    body: { error: { code: "not_found" } },
  });
  expect(f.runner.runtime.store.get(id)).toEqual(previous);
  expect(await f.switchTo(id, replacement.id)).toMatchObject({
    status: 200,
    body: { conversation: { cwd: old.path, worktree: { id: replacement.id } } },
  });
});

it("別 SQLite 接続の削除用排他を、移動元の照合済み ID と移動先の双方で尊重する", async () => {
  const f = await fixture();
  const id = await f.startChat();
  const source = await f.createWorktree("source");
  const target = await f.createWorktree("target");
  const unrelated = await f.createWorktree("unrelated");
  f.serverDb.sqlite
    .prepare("UPDATE conversations SET cwd=?,worktree_id=NULL WHERE id=?")
    .run(source.path, id);
  const previous = f.runner.runtime.store.get(id);
  const activity = createWorktreeActivity(f.serverDb.sqlite.name);

  for (const blocked of [source.id, target.id]) {
    const lease = activity.acquire([blocked])._unsafeUnwrap();
    try {
      expect(await f.switchTo(id, target.id)).toMatchObject({
        status: 409,
        body: { error: { code: "conflict" } },
      });
      expect(f.runner.runtime.store.get(id)).toEqual(previous);
    } finally {
      lease.release();
    }
  }
  const lockedDuringUpdate: string[] = [];
  f.runnerDb.sqlite.function("check_workspace_leases", () => {
    for (const id of [source.id, target.id]) {
      const other = activity.acquire([id]);
      if (other.isErr() && other.error.code === "conflict") lockedDuringUpdate.push(id);
      else if (other.isOk()) other.value.release();
    }
    return null;
  });
  f.runnerDb.sqlite.exec(`
    CREATE TEMP TRIGGER check_workspace_update
    BEFORE UPDATE OF cwd ON conversations
    BEGIN SELECT check_workspace_leases(); END;
  `);
  const lease = activity.acquire([unrelated.id])._unsafeUnwrap();
  try {
    expect(await f.switchTo(id, target.id)).toMatchObject({
      status: 200,
      body: { conversation: { cwd: target.path, worktree: { id: target.id } } },
    });
    expect(lockedDuringUpdate).toEqual([source.id, target.id]);
    activity.acquire([source.id, target.id])._unsafeUnwrap().release();
  } finally {
    lease.release();
  }
});

it("古い実行を閉じている間に別接続が移動先を削除すると、切り替えは競合として何も変更しない", async () => {
  const f = await fixture();
  const id = await f.startChat();
  const target = await f.createWorktree("removed-while-switching");
  await f.send(id, "first");
  await f.waitFor(id, "idle");
  const previous = f.runner.runtime.store.get(id);
  let didClose: (finish: () => void) => void;
  const closing = new Promise<() => void>((resolve) => {
    didClose = resolve;
  });
  f.sdk.delayClose((finish) => didClose(finish));

  const pending = f.switchTo(id, target.id);
  const reachedClose = await Promise.race([
    closing.then((finish) => ({ finish })),
    pending.then((response) => ({ response })),
  ]);
  expect(reachedClose).toHaveProperty("finish");
  if (!("finish" in reachedClose)) return;
  try {
    expect((await f.request("DELETE", `/worktrees/${target.id}`)).status).toBe(200);
  } finally {
    reachedClose.finish();
  }
  expect(await pending).toMatchObject({ status: 409, body: { error: { code: "conflict" } } });
  expect(f.runner.runtime.store.get(id)).toEqual(previous);
});

it("同じ分に名前を省いて会話を始めると、別々の最小空き名で両方の会話が作られる", async () => {
  const actualGit = createGitCli();
  let checked = 0;
  let resumeBoth: () => void;
  const checkedBoth = new Promise<void>((resolve) => {
    resumeBoth = resolve;
  });
  const f = await fixture({
    git: {
      async run(args, options) {
        const result = await actualGit.run(args, options);
        if (args[0] === "show-ref" && args.at(-1) === "refs/heads/chat-20261126-1030") {
          if (++checked === 2) resumeBoth();
          await checkedBoth;
        }
        return result;
      },
    },
  });

  const results = await Promise.all([
    f.start({ kind: "new_worktree" }),
    f.start({ kind: "new_worktree" }),
  ]);

  expect(results.map((result) => result.status)).toEqual([201, 201]);
  const created = results.map(({ body }) => body.conversation);
  expect(new Set(created.map(({ id }) => id)).size).toBe(2);
  expect(new Set(created.map(({ worktree }) => worktree?.id)).size).toBe(2);
  expect(created.map(({ worktree }) => worktree!.name).sort((a, b) => a.localeCompare(b))).toEqual([
    "chat-20261126-1030",
    "chat-20261126-1030-2",
  ]);
  for (const { id, cwd, worktree } of created) {
    expect(cwd).toBe(join(f.project, ".claude/worktrees", worktree!.name));
    expect(f.runner.runtime.store.get(id)).toMatchObject({ cwd, worktreeId: worktree!.id });
    expect(git(cwd, "branch", "--show-current")).toBe(worktree!.name);
  }
});

it("明示名が同じ場合は片方だけが作られ、もう片方は同名の競合を返す", async () => {
  const f = await fixture();

  const results = await Promise.all([
    f.start({ kind: "new_worktree", name: "explicit" }),
    f.start({ kind: "new_worktree", name: "explicit" }),
  ]);

  expect(results.map(({ status }) => status).sort((a, b) => a - b)).toEqual([201, 409]);
  expect(results.find((result) => result.status === 409)?.body).toMatchObject({
    error: { code: "conflict" },
  });
  expect(
    f.serverDb.sqlite.prepare("SELECT branch FROM worktrees WHERE removed_at IS NULL").all(),
  ).toEqual([{ branch: "explicit" }]);
});

it("Git 追加直前に自動名のブランチが作られると、失敗した予約を解除して次の名前を作る", async () => {
  const actualGit = createGitCli();
  let collision = false;
  const f = await fixture({
    git: {
      async run(args, options) {
        if (
          !collision &&
          args[0] === "worktree" &&
          args[1] === "add" &&
          args[3] === "chat-20261126-1030"
        ) {
          collision = true;
          git(options.cwd, "branch", "chat-20261126-1030");
        }
        return actualGit.run(args, options);
      },
    },
  });

  const result = await f.start({ kind: "new_worktree" });

  expect(collision).toBe(true);
  expect(result).toMatchObject({
    status: 201,
    body: { conversation: { worktree: { name: "chat-20261126-1030-2" } } },
  });
  expect(
    f.serverDb.sqlite
      .prepare("SELECT branch, removed_at IS NULL AS live FROM worktrees ORDER BY branch")
      .all(),
  ).toEqual([
    { branch: "chat-20261126-1030", live: 0 },
    { branch: "chat-20261126-1030-2", live: 1 },
  ]);
});

it.each(["project", "worktree"] as const)(
  "Git で移動元を消した会話は %s に切り替え、同じセッションで次の指示を受け取る",
  async (targetKind) => {
    const f = await fixture();
    const source = await f.createWorktree("external-remove");
    const target = targetKind === "worktree" ? await f.createWorktree("retained-worktree") : null;
    const started = await f.start({ kind: "worktree", worktreeId: source.id });
    expect(started.status).toBe(201);
    const id = started.body.conversation.id;
    await f.send(id, "first");
    await f.waitFor(id, "idle");
    const previous = f.runner.runtime.store.get(id)!;
    git(f.project, "worktree", "remove", source.path);

    const response = await f.switchTo(id, target?.id ?? null);

    const cwd = target?.path ?? f.project;
    expect(response).toMatchObject({ status: 200, body: { conversation: { id, cwd } } });
    expect(f.runner.runtime.store.get(id)).toMatchObject({
      cwd,
      worktreeId: target?.id ?? null,
      sessionId: previous.sessionId,
    });
    await f.send(id, "next");
    await f.waitFor(id, "idle");
    expect(f.sdk.opened).toMatchObject([
      { cwd: source.path },
      { cwd, resume: true, sessionId: previous.sessionId },
    ]);
  },
);

it.each([
  { name: "期限内", clientElapsed: 9999, runnerElapsed: 9999, status: 200 },
  { name: "期限と切断の両方", clientElapsed: 10000, runnerElapsed: 10000, status: 503 },
  { name: "ランナー側の期限が先", clientElapsed: 9999, runnerElapsed: 10000, status: 503 },
  { name: "ソケット切断が先", clientElapsed: 10000, runnerElapsed: 9999, status: 503 },
])(
  "実行の終了待ち中に $name なら $status を返し、次の指示が確定した場所で動く",
  async ({ clientElapsed, runnerElapsed, status }) => {
    const f = await fixture({ deadlineClock: true });
    const id = await f.startChat();
    const target = await f.createWorktree("deadline-target");
    await f.send(id, "first");
    await f.waitFor(id, "idle");
    const previous = f.runner.runtime.store.get(id)!;
    let didClose: (finish: () => void) => void;
    const closing = new Promise<() => void>((resolve) => {
      didClose = resolve;
    });
    f.sdk.delayClose((finish) => didClose(finish));

    const pending = f.switchTo(id, target.id);
    const reachedClose = await Promise.race([
      closing.then((finish) => ({ finish })),
      pending.then((response) => ({ response })),
    ]);
    expect(reachedClose).toHaveProperty("finish");
    if (!("finish" in reachedClose)) return;
    try {
      await f.clock.advance(runnerElapsed);
      await f.linkClock.advance(clientElapsed);
      if (clientElapsed === 10000) {
        expect(await pending).toMatchObject({
          status,
          body: { error: { code: "runner_unavailable" } },
        });
        expect(f.runner.runtime.store.get(id)).toEqual(previous);
        expect((await f.link.call("GET", "/health"))._unsafeUnwrap().status).toBe(200);
      }
    } finally {
      reachedClose.finish();
    }

    const expired = status === 503;
    expect(await pending).toMatchObject(
      expired
        ? { status, body: { error: { code: "runner_unavailable" } } }
        : { status, body: { conversation: { cwd: target.path } } },
    );
    await f.send(id, "after-deadline");
    await f.waitFor(id, "idle");
    const cwd = expired ? f.project : target.path;
    const event = { kind: "conversation_parts", conversation_id: id, parts: [] };
    const lastSeq = f.runner.runtime.store.get(id)!.lastSeq;
    await expect
      .poll(() => f.notices)
      .toContainEqual(
        expect.objectContaining({ kind: "conversation", conversation_id: id, seq: lastSeq }),
      );
    if (expired) expect(f.notices).not.toContainEqual(event);
    else expect(f.notices).toContainEqual(event);
    expect(f.runner.runtime.store.get(id)).toMatchObject({ cwd, sessionId: previous.sessionId });
    expect(f.sdk.opened).toMatchObject([
      { cwd: f.project },
      { cwd, resume: true, sessionId: previous.sessionId },
    ]);
  },
);

it.each([
  { elapsed: 9999, status: 200 },
  { elapsed: 10000, status: 503 },
])(
  "SQLite の更新が $elapsed ms に終われば $status を返し、確定した作業場所で次の指示を受け取る",
  async ({ elapsed, status }) => {
    const f = await fixture({ deadlineClock: true });
    const source = await f.createWorktree("before-write");
    const target = await f.createWorktree("after-write");
    const started = await f.start({ kind: "worktree", worktreeId: source.id });
    expect(started.status).toBe(201);
    const id = started.body.conversation.id;
    await f.send(id, "first");
    await f.waitFor(id, "idle");
    const before = f.runner.runtime.store.get(id)!;
    let didClose: (finish: () => void) => void;
    const closing = new Promise<() => void>((resolve) => {
      didClose = resolve;
    });
    f.sdk.delayClose((finish) => didClose(finish));

    const activity = createWorktreeActivity(f.serverDb.sqlite.name);
    const writeTimes: number[] = [];
    const locked: string[] = [];
    const startTime = f.clock.time;
    f.runnerDb.sqlite.function("advance_workspace_write", () => {
      writeTimes.push(f.clock.time - startTime);
      for (const worktreeId of [source.id, target.id]) {
        const result = activity.acquire([worktreeId]);
        if (result.isErr() && result.error.code === "conflict") locked.push(worktreeId);
        else if (result.isOk()) result.value.release();
      }
      void f.clock.advance(elapsed - 9998);
      void f.linkClock.advance(elapsed - 9998);
      return null;
    });
    f.runnerDb.sqlite.exec(`
      CREATE TEMP TRIGGER finish_workspace_write
      AFTER UPDATE OF cwd ON conversations
      BEGIN SELECT advance_workspace_write(); END;
    `);

    const pending = f.switchTo(id, target.id);
    const boundary = await Promise.race([
      closing.then((finish) => ({ finish })),
      pending.then((response) => ({ response })),
    ]);
    expect(boundary).toHaveProperty("finish");
    if (!("finish" in boundary)) return;
    try {
      await f.clock.advance(9998);
      await f.linkClock.advance(9998);
    } finally {
      boundary.finish();
    }

    const after = status === 200 ? target : source;
    expect(await pending).toMatchObject(
      status === 200
        ? { status, body: { conversation: { cwd: target.path, worktree: { id: target.id } } } }
        : { status, body: { error: { code: "runner_unavailable" } } },
    );
    expect(writeTimes).toEqual([9998]);
    expect(locked).toEqual([source.id, target.id]);
    activity.acquire([source.id, target.id])._unsafeUnwrap().release();
    expect(f.runner.runtime.store.get(id)).toMatchObject({
      cwd: after.path,
      worktreeId: after.id,
      sessionId: before.sessionId,
    });
    await f.send(id, "after-write");
    await f.waitFor(id, "idle");
    expect(f.sdk.opened).toMatchObject([
      { cwd: source.path },
      { cwd: after.path, resume: true, sessionId: before.sessionId },
    ]);
    const lastSeq = f.runner.runtime.store.get(id)!.lastSeq;
    await expect
      .poll(() => f.notices)
      .toContainEqual(
        expect.objectContaining({ kind: "conversation", conversation_id: id, seq: lastSeq }),
      );
    const notice = { kind: "conversation_parts", conversation_id: id, parts: [] };
    if (status === 200) expect(f.notices).toContainEqual(notice);
    else expect(f.notices).not.toContainEqual(notice);
  },
);

it("作業場所の書き込み中にSQLite自体が失敗すれば、期限と重なっても内部エラーを返す", async () => {
  const f = await fixture({ deadlineClock: true });
  const id = await f.startChat();
  const target = await f.createWorktree("write-failure");
  const before = f.runner.runtime.store.get(id);
  const startTime = f.clock.time;
  f.runnerDb.sqlite.function("expire_workspace_write", () => {
    f.clock.time = startTime + 10000;
    return null;
  });
  f.runnerDb.sqlite.exec(`
    CREATE TEMP TRIGGER reject_workspace_write
    AFTER UPDATE OF cwd ON conversations
    BEGIN
      SELECT expire_workspace_write();
      SELECT RAISE(ABORT, 'SQLite write rejected');
    END;
  `);

  expect(await f.switchTo(id, target.id)).toMatchObject({
    status: 500,
    body: { error: { code: "internal" } },
  });

  expect(f.clock.time - startTime).toBe(10000);
  expect(f.runner.runtime.store.get(id)).toEqual(before);
  f.runnerDb.sqlite.exec("DROP TRIGGER reject_workspace_write");
  expect(await f.switchTo(id, target.id)).toMatchObject({
    status: 200,
    body: { conversation: { cwd: target.path } },
  });
});

it.each(["timeout", "disconnect"] as const)(
  "コミット直後に IPC の返信が %s で失われても、確定した切り替えを200で返す",
  async (transport) => {
    const f = await fixture({ deadlineClock: true, proxy: transport === "disconnect" });
    const initial = await f.createWorktree("committed-source");
    const target = await f.createWorktree("committed-target");
    const started = await f.start({ kind: "worktree", worktreeId: initial.id });
    expect(started.status).toBe(201);
    const id = started.body.conversation.id;
    await f.send(id, "before");
    await f.waitFor(id, "idle");
    const before = f.runner.runtime.store.get(id)!;
    let observed: unknown;
    f.runner.runtime.subscribe((signal) => {
      if (signal.type !== "parts" || signal.conversationId !== id) return;
      observed = f.serverDb.sqlite
        .prepare("SELECT cwd,worktree_id FROM conversations WHERE id=?")
        .get(id);
      if (transport === "timeout") void f.linkClock.advance(10000);
      else f.proxy!.disconnect();
    });

    const response = await f.switchTo(id, target.id);

    expect(observed).toEqual({ cwd: target.path, worktree_id: target.id });
    expect(response).toMatchObject({
      status: 200,
      body: { conversation: { id, cwd: target.path, worktree: { id: target.id } } },
    });
    await f.send(id, "after");
    await f.waitFor(id, "idle");
    expect(f.sdk.opened.at(-1)).toMatchObject({
      cwd: target.path,
      sessionId: before.sessionId,
      resume: true,
    });
  },
);

it.each(["timeout", "disconnect"] as const)(
  "コミット前に IPC が %s になった要求は503を返し、実行の終了後にも更新しない",
  async (transport) => {
    const f = await fixture({ deadlineClock: true, proxy: transport === "disconnect" });
    const id = await f.startChat();
    const target = await f.createWorktree("uncommitted-target");
    await f.send(id, "before");
    await f.waitFor(id, "idle");
    const before = f.runner.runtime.store.get(id)!;
    let didClose: (finish: () => void) => void;
    const closing = new Promise<() => void>((resolve) => {
      didClose = resolve;
    });
    f.sdk.delayClose((finish) => didClose(finish));
    const notices: string[] = [];
    f.runner.runtime.subscribe((signal) => {
      if (signal.type === "parts") notices.push(signal.conversationId);
    });
    const pending = f.switchTo(id, target.id);
    const boundary = await Promise.race([
      closing.then((finish) => ({ finish })),
      pending.then((response) => ({ response })),
    ]);
    expect(boundary).toHaveProperty("finish");
    if (!("finish" in boundary)) return;
    try {
      if (transport === "timeout") {
        await f.clock.advance(10000);
        await f.linkClock.advance(10000);
      } else {
        f.proxy!.disconnect();
      }
      expect(await pending).toMatchObject({
        status: 503,
        body: { error: { code: "runner_unavailable" } },
      });
    } finally {
      boundary.finish();
    }

    await f.send(id, "after");
    await f.waitFor(id, "idle");
    expect(f.runner.runtime.store.get(id)).toMatchObject({ cwd: f.project, worktreeId: null });
    expect(f.sdk.opened.at(-1)).toMatchObject({
      cwd: f.project,
      sessionId: before.sessionId,
      resume: true,
    });
    expect(notices).toEqual([]);
  },
);

it("同じ会話と移動先の確定済み応答を、切断された後続要求の応答に取り違えない", async () => {
  const f = await fixture({ deadlineClock: true, proxy: true });
  const id = await f.startChat();
  const target = await f.createWorktree("same-target");
  expect(await f.switchTo(id, target.id)).toMatchObject({
    status: 200,
    body: { conversation: { cwd: target.path, worktree: { id: target.id } } },
  });
  await f.send(id, "before");
  await f.waitFor(id, "idle");
  let didClose: (finish: () => void) => void;
  const closing = new Promise<() => void>((resolve) => {
    didClose = resolve;
  });
  f.sdk.delayClose((finish) => didClose(finish));
  const notices: string[] = [];
  f.runner.runtime.subscribe((signal) => {
    if (signal.type === "parts") notices.push(signal.conversationId);
  });
  const pending = f.switchTo(id, target.id);
  const boundary = await Promise.race([
    closing.then((finish) => ({ finish })),
    pending.then((response) => ({ response })),
  ]);
  expect(boundary).toHaveProperty("finish");
  if (!("finish" in boundary)) return;
  try {
    f.proxy!.disconnect();
    expect(await pending).toMatchObject({
      status: 503,
      body: { error: { code: "runner_unavailable" } },
    });
  } finally {
    boundary.finish();
  }

  await f.send(id, "after");
  await f.waitFor(id, "idle");
  expect(f.runner.runtime.store.get(id)).toMatchObject({ cwd: target.path, worktreeId: target.id });
  expect(notices).toEqual([]);
});

it("後続の切り替えが確定していても、先行要求に確定時の状態を返せる", async () => {
  const f = await fixture({ deadlineClock: true, proxy: true });
  const id = await f.startChat();
  const first = await f.createWorktree("first-target");
  const second = await f.createWorktree("second-target");
  let markCommitted: () => void;
  const committing = new Promise<void>((resolve) => {
    markCommitted = resolve;
  });
  const off = f.runner.runtime.subscribe((signal) => {
    if (signal.type !== "parts" || signal.conversationId !== id) return;
    off();
    f.proxy!.holdReplies();
    markCommitted();
  });
  let firstResponded = false;
  const firstReply = f.switchTo(id, first.id).then((response) => {
    firstResponded = true;
    return response;
  });
  expect(await Promise.race([committing.then(() => true), firstReply.then(() => false)])).toBe(
    true,
  );

  expect(await f.switchTo(id, second.id)).toMatchObject({
    status: 200,
    body: { conversation: { cwd: second.path, worktree: { id: second.id } } },
  });
  expect(firstResponded).toBe(false);
  f.proxy!.disconnect();

  expect(await firstReply).toMatchObject({
    status: 200,
    body: { conversation: { cwd: first.path, worktree: { id: first.id } } },
  });
  expect(f.runner.runtime.store.get(id)).toMatchObject({ cwd: second.path, worktreeId: second.id });
});

it("確定結果を共有 SQLite から確認できないときは、未変更を保証する503ではなく結果不明の500を返す", async () => {
  const f = await fixture({ deadlineClock: true });
  const id = await f.startChat();
  const target = await f.createWorktree("unreadable-result");
  const off = f.runner.runtime.subscribe((signal) => {
    if (signal.type !== "parts" || signal.conversationId !== id) return;
    off();
    f.serverDb.sqlite.close();
    void f.linkClock.advance(10000);
  });

  expect(await f.switchTo(id, target.id)).toMatchObject({
    status: 500,
    body: { error: { code: "internal", message: expect.stringContaining("会話を読み直して") } },
  });

  expect(f.runner.runtime.store.get(id)).toMatchObject({ cwd: target.path, worktreeId: target.id });
});

it.each([
  { elapsed: 59999, status: 200 },
  { elapsed: 60000, status: 500 },
])(
  "確定からの返信を失い、発行から $elapsed ms で照会すると $status を返す",
  async ({ elapsed, status }) => {
    const f = await fixture({ deadlineClock: true, proxy: true });
    const id = await f.startChat();
    const target = await f.createWorktree("receipt-retention");
    const off = f.runner.runtime.subscribe((signal) => {
      if (signal.type !== "parts" || signal.conversationId !== id) return;
      off();
      void f.clock.advance(elapsed);
      f.proxy!.disconnect();
    });

    const response = await f.switchTo(id, target.id);

    expect(response.status).toBe(status);
    if (status === 200) {
      expect(response.body).toMatchObject({
        conversation: { id, cwd: target.path, worktree: { id: target.id } },
      });
    } else {
      expect(response.body).toEqual({
        error: {
          code: "internal",
          message: "作業場所の切り替え結果を確かめられませんでした。会話を読み直してください。",
        },
      });
    }
    expect(f.runner.runtime.store.get(id)).toMatchObject({
      cwd: target.path,
      worktreeId: target.id,
    });
  },
);

it("次の切り替えで期限を迎えた操作記録だけを掃除する", async () => {
  const f = await fixture({ deadlineClock: true });
  const id = await f.startChat();
  const target = await f.createWorktree("first-receipt");
  const newer = await f.createWorktree("newer-receipt");
  const keys = () =>
    (
      f.serverDb.sqlite.prepare("SELECT key FROM settings ORDER BY key").all() as { key: string }[]
    ).map(({ key }) => key);

  expect((await f.switchTo(id, target.id)).status).toBe(200);
  const [old] = keys();
  await f.clock.advance(1);
  expect((await f.switchTo(id, newer.id)).status).toBe(200);
  const [stillValid] = keys().filter((key) => key !== old);
  f.serverDb.sqlite
    .prepare("INSERT INTO settings (key,value) VALUES ('setting-control',?)")
    .run('{"expiresAt":1}');
  await f.clock.advance(59999);

  expect((await f.switchTo(id, null)).status).toBe(200);

  const stored = keys();
  expect(stored).toContain("setting-control");
  expect(stored).not.toContain(old);
  expect(stored).toContain(stillValid);
  expect(stored.filter((key) => key.startsWith("runner-workspace-switch:"))).toHaveLength(2);
});
