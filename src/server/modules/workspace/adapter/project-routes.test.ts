import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ok } from "neverthrow";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { startRunnerApp } from "../../../../runner/app";
import { ScriptedAgent } from "../../../../runner/modules/conversation/adapter/scripted-agent";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
} from "../../../../shared/db/test-helpers";
import { openDatabase } from "../../../../shared/db/open";
import { notifications } from "../../../../shared/db/schema";
import { createInboxRepository } from "../../inbox/adapter/inbox-repository";
import { ScriptedGh } from "../../../../shared/gh/scripted-gh";
import { createApp } from "../../../app";
import { RunnerLink, runnerUnavailable } from "../../../runner-link";
import { WsHub } from "../../../ws-hub";
import { incomingWith } from "../../identity/test-support";
import { createProjectDependencies } from "./project-dependencies";
import { createWorktreeDependencies } from "./worktree-dependencies";
import { WorkspaceClock } from "./worktree-conversation-test-support";
import { directoriesIn, testEnvironment } from "../../../../test/directories";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Example",
      "-c",
      "user.email=dev@example.invalid",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trimEnd();
}

const ghLoginNote = "gh にログインしていません。ターミナルで gh auth login を実行してください";
const rootNote = "リポジトリの最上位のパスで登録しました";
const defaultSettings = {
  usesGithub: false,
  defaultBranch: "main",
  model: null,
  permissionMode: "bypassPermissions",
  autoStages: ["triage", "design", "impl"],
  designMergeMode: "direct",
  implConcurrency: 5,
  confirmBeforeMergeDefault: false,
  flowPaused: false,
  globalFlowPaused: false,
  stopTargetCount: 0,
};

async function fixture(options: { ghExit?: number; ghStderr?: string } = {}) {
  const home = realpathSync(createTempHome());
  cleanups.push(() => removeTempHome(home));
  const repository = join(home, "shop-api");
  mkdirSync(repository);
  writeFileSync(join(repository, "README.md"), "fixture\n");
  git(repository, "init", "-b", "main");
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "fixture");
  const database = openMigratedDatabase(home);
  cleanups.push(() => database.close());
  const clock = new WorkspaceClock();
  const environment = testEnvironment(home);
  const agent = new ScriptedAgent({
    rules: [
      {
        match: "^limit$",
        steps: [{ rate_limit: { status: "rejected", resetsAt: 5 } }, { end: "success" }],
      },
    ],
    fallback: [{ text: "作業中" }, { hold: true }],
  });
  const runner = await startRunnerApp({ database, environment, log: () => {}, clock, agent });
  cleanups.push(() => runner.shutdown());
  const link = new RunnerLink({
    socket: environment.socket,
    now: clock.now,
    log: () => {},
    notice: () => {},
    connection: () => {},
  });
  const disconnected = new RunnerLink({
    socket: join(home, "missing.sock"),
    now: clock.now,
    log: () => {},
    notice: () => {},
    connection: () => {},
  });
  const calls: { method: string; path: string; input?: unknown }[] = [];
  let unavailable = false;
  let beforeStop: (() => Promise<void>) | undefined;
  let afterStop: (() => Promise<void>) | undefined;
  const forward = async (method: string, path: string, input?: unknown) => {
    calls.push({ method, path, ...(input === undefined ? {} : { input }) });
    if (path === "/flow/notify") return Response.json({});
    await beforeStop?.();
    if (unavailable) {
      const result = await disconnected.call(method, path, input);
      if (result.isErr()) return Response.json({ error: result.error }, { status: 503 });
      throw new Error("存在しないソケットへ接続しました");
    }
    const response = (await link.call(method, path, input))._unsafeUnwrap();
    await afterStop?.();
    return Response.json(response.body, { status: response.status });
  };
  const gh = new ScriptedGh({
    fallback: { stdout: "", stderr: "unexpected gh command", exit_code: 1 },
    responses: [
      {
        match: "^repo view",
        stdout: "{}",
        stderr: options.ghStderr ?? "",
        exit_code: options.ghExit ?? 0,
      },
    ],
  });
  const hub = new WsHub(database.sqlite, {
    inbox: { repository: createInboxRepository(() => database.db), resetTime: () => "" },
    now: clock.now,
    id: () => "new-notice",
  });
  const messages: unknown[] = [];
  const client = {
    bufferedAmount: 0,
    send: (data: string) => messages.push(JSON.parse(data)),
    close: () => {},
  };
  hub.add(client);
  hub.receive(client, { op: "subscribe", topic: "inbox" });
  let projectNumber = 0;
  const app = createApp({
    build: "test",
    projects: createProjectDependencies(() => database, {
      runner: () => ({ forward }),
      changed: (id) => hub.notice({ kind: "project", project_id: id }),
      notifications: {
        dismissProject: (id, at) => hub.projectRemoved(id, at),
        restoreProject: (id) => hub.projectRestored(id),
      },
      gh,
      home,
      now: clock.now,
      id: () => `p${++projectNumber}`,
    }),
    worktrees: createWorktreeDependencies(() => database, { gh, now: clock.now }),
  });
  async function request(path: string, method = "GET", body?: unknown) {
    const response = await app.request(
      path,
      {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      },
      incomingWith("127.0.0.1", 1234),
    );
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  const register = (path = repository, name?: string) =>
    request("/api/projects", "POST", { path, ...(name === undefined ? {} : { name }) });
  async function start(
    message: string,
    state: "working" | "usage_limited",
    projectId = "p1",
    cwd = repository,
  ) {
    const { conversationId } = (
      await runner.runtime.start({
        projectId,
        kind: "impl",
        cwd,
        title: message,
        message,
      })
    )._unsafeUnwrap();
    await vi.waitFor(() => expect(runner.runtime.store.get(conversationId)?.runState).toBe(state));
    return conversationId;
  }
  return {
    agent,
    calls,
    clock,
    database,
    gh,
    home,
    ipc: (path: string, input: unknown) =>
      link.call("POST", path, input).then((result) => result._unsafeUnwrap()),
    messages,
    register,
    repository,
    request,
    runner,
    start,
    setUnavailable: () => {
      unavailable = true;
    },
    beforeStop: (callback: () => Promise<void>) => {
      beforeStop = callback;
    },
    afterStop: (callback: () => Promise<void>) => {
      afterStop = callback;
    },
  };
}

it("Git のリポジトリではないディレクトリを登録せず理由を返す", async () => {
  const f = await fixture();
  expect(await f.register(f.home)).toEqual({
    status: 400,
    body: {
      error: {
        code: "not_a_repository",
        message: `Git のリポジトリではありません: ${f.home}。リポジトリのパスを指定してください`,
      },
    },
  });
  expect(f.database.sqlite.prepare("SELECT * FROM projects").all()).toEqual([]);
  expect(f.calls).toEqual([]);
});

it("ホームからのサブディレクトリとシンボリックリンクを最上位の同じパスへ解決する", async () => {
  const f = await fixture();
  mkdirSync(join(f.repository, "src"));
  symlinkSync(join(f.repository, "src"), join(f.home, "source"));
  expect(await f.register("~/source")).toEqual({
    status: 201,
    body: {
      project: {
        id: "p1",
        name: "shop-api",
        path: f.repository,
        usesGithub: false,
        defaultBranch: "main",
      },
      restored: false,
      notes: [rootNote],
    },
  });
  expect(await f.register()).toEqual({
    status: 409,
    body: { error: { code: "conflict", message: "このパスはすでに登録されています。" } },
  });
  expect(f.calls).toEqual([{ method: "POST", path: "/flow/notify", input: { project_id: "p1" } }]);
});

it("別の作業場所を登録せずリポジトリ本体を案内する", async () => {
  const f = await fixture();
  const worktree = join(f.home, "separate");
  git(f.repository, "worktree", "add", "-b", "feature", worktree);
  expect(await f.register(worktree)).toEqual({
    status: 400,
    body: {
      error: {
        code: "invalid_input",
        message: `これは worktree です。リポジトリ本体のパス ${f.repository} を指定してください`,
      },
    },
  });
  expect(f.database.sqlite.prepare("SELECT id FROM projects").all()).toEqual([]);
});

it("gh の未ログインを通知し、手元の既定ブランチで登録する", async () => {
  const f = await fixture({
    ghExit: 1,
    ghStderr: "To get started with GitHub CLI, please run:  gh auth login",
  });
  git(f.repository, "remote", "add", "origin", "git@github.com:example/shop.git");
  git(f.repository, "update-ref", "refs/remotes/origin/trunk", "HEAD");
  git(f.repository, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  expect(await f.register()).toEqual({
    status: 201,
    body: {
      project: {
        id: "p1",
        name: "shop-api",
        path: f.repository,
        usesGithub: false,
        defaultBranch: "main",
      },
      restored: false,
      notes: [ghLoginNote],
    },
  });
});

it("設定を全項目で検査し、一部が不正な間は書き込みも配信もしない", async () => {
  const f = await fixture();
  expect((await f.register()).status).toBe(201);
  const original = { id: "p1", name: "shop-api", path: f.repository, ...defaultSettings };
  expect(await f.request("/api/projects/p1")).toEqual({ status: 200, body: original });
  const invalid = { name: "new-name", defaultBranch: "missing" };
  expect(await f.request("/api/projects/p1", "PATCH", invalid)).toEqual({
    status: 400,
    body: {
      error: {
        code: "invalid_input",
        message: "指定された既定ブランチが手元にありません。",
      },
    },
  });
  expect(await f.request("/api/projects/p1")).toEqual({ status: 200, body: original });
  git(f.repository, "branch", "release");
  const patch = {
    defaultBranch: "release",
    model: "sonnet",
    autoStages: [],
    confirmBeforeMergeDefault: true,
    implConcurrency: 20,
  };
  const updated = { ...original, ...patch };
  expect(await f.request("/api/projects/p1", "PATCH", patch)).toEqual({
    status: 200,
    body: updated,
  });
  expect(await f.request("/api/projects/p1")).toEqual({ status: 200, body: updated });
  const notify = { method: "POST", path: "/flow/notify", input: { project_id: "p1" } };
  expect(f.calls).toEqual([notify, notify]);
  expect(f.messages).toEqual(
    [1, 2].map((seq) => ({
      topic: "inbox",
      seq,
      type: "changed",
      payload: { conversation_ids: [], issue_ids: [], project_ids: ["p1"] },
    })),
  );
});

it("作業中と利用枠待ちを止めて解除し、同じ記録と設定で戻しても再開しない", async () => {
  const f = await fixture();
  expect((await f.register()).status).toBe(201);
  expect((await f.request("/api/projects/p1", "PATCH", { name: "restored-name" })).status).toBe(
    200,
  );
  const working = await f.start("work", "working");
  const limited = await f.start("limit", "usage_limited");
  const queued = await f.runner.runtime.send(working, {
    text: "あとで",
    images: [],
    origin: "developer",
  });
  expect(queued.isOk()).toBe(true);
  const queuedBefore = f.runner.runtime.store.queue(working);
  expect(queuedBefore.map(({ text }) => text)).toEqual(["あとで"]);
  const restarted = (
    await f.runner.runtime.start({
      projectId: "p1",
      kind: "design",
      cwd: f.repository,
      title: "再起動",
    })
  )._unsafeUnwrap().conversationId;
  f.runner.runtime.record(restarted, [{ type: "stopped", payload: { reason: "restarted" } }]);
  const stoppedIds = [working, limited, restarted].sort();
  expect(await f.request("/api/projects/p1")).toEqual({
    status: 200,
    body: {
      id: "p1",
      name: "restored-name",
      path: f.repository,
      ...defaultSettings,
      stopTargetCount: 3,
    },
  });
  expect(await f.request("/api/projects/p1", "DELETE")).toEqual({
    status: 200,
    body: { stoppedConversationIds: stoppedIds },
  });
  expect(await f.request("/api/projects/p1")).toEqual({
    status: 404,
    body: { error: { code: "not_found", message: "プロジェクトが見つかりません。" } },
  });
  expect(await f.request("/api/projects/p1", "DELETE")).toEqual({
    status: 404,
    body: { error: { code: "not_found", message: "プロジェクトが見つかりません。" } },
  });
  expect(f.database.sqlite.prepare("SELECT removed_at FROM projects WHERE id='p1'").get()).toEqual({
    removed_at: 1000,
  });
  expect(existsSync(join(f.repository, "README.md"))).toBe(true);
  expect(await f.register(f.repository, "new-name")).toEqual({
    status: 200,
    body: {
      project: {
        id: "p1",
        name: "restored-name",
        path: f.repository,
        usesGithub: false,
        defaultBranch: "main",
      },
      restored: true,
      notes: [],
    },
  });
  await f.clock.advance(65_000);
  expect(f.agent.sent.map(({ text }) => text)).toEqual(["work", "limit"]);
  expect(f.runner.runtime.store.queue(working)).toEqual(queuedBefore);
  expect(
    f.database.sqlite
      .prepare("SELECT run_state, stop_reason, resets_at FROM conversations ORDER BY id")
      .all(),
  ).toEqual(stoppedIds.map(() => ({ run_state: "stopped", stop_reason: "user", resets_at: null })));
});

it("ランナー接続が無い解除は 503 を返して登録を残す", async () => {
  const f = await fixture();
  expect((await f.register()).status).toBe(201);
  f.setUnavailable();
  expect(await f.request("/api/projects/p1", "DELETE")).toEqual({
    status: 503,
    body: { error: runnerUnavailable },
  });
  expect(await f.request("/api/projects/p1")).toEqual({
    status: 200,
    body: { id: "p1", name: "shop-api", path: f.repository, ...defaultSettings },
  });
  expect(f.calls).toEqual([
    { method: "POST", path: "/flow/notify", input: { project_id: "p1" } },
    { method: "POST", path: "/flow/projects/p1/stop" },
  ]);
});

it("停止の応答から解除を記録するまで新しい番と新規会話の開始を拒む", async () => {
  const f = await fixture();
  expect((await f.register()).status).toBe(201);
  const id = (
    await f.runner.runtime.start({
      projectId: "p1",
      kind: "chat",
      cwd: f.repository,
      title: "待機",
    })
  )._unsafeUnwrap().conversationId;
  const input = { text: "新しい指示", images: [], origin: "developer" as const };
  const refusals: unknown[] = [];
  const otherResults: unknown[] = [];
  f.afterStop(async () => {
    const started = await f.runner.runtime.start({
      projectId: "p1",
      kind: "chat",
      cwd: f.repository,
      title: "同時に開始",
      message: "同時に開始",
    });
    const sent = await f.runner.runtime.send(id, input);
    refusals.push(started._unsafeUnwrapErr(), sent._unsafeUnwrapErr());
    otherResults.push(await f.request("/api/projects/p1", "DELETE"));
  });
  expect(await f.request("/api/projects/p1", "DELETE")).toEqual({
    status: 200,
    body: { stoppedConversationIds: [] },
  });
  const conflict = {
    code: "conflict",
    message: "プロジェクトの登録を解除しました。または解除中です。登録の状態を確認してください。",
  };
  expect(refusals).toEqual([conflict, conflict]);
  expect(otherResults).toEqual([
    {
      status: 409,
      body: {
        error: {
          code: "conflict",
          message:
            "プロジェクトの会話が動き始めたか、登録を解除しています。状態を確認してください。",
        },
      },
    },
  ]);
  expect((await f.runner.runtime.send(id, input))._unsafeUnwrapErr()).toEqual(conflict);
  expect((await f.register()).status).toBe(200);
  expect((await f.runner.runtime.send(id, input))._unsafeUnwrap().result).toBe("delivered");
  expect(f.agent.sent.map(({ text }) => text)).toEqual(["新しい指示"]);
});

it("GitHub を使う指定と PR 反映を同じ要求で保存し、GitHub を外すだけの操作を断る", async () => {
  const f = await fixture();
  expect((await f.register()).status).toBe(201);
  git(f.repository, "remote", "add", "origin", "git@github.com:example/shop.git");
  const updated = {
    id: "p1",
    name: "shop-api",
    path: f.repository,
    ...defaultSettings,
    usesGithub: true,
    designMergeMode: "pr",
    permissionMode: "acceptEdits",
  };
  expect(
    await f.request("/api/projects/p1", "PATCH", {
      usesGithub: true,
      designMergeMode: "pr",
      permissionMode: "編集だけ確認しない",
    }),
  ).toEqual({ status: 200, body: updated });
  expect(await f.request("/api/projects/p1", "PATCH", { usesGithub: false })).toEqual({
    status: 400,
    body: {
      error: {
        code: "invalid_input",
        message: "設計書を PR で反映するには、GitHub を使う設定にしてください。",
      },
    },
  });
  expect(await f.request("/api/projects/p1")).toEqual({ status: 200, body: updated });
  expect(f.gh.calls).toEqual([
    {
      args: ["repo", "view", "https://github.com/example/shop", "--json", "nameWithOwner"],
      cwd: f.repository,
    },
  ]);
});

it("同じパスを同時に登録しても 1 件だけ作り、登録中の別のパスには名前を重ねない", async () => {
  const f = await fixture();
  const other = join(f.home, "second");
  mkdirSync(other);
  git(other, "init", "-b", "main");
  const simultaneous = await Promise.all([f.register(), f.register()]);
  expect(simultaneous.sort((a, b) => a.status - b.status)).toEqual([
    {
      status: 201,
      body: {
        project: {
          id: "p1",
          name: "shop-api",
          path: f.repository,
          usesGithub: false,
          defaultBranch: "main",
        },
        restored: false,
        notes: [],
      },
    },
    {
      status: 409,
      body: { error: { code: "conflict", message: "このパスはすでに登録されています。" } },
    },
  ]);
  expect(await f.register(other, "shop-api")).toEqual({
    status: 409,
    body: { error: { code: "conflict", message: "この名前のプロジェクトがすでにあります。" } },
  });
  expect(f.database.sqlite.prepare("SELECT id, path FROM projects").all()).toEqual([
    { id: "p1", path: f.repository },
  ]);
  expect(f.calls).toEqual([{ method: "POST", path: "/flow/notify", input: { project_id: "p1" } }]);
});

it("解除の停止に接続できなかった場合、解除中に期限を迎えた同じ利用枠待ちを再開する", async () => {
  const f = await fixture();
  expect((await f.register()).status).toBe(201);
  const id = await f.start("limit", "usage_limited");
  f.setUnavailable();
  let duringStop: string[] = [];
  f.beforeStop(async () => {
    await f.clock.advance(65_000);
    duringStop = f.agent.sent.map(({ text }) => text);
  });
  expect(await f.request("/api/projects/p1", "DELETE")).toEqual({
    status: 503,
    body: { error: runnerUnavailable },
  });
  expect(duringStop).toEqual(["limit"]);
  expect((await f.request("/api/projects/p1")).status).toBe(200);
  await f.clock.advance(1000);
  expect(f.agent.sent.map(({ text }) => text)).toEqual([
    "limit",
    "中断したところから続けてください。",
  ]);
  expect(f.runner.runtime.store.get(id)?.runState).toBe("working");
});

it("解除中に競合した割込みは元の番のイベントを変えず、解除失敗後の割込みは続けて受け付ける", async () => {
  const f = await fixture();
  expect((await f.register()).status).toBe(201);
  const id = await f.start("work", "working");
  await vi.waitFor(() =>
    expect(f.runner.runtime.store.events(id).map(({ type }) => type)).toEqual([
      "user_message",
      "assistant_text",
    ]),
  );
  const original = f.runner.runtime.store.events(id);
  let blocked: number | undefined;
  const interrupt = (clientId: string) =>
    f.ipc(`/conversations/${id}/messages`, {
      text: "割込み",
      images: [],
      interrupt: true,
      client_id: clientId,
      origin: "developer",
    });
  f.setUnavailable();
  f.beforeStop(async () => {
    blocked = (await interrupt("first")).status;
  });
  expect((await f.request("/api/projects/p1", "DELETE")).status).toBe(503);
  expect(blocked).toBe(409);
  expect(f.runner.runtime.store.events(id)).toEqual(original);
  expect((await interrupt("second")).status).toBe(200);
  expect(f.agent.sent.map(({ text }) => text)).toEqual(["work", "割込み"]);
});

it("指示つきの開始を受け付けている間は解除を延期し、成立した会話を次の解除で止める", async () => {
  const f = await fixture();
  expect((await f.register()).status).toBe(201);
  let release!: () => void;
  let entered!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inGuard = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.runner.runtime.runOptions.registerDeliveryGuard(async (_conversation, input) => {
    if (input.text === "初回") {
      entered();
      await wait;
    }
    return ok(undefined);
  });
  const start = f.ipc("/conversations", {
    project_id: "p1",
    kind: "impl",
    cwd: f.repository,
    title: "先行",
    message: "初回",
  });
  let removal: Awaited<ReturnType<typeof f.request>>;
  let other: Awaited<ReturnType<typeof f.ipc>>;
  try {
    await inGuard;
    other = await f.ipc("/conversations", {
      project_id: "p1",
      kind: "chat",
      cwd: f.repository,
      title: "別会話",
      message: "別の指示",
    });
    removal = await f.request("/api/projects/p1", "DELETE");
  } finally {
    release();
  }
  const created = await start;
  expect(removal.status).toBe(409);
  expect(created.status).toBe(200);
  expect(other.status).toBe(200);
  const { conversation_id: id } = created.body as { conversation_id: string };
  const { conversation_id: otherId } = other.body as { conversation_id: string };
  expect(f.agent.sent.map(({ text }) => text)).toEqual(["別の指示", "初回"]);
  expect(await f.request("/api/projects/p1", "DELETE")).toEqual({
    status: 200,
    body: { stoppedConversationIds: [id, otherId].sort() },
  });
});

it("GitHub の origin/HEAD が削除済みの参照を指す場合はローカルの HEAD で登録する", async () => {
  const f = await fixture();
  git(f.repository, "remote", "add", "origin", "https://github.com/example/shop.git");
  git(f.repository, "update-ref", "refs/remotes/origin/old", "HEAD");
  git(f.repository, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/old");
  git(f.repository, "update-ref", "-d", "refs/remotes/origin/old");
  expect(await f.register()).toEqual({
    status: 201,
    body: {
      project: {
        id: "p1",
        name: "shop-api",
        path: f.repository,
        usesGithub: true,
        defaultBranch: "main",
      },
      restored: false,
      notes: [],
    },
  });
});

it("GitHub 無効時は origin 専用ブランチを拒み、有効化と設定を一緒に行えば受け付ける", async () => {
  const f = await fixture();
  git(f.repository, "update-ref", "refs/remotes/origin/release", "HEAD");
  git(f.repository, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release");
  expect(await f.register()).toEqual({
    status: 201,
    body: {
      project: {
        id: "p1",
        name: "shop-api",
        path: f.repository,
        usesGithub: false,
        defaultBranch: "main",
      },
      restored: false,
      notes: [],
    },
  });
  expect(await f.request("/api/projects/p1", "PATCH", { defaultBranch: "release" })).toEqual({
    status: 400,
    body: {
      error: { code: "invalid_input", message: "指定された既定ブランチが手元にありません。" },
    },
  });
  expect(
    (
      await f.request("/api/projects/p1", "PATCH", {
        defaultBranch: "main^{commit}",
      })
    ).status,
  ).toBe(400);
  const worktree = await f.request("/api/projects/p1/worktrees", "POST", {
    name: "after-settings",
  });
  expect(worktree.status).toBe(201);
  expect(git(f.repository, "rev-parse", "refs/heads/after-settings")).toBe(
    git(f.repository, "rev-parse", "refs/heads/main"),
  );
  git(f.repository, "remote", "add", "origin", "https://github.com/example/shop.git");
  expect(
    (await f.request("/api/projects/p1", "PATCH", { usesGithub: true, defaultBranch: "release" }))
      .status,
  ).toBe(200);
  expect((await f.request("/api/projects/p1", "PATCH", { usesGithub: false })).status).toBe(400);
  expect(
    (await f.request("/api/projects/p1", "PATCH", { usesGithub: false, defaultBranch: "main" }))
      .status,
  ).toBe(200);
});

it("設定入力の失敗理由は項目ごとに異なり、入力値をエラーへ反映しない", async () => {
  const f = await fixture();
  expect((await f.register()).status).toBe(201);
  const before = await f.request("/api/projects/p1");
  expect(await f.request("/api/projects/p1", "PATCH", { model: "typo", name: "変更" })).toEqual({
    status: 400,
    body: {
      error: {
        code: "invalid_input",
        message: "モデルは opus、sonnet、haiku、または未指定を表す null から選んでください。",
      },
    },
  });
  expect(await f.request("/api/projects/p1", "PATCH", { implConcurrency: 21 })).toEqual({
    status: 400,
    body: {
      error: {
        code: "invalid_input",
        message: "実装の同時実行は 1〜20 件の整数で指定してください。",
      },
    },
  });
  expect(await f.request("/api/projects", "POST", { path: 1 })).toEqual({
    status: 400,
    body: { error: { code: "invalid_input", message: "登録するパスは文字列で指定してください。" } },
  });
  expect(await f.request("/api/projects/p1")).toEqual(before);
  expect(f.calls).toEqual([{ method: "POST", path: "/flow/notify", input: { project_id: "p1" } }]);
});

it.each([
  "ssh://git@GITHUB.COM/example/shop.git",
  "ssh://git@SSH.GITHUB.COM:443/example/shop.git",
  "https://GITHUB.COM/example/shop.git",
  "git@GITHUB.COM:example/shop.git",
])("origin の GitHub ホスト名 %s を正規化して確認する", async (origin) => {
  const f = await fixture();
  git(f.repository, "remote", "add", "origin", origin);
  expect(await f.register()).toEqual({
    status: 201,
    body: {
      project: {
        id: "p1",
        name: "shop-api",
        path: f.repository,
        usesGithub: true,
        defaultBranch: "main",
      },
      restored: false,
      notes: [],
    },
  });
  expect(f.gh.calls).toEqual([
    {
      cwd: f.repository,
      args: ["repo", "view", "https://github.com/example/shop", "--json", "nameWithOwner"],
    },
  ]);
});

it("GitHub の実在する origin/HEAD があれば本体のローカル HEAD に優先する", async () => {
  const f = await fixture();
  git(f.repository, "remote", "add", "origin", "https://github.com/example/shop.git");
  git(f.repository, "update-ref", "refs/remotes/origin/trunk", "HEAD");
  git(f.repository, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  expect(await f.register()).toEqual({
    status: 201,
    body: {
      project: {
        id: "p1",
        name: "shop-api",
        path: f.repository,
        usesGithub: true,
        defaultBranch: "trunk",
      },
      restored: false,
      notes: [],
    },
  });
});

it("GitHub と名前が似た別ホストの origin は GitHub の確認へ送らない", async () => {
  const f = await fixture();
  git(
    f.repository,
    "remote",
    "add",
    "origin",
    "ssh://git@GITHUB.COM.EXAMPLE.INVALID/example/shop.git",
  );
  expect(await f.register()).toEqual({
    status: 201,
    body: {
      project: {
        id: "p1",
        name: "shop-api",
        path: f.repository,
        usesGithub: false,
        defaultBranch: "main",
      },
      restored: false,
      notes: [],
    },
  });
  expect((await f.request("/api/projects/p1", "PATCH", { usesGithub: true })).status).toBe(400);
  expect(f.gh.calls).toEqual([]);
});

it.each([
  { label: "停止を記録できなければその会話も自動再開する", locked: true, status: 500 },
  {
    label: "停止を記録した会話は自動再開せず、別プロジェクトは再開する",
    locked: false,
    status: 200,
  },
])("解除の利用枠待ち: $label", async ({ locked, status }) => {
  const f = await fixture();
  expect((await f.register()).status).toBe(201);
  const otherPath = join(f.home, "second");
  mkdirSync(otherPath);
  git(otherPath, "init", "-b", "main");
  expect((await f.register(otherPath)).status).toBe(201);
  const limited = await f.start("limit", "usage_limited");
  const other = await f.start("limit", "usage_limited", "p2", otherPath);
  const original = f.runner.runtime.store.get(limited);
  const otherOriginal = f.runner.runtime.store.get(other);
  expect(original?.resetsAt).toBe(5000);
  const writer = openDatabase(directoriesIn(f.home));
  try {
    if (locked) {
      f.database.sqlite.pragma("busy_timeout = 0");
      writer.sqlite.exec("BEGIN IMMEDIATE");
      writer.sqlite.prepare("UPDATE projects SET flow_paused = ? WHERE id = ?").run(1, "p1");
    }
    const removed = await f.request("/api/projects/p1", "DELETE");
    expect(removed).toEqual(
      locked
        ? {
            status,
            body: {
              error: {
                code: "internal",
                message: "プロジェクトの会話を停止できませんでした。もう一度操作してください。",
              },
            },
          }
        : { status, body: { stoppedConversationIds: [limited] } },
    );
  } finally {
    if (writer.sqlite.inTransaction) writer.sqlite.exec("ROLLBACK");
    writer.close();
  }
  expect((await f.request("/api/projects/p1")).status).toBe(locked ? 200 : 404);
  if (locked) expect(f.runner.runtime.store.get(limited)).toEqual(original);
  expect(f.runner.runtime.store.get(other)).toEqual(otherOriginal);
  await f.clock.advance(65000 - f.clock.now() - 1);
  expect(f.agent.sent.map(({ text }) => text)).toEqual(["limit", "limit"]);
  await f.clock.advance(1);
  const resumeInstruction = "中断したところから続けてください。";
  expect(f.agent.sent.map(({ sessionId, text }) => ({ sessionId, text }))).toEqual([
    { sessionId: original?.sessionId, text: "limit" },
    { sessionId: otherOriginal?.sessionId, text: "limit" },
    ...(locked ? [{ sessionId: original?.sessionId, text: resumeInstruction }] : []),
    { sessionId: otherOriginal?.sessionId, text: resumeInstruction },
  ]);
  expect(f.runner.runtime.store.get(limited)?.runState).toBe(locked ? "working" : "stopped");
  expect(f.runner.runtime.store.get(other)?.runState).toBe("working");
});

it("HTTPで解除したプロジェクトの通知だけを取り下げ、再登録時には同じ通知を残す", async () => {
  const f = await fixture();
  const registered = await f.register();
  expect(registered.status).toBe(201);
  const id = await f.start("作業中", "working");
  const notice = {
    id: "existing",
    targetKind: "conversation",
    targetId: id,
    title: "作業中",
    body: "以前の判断待ち",
    reason: "question",
    createdAt: 20,
    dismissedAt: null,
  };
  const other = { ...notice, id: "other", targetId: "other-c" };
  f.database.db.insert(notifications).values([notice, other]).run();

  const removed = await f.request("/api/projects/p1", "DELETE");
  const restored = await f.register();
  expect([removed, restored.status, f.database.db.select().from(notifications).all()]).toEqual([
    { status: 200, body: { stoppedConversationIds: [id] } },
    200,
    [{ ...notice, dismissedAt: f.clock.now() }, other],
  ]);
});

it.each([
  { kind: "issue", notified: false },
  { kind: "conversation", notified: false },
  { kind: "issue", notified: true },
] as const)(
  "独立対照: 解除復帰した $kind の再起動後お知らせ (旧記録=$notified)",
  async ({ kind, notified }) => {
    const f = await fixture();
    expect((await f.register()).status).toBe(201);
    if (kind === "issue") {
      f.database.sqlite
        .prepare(
          "INSERT INTO issues(id,project_id,number,title,state,created_at,updated_at) VALUES ('legacy-i','p1',13,'既存の設計','design_review',100,100)",
        )
        .run();
      f.database.sqlite
        .prepare(
          "INSERT INTO issue_events(issue_id,seq,type,payload,created_at) VALUES ('legacy-i',1,'state_changed','{}',100)",
        )
        .run();
    } else {
      f.database.sqlite
        .prepare(
          "INSERT INTO conversations(id,project_id,kind,title,cwd,run_state,last_seq,recap_seq,last_activity_at) VALUES ('legacy-c','p1','chat','既存の会話',?,'idle',1,1,100)",
        )
        .run(f.repository);
      f.database.sqlite
        .prepare(
          "INSERT INTO conversation_events(conversation_id,seq,type,payload,created_at) VALUES ('legacy-c',1,'assistant_text',?,100)",
        )
        .run(JSON.stringify({ text: "以前に済んだ応答" }));
    }
    const prior = {
      id: "before-remove",
      targetKind: "issue",
      targetId: "legacy-i",
      reason: "design_review",
      title: "以前の設計",
      body: "以前の承認待ち",
      createdAt: 110,
      dismissedAt: null,
    };
    if (notified) f.database.db.insert(notifications).values(prior).run();
    expect(await f.request("/api/projects/p1", "DELETE")).toEqual({
      status: 200,
      body: { stoppedConversationIds: [] },
    });
    expect((await f.register()).status).toBe(200);
    expect(f.database.db.select().from(notifications).all()).toEqual(
      notified ? [{ ...prior, dismissedAt: f.clock.now() }] : [],
    );
    expect(f.messages.filter((m) => (m as { type?: string }).type === "notice")).toEqual([]);

    const reopened = openDatabase(directoriesIn(f.home));
    try {
      const next = new WsHub(reopened.sqlite, {
        inbox: { repository: createInboxRepository(() => reopened.db), resetTime: () => "" },
        now: () => 2000,
        id: () => "after-restart",
      });
      const messages: { type: string }[] = [];
      const client = {
        bufferedAmount: 0,
        send: (raw: string) => messages.push(JSON.parse(raw)),
        close() {},
      };
      next.add(client);
      next.receive(client, { op: "subscribe", topic: "app" });
      next.receive(client, { op: "shown", topics: [] });
      expect(messages.filter(({ type }) => type === "notice")).toEqual([]);
    } finally {
      reopened.close();
    }
  },
);

it("独立対照: 取り下げ失敗なら解除まで巻き戻し、再試行で会話とissueの通知を取り下げる", async () => {
  const f = await fixture();
  expect((await f.register()).status).toBe(201);
  const id = await f.start("作業中", "working");
  f.database.sqlite
    .prepare(
      "INSERT INTO issues(id,project_id,number,title,state,created_at,updated_at) VALUES ('issue-p','p1',13,'設計','design_review',100,100)",
    )
    .run();
  const notice = {
    reason: "question",
    title: "待機",
    body: "以前からの待機",
    createdAt: 20,
    dismissedAt: null,
  };
  const records = [
    { ...notice, id: "c", targetKind: "conversation", targetId: id },
    { ...notice, id: "i", targetKind: "issue", targetId: "issue-p" },
    { ...notice, id: "other", targetKind: "conversation", targetId: "unrelated" },
  ];
  f.database.db.insert(notifications).values(records).run();
  f.database.sqlite.exec(
    "CREATE TRIGGER fixture_reject_dismiss BEFORE UPDATE OF dismissed_at ON notifications WHEN new.id = 'i' BEGIN SELECT raise(ABORT, 'fixture rejected notification write'); END",
  );
  expect(await f.request("/api/projects/p1", "DELETE")).toEqual({
    status: 500,
    body: {
      error: {
        code: "internal",
        message: "プロジェクトの操作に失敗しました。もう一度操作してください。",
      },
    },
  });
  expect((await f.request("/api/projects/p1")).status).toBe(200);
  expect(f.database.db.select().from(notifications).all()).toEqual(records);
  f.database.sqlite.exec("DROP TRIGGER fixture_reject_dismiss");
  expect(await f.request("/api/projects/p1", "DELETE")).toEqual({
    status: 200,
    body: { stoppedConversationIds: [] },
  });
  expect((await f.request("/api/projects/p1")).status).toBe(404);
  expect(f.database.db.select().from(notifications).all()).toEqual(
    records.map((r) => ({ ...r, dismissedAt: r.id === "other" ? null : f.clock.now() })),
  );
});

it("独立対照: 再登録後に新しく判断待ちへ進んだissueは画面サーバー起動時に通知される", async () => {
  const f = await fixture();
  expect((await f.register()).status).toBe(201);
  expect((await f.request("/api/projects/p1", "DELETE")).status).toBe(200);
  expect((await f.register()).status).toBe(200);
  f.database.sqlite
    .prepare(
      "INSERT INTO issues(id,project_id,number,title,state,created_at,updated_at) VALUES ('new-i','p1',14,'新着の設計','design_review',1500,1500)",
    )
    .run();
  f.database.sqlite
    .prepare(
      "INSERT INTO issue_events(issue_id,seq,type,payload,created_at) VALUES ('new-i',1,'state_changed','{}',1500)",
    )
    .run();
  const reopened = openDatabase(directoriesIn(f.home));
  try {
    const hub = new WsHub(reopened.sqlite, {
      inbox: { repository: createInboxRepository(() => reopened.db), resetTime: () => "" },
      now: () => 2000,
      id: () => "after-restart",
    });
    const messages: { type: string; payload: unknown }[] = [];
    const client = {
      bufferedAmount: 0,
      send: (raw: string) => messages.push(JSON.parse(raw)),
      close() {},
    };
    hub.add(client);
    hub.receive(client, { op: "subscribe", topic: "app" });
    hub.receive(client, { op: "shown", topics: [] });
    expect(messages.filter(({ type }) => type === "notice").map(({ payload }) => payload)).toEqual([
      {
        level: "info",
        message: "#14 新着の設計 (shop-api): 設計の承認を待っています",
        notification: { tag: "issue:new-i", url: "/issues/new-i" },
      },
    ]);
  } finally {
    reopened.close();
  }
});

it("同じissueの再登録時の待機を記録しても、次に承認待ちへ入った記録は通知する", async () => {
  const f = await fixture();
  expect((await f.register()).status).toBe(201);
  f.database.sqlite
    .prepare(
      "INSERT INTO issues(id,project_id,number,title,state,created_at,updated_at) VALUES ('existing-i','p1',13,'設計','design_review',100,100)",
    )
    .run();
  const event = f.database.sqlite.prepare(
    "INSERT INTO issue_events(issue_id,seq,type,payload,created_at) VALUES ('existing-i',?,'state_changed',?,100)",
  );
  event.run(1, JSON.stringify({ from: "design", to: "design_review" }));
  expect((await f.request("/api/projects/p1", "DELETE")).status).toBe(200);
  expect((await f.register()).status).toBe(200);
  expect(f.database.db.select().from(notifications).all()).toEqual([]);
  event.run(2, JSON.stringify({ from: "design_review", to: "design" }));
  event.run(3, JSON.stringify({ from: "design", to: "design_review" }));
  const reopened = openDatabase(directoriesIn(f.home));
  try {
    const hub = new WsHub(reopened.sqlite, {
      inbox: { repository: createInboxRepository(() => reopened.db), resetTime: () => "" },
      now: () => 2000,
      id: () => "new-wait",
    });
    const messages: { type: string; payload: unknown }[] = [];
    const client = {
      bufferedAmount: 0,
      send: (raw: string) => messages.push(JSON.parse(raw)),
      close() {},
    };
    hub.add(client);
    hub.receive(client, { op: "shown", topics: [] });
    expect(messages.filter(({ type }) => type === "notice").map(({ payload }) => payload)).toEqual([
      {
        level: "info",
        message: "#13 設計 (shop-api): 設計の承認を待っています",
        notification: { tag: "issue:existing-i", url: "/issues/existing-i" },
      },
    ]);
  } finally {
    reopened.close();
  }
});
