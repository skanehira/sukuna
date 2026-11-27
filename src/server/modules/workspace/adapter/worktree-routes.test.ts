import { createImageFiles } from "../../../../runner/modules/conversation/adapter/image-files";
import type { AgentPort } from "../../../../runner/modules/conversation/domain/agent-port";
import type { Clock } from "../../../../runner/modules/conversation/domain/clock";
import { createWorkspaceAgent, WorkspaceClock } from "./worktree-conversation-test-support";
import { openDatabase } from "../../../../shared/db/open";
import { createWorktreeActivity } from "../../../../shared/workspace/sqlite-worktree-activity";
import { WorktreeActivityBusy } from "../../../../shared/workspace/worktree-activity";
import { createIpcRoutes } from "../../../../runner/modules/conversation/adapter/ipc-routes";
import { ConversationRuntime } from "../../../../runner/modules/conversation/usecase/runtime";
import { SqliteConversationStore } from "../../../../runner/modules/conversation/adapter/sqlite-conversation-store";
import { ScriptedAgent } from "../../../../runner/modules/conversation/adapter/scripted-agent";
import { systemClock } from "../../../../runner/modules/conversation/adapter/system-clock";
import { createIssueOperations } from "../../../../runner/modules/flow/adapter/issue-ops-dependencies";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err } from "neverthrow";
import type { WorktreeDependencies } from "../domain/worktree-ports";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
  type OpenedDatabase,
} from "../../../../shared/db/test-helpers";
import { ScriptedGh } from "../../../../shared/gh/scripted-gh";
import { worktreeCreatedSchema, worktreeListSchema } from "../../../../shared/api/worktree";
import { createApp } from "../../../app";
import { incomingWith } from "../../identity/test-support";
import { createTailscaleLocalApi } from "../../identity/adapter/tailscale-local-api";
import { createWorktreeDependencies } from "./worktree-dependencies";
import { createGitCli, type GitRunner } from "./git-cli";

describe("worktree API", () => {
  let root: string;
  let cwd: string;
  let remote: string;
  let home: string;
  let database: OpenedDatabase;
  let gh: ScriptedGh;
  let sequence: number;

  function git(args: string[], at = cwd): string {
    return execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        ...args,
      ],
      { cwd: at, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
  }
  function add(name: string) {
    const path = join(cwd, ".claude/worktrees", name);
    git(["worktree", "add", "-b", name, path, "main"]);
    return path;
  }
  function record(
    id: string,
    path: string,
    branch: string,
    origin = "user",
    issueId: string | null = null,
    branchCreated = false,
  ) {
    database.sqlite
      .prepare(
        "INSERT INTO worktrees (id, project_id, path, branch, origin, issue_id, branch_created) VALUES (?, 'p', ?, ?, ?, ?, ?)",
      )
      .run(id, path, branch, origin, issueId, Number(branchCreated));
  }
  function conversation(id: string, path: string, state = "idle", closedAt: number | null = null) {
    database.sqlite
      .prepare(
        "INSERT INTO conversations (id, project_id, kind, title, cwd, worktree_id, run_state, closed_at) VALUES (?, 'p', 'chat', ?, ?, 'w', ?, ?)",
      )
      .run(id, `会話 ${id}`, path, state, closedAt);
  }
  function issue(state = "ready", prUrl: string | null = null) {
    database.sqlite
      .prepare(
        "INSERT INTO issues (id, project_id, number, title, state, pr_url, created_at, updated_at) VALUES ('i', 'p', 42, '予約 API', ?, ?, 0, 0)",
      )
      .run(state, prUrl);
  }
  function request(
    path: string,
    method = "GET",
    body?: unknown,
    git?: GitRunner,
    configure?: (deps: WorktreeDependencies) => WorktreeDependencies,
  ) {
    const deps = createWorktreeDependencies(() => database, {
      gh,
      now: () => 12345,
      id: () => `w${++sequence}`,
      ...(git ? { git } : {}),
    });
    const app = createApp({
      build: "test",
      identity: {
        login: "dev@example.com",
        devIdentity: "dev@example.com",
        clock: { now: () => 0 },
        tailscale: createTailscaleLocalApi(),
      },
      worktrees: configure ? configure(deps) : deps,
    });
    return app.request(
      path,
      {
        method,
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      },
      incomingWith("127.0.0.1", 50000),
    );
  }
  function row(name: string, overrides: object = {}) {
    return {
      id: expect.any(String),
      name,
      path: join(cwd, ".claude/worktrees", name),
      branch: name,
      origin: "user",
      issue: null,
      conversations: [],
      uncommittedCount: 0,
      uncommittedSample: [],
      unpushedCount: 0,
      locked: null,
      missing: false,
      terminalId: null,
      ...overrides,
    };
  }
  async function create(name: string) {
    const response = await request("/api/projects/p/worktrees", "POST", { name });
    expect(response.status).toBe(201);
    return worktreeCreatedSchema.parse(await response.json());
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "sukuna-worktree-")));
    cwd = join(root, "repo");
    remote = join(root, "remote.git");
    mkdirSync(cwd);
    git(["init", "--quiet", "-b", "main"]);
    writeFileSync(join(cwd, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(cwd, "README.md"), "initial\n");
    git(["add", "."]);
    git(["commit", "-qm", "initial"]);
    git(["init", "--quiet", "--bare", remote]);
    git(["remote", "add", "origin", remote]);
    git(["push", "-u", "origin", "main"]);
    writeFileSync(join(cwd, ".git/info/exclude"), ".claude/worktrees/\n");
    home = createTempHome();
    database = openMigratedDatabase(home);
    database.sqlite
      .prepare(
        "INSERT INTO projects (id, name, path, default_branch) VALUES ('p', 'test', ?, 'main')",
      )
      .run(cwd);
    gh = new ScriptedGh({
      responses: [],
      fallback: { stdout: "", stderr: "offline", exit_code: 1 },
    });
    sequence = 0;
  });
  afterEach(() => {
    database.close();
    removeTempHome(home);
    rmSync(root, { recursive: true, force: true });
  });

  it("一覧は main を先頭に会話と issue と件数を返し、外部の worktree だけ登録する", async () => {
    const path = add("try-cache");
    issue();
    record("w", path, "try-cache", "flow", "i");
    conversation("a", cwd);
    conversation("b", path);
    conversation("closed", path, "idle", 1);
    writeFileSync(join(path, "new.ts"), "new");
    writeFileSync(join(path, "ignored.txt"), "ignored");
    git(["commit", "--allow-empty", "-qm", "local"], path);
    const external = add("external");
    add("issue-100");
    add("design-100");

    const response = await request("/api/projects/p/worktrees");

    expect(response.status).toBe(200);
    expect(worktreeListSchema.parse(await response.json())).toEqual({
      worktrees: [
        {
          id: null,
          name: "main",
          path: cwd,
          branch: "main",
          origin: "main",
          issue: null,
          conversations: [{ id: "a", title: "会話 a", runState: "idle" }],
          uncommittedCount: 0,
          uncommittedSample: [],
          unpushedCount: 0,
          locked: null,
          missing: false,
          terminalId: null,
        },
        row("external"),
        row("try-cache", {
          id: "w",
          origin: "flow",
          issue: { id: "i", number: 42, title: "予約 API", state: "ready" },
          conversations: [{ id: "b", title: "会話 b", runState: "idle" }],
          uncommittedCount: 1,
          uncommittedSample: ["new.ts"],
          unpushedCount: 1,
        }),
      ],
    });
    expect(
      database.sqlite
        .prepare(
          "SELECT path, origin, branch_created, issue_id, port_slot, removed_at FROM worktrees ORDER BY path",
        )
        .all(),
    ).toEqual([
      {
        path: external,
        origin: "user",
        branch_created: 0,
        issue_id: null,
        port_slot: null,
        removed_at: null,
      },
      { path, origin: "flow", branch_created: 0, issue_id: "i", port_slot: null, removed_at: null },
    ]);
    expect((await request("/api/projects/p/worktrees")).status).toBe(200);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM worktrees").get()).toEqual({
      count: 2,
    });
  });

  it("GitHub 利用時は origin の既定ブランチを fetch して新しい HEAD から作り、ローカル exclude だけ足す", async () => {
    const publisher = join(root, "publisher");
    git(["clone", "-q", "-b", "main", remote, publisher]);
    git(["commit", "--allow-empty", "-qm", "remote only"], publisher);
    git(["push", "origin", "main"], publisher);
    const remoteHead = git(["rev-parse", "HEAD"], publisher);
    database.sqlite.prepare("UPDATE projects SET uses_github = 1").run();
    writeFileSync(join(cwd, ".git/info/exclude"), "other-pattern");

    const created = await create("try-2");

    expect(created).toEqual({ ...row("try-2"), notice: null });
    expect(git(["rev-parse", "HEAD"], created.path)).toBe(remoteHead);
    expect(git(["branch", "--show-current"], created.path)).toBe("try-2");
    expect(readFileSync(join(cwd, ".git/info/exclude"), "utf8")).toBe(
      "other-pattern\n.claude/worktrees/\n",
    );
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe("ignored.txt\n");
    expect(database.sqlite.prepare("SELECT * FROM worktrees").get()).toEqual({
      id: created.id,
      project_id: "p",
      path: created.path,
      branch: "try-2",
      branch_created: 1,
      origin: "user",
      issue_id: null,
      port_slot: null,
      removed_at: null,
    });
  });

  it("fetch 失敗時は手元の既定ブランチから作り notice を返す", async () => {
    database.sqlite.prepare("UPDATE projects SET uses_github = 1").run();
    rmSync(remote, { recursive: true, force: true });
    const created = await create("offline");
    expect(created).toEqual({
      ...row("offline"),
      notice: "GitHub から取得できなかったので、手元の既定ブランチから作りました",
    });
    expect(git(["rev-parse", "HEAD"], created.path)).toBe(git(["rev-parse", "main"]));
  });

  it("安全な worktree だけ削除してアプリが作ったブランチを残し、開いた会話も閉じた会話もプロジェクトへ移す", async () => {
    const created = await create("safe");
    conversation("c", created.path);
    conversation("closed", created.path, "idle", 1);
    conversation("elsewhere", cwd);
    const response = await request(`/api/worktrees/${created.id}`, "DELETE");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      removedBranch: false,
      movedConversationIds: ["c", "closed"],
    });
    expect(existsSync(created.path)).toBe(false);
    expect(git(["branch", "--list", "safe"])).toBe("safe");
    expect(
      database.sqlite.prepare("SELECT removed_at FROM worktrees WHERE id = ?").get(created.id),
    ).toEqual({ removed_at: 12345 });
    expect(
      database.sqlite.prepare("SELECT id, cwd, worktree_id FROM conversations ORDER BY id").all(),
    ).toEqual([
      { id: "c", cwd, worktree_id: null },
      { id: "closed", cwd, worktree_id: null },
      { id: "elsewhere", cwd, worktree_id: "w" },
    ]);
    const repeated = await request(`/api/worktrees/${created.id}`, "DELETE");
    expect(repeated.status).toBe(404);
    expect(await repeated.json()).toEqual({
      error: { code: "not_found", message: "worktree がありません" },
    });
  });

  it("既存の開かれていないブランチを使い、worktree 削除後もブランチを残す", async () => {
    git(["branch", "existing"]);
    const created = await create("existing");
    expect(database.sqlite.prepare("SELECT branch_created FROM worktrees").get()).toEqual({
      branch_created: 0,
    });
    const response = await request(`/api/worktrees/${created.id}`, "DELETE");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removedBranch: false, movedConversationIds: [] });
    expect(git(["branch", "--list", "existing"])).toBe("existing");
  });

  it.each([
    [
      "uncommitted",
      "未コミットの変更があるため消していません (a.ts ほか 2 件)",
      3,
      ["a.ts", "b.ts", "c.ts"],
    ],
    ["unpushed", "未 push のコミットがあるため消していません", 1, []],
    ["flow", "issue #42 の自動フローが使っています。issue が閉じると片付けられます", 0, []],
    ["running", "会話: 会話 busy の AI が動いています。止めてから消してください", 0, []],
    ["locked", "この worktree はロックされています: manual", 0, []],
    ["main", "プロジェクトのディレクトリは消せません", 0, []],
  ] as const)(
    "%s の worktree は error.details 全体を返し残す",
    async (reason, message, count, sample) => {
      const path = reason === "main" ? cwd : add("protected");
      if (reason === "flow") issue();
      record(
        "w",
        path,
        reason === "main" ? "main" : "protected",
        reason === "flow" ? "flow" : "user",
        reason === "flow" ? "i" : null,
      );
      if (reason === "uncommitted")
        for (const name of sample) writeFileSync(join(path, name), "new");
      if (reason === "unpushed") git(["commit", "--allow-empty", "-qm", "local"], path);
      if (reason === "running") conversation("busy", path, "waiting_answer");
      if (reason === "locked") git(["worktree", "lock", "--reason", "manual", path]);
      const response = await request("/api/worktrees/w", "DELETE");
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: { code: "conflict", message, details: { reason, count, sample } },
      });
      expect(existsSync(path)).toBe(true);
      expect(
        database.sqlite.prepare("SELECT removed_at FROM worktrees WHERE id = 'w'").get(),
      ).toEqual({ removed_at: null });
    },
  );

  it("issue の全部の PR を照合し merge 済みの HEAD は未 push に数えず削除する", async () => {
    const path = add("issue-42");
    git(["commit", "--allow-empty", "-qm", "squashed elsewhere"], path);
    const head = git(["rev-parse", "HEAD"], path);
    issue("done", "https://github.com/test/repo/pull/3");
    record("w", path, "issue-42", "flow", "i", true);
    database.sqlite
      .prepare(
        "INSERT INTO issue_events (issue_id, seq, type, payload, created_at) VALUES ('i', 1, 'design_pr_created', ?, 0), ('i', 2, 'reopened_for_fix', ?, 0)",
      )
      .run(
        JSON.stringify({ prUrl: "https://github.com/test/repo/pull/1" }),
        JSON.stringify({ previousPrUrl: "https://github.com/test/repo/pull/2" }),
      );
    gh = new ScriptedGh({
      responses: [
        {
          match: "^pr view https://github.com/test/repo/pull/1 ",
          stdout: JSON.stringify({ state: "OPEN", headRefOid: head }),
          exit_code: 0,
        },
        {
          match: "^pr view https://github.com/test/repo/pull/2 ",
          stdout: JSON.stringify({ state: "MERGED", headRefOid: head }),
          exit_code: 0,
        },
      ],
      fallback: { stdout: JSON.stringify({ state: "MERGED", headRefOid: "other" }), exit_code: 0 },
    });
    const list = await request("/api/projects/p/worktrees");
    const listed = worktreeListSchema.parse(await list.json());
    expect(listed.worktrees).toEqual([
      {
        id: null,
        name: "main",
        path: cwd,
        branch: "main",
        origin: "main",
        issue: null,
        conversations: [],
        uncommittedCount: 0,
        uncommittedSample: [],
        unpushedCount: 0,
        locked: null,
        missing: false,
        terminalId: null,
      },
      row("issue-42", {
        id: "w",
        origin: "flow",
        issue: { id: "i", number: 42, title: "予約 API", state: "done" },
      }),
    ]);
    const response = await request("/api/worktrees/w", "DELETE");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removedBranch: false, movedConversationIds: [] });
    expect(
      gh.calls
        .map((call) => call.args)
        .slice(0, 3)
        .sort((a, b) => a.join(" ").localeCompare(b.join(" "))),
    ).toEqual(
      [1, 2, 3].map((number) => [
        "pr",
        "view",
        `https://github.com/test/repo/pull/${number}`,
        "--json",
        "state,headRefOid",
      ]),
    );
  });

  it.each([
    ["OPEN", "same"],
    ["CLOSED", "same"],
    ["MERGED", "different"],
    ["invalid", "same"],
    ["offline", "same"],
  ])("PR が %s、HEAD が %s なら未 push の保護を外さない", async (state, ref) => {
    const path = add("issue-42");
    git(["commit", "--allow-empty", "-qm", "local"], path);
    const head = git(["rev-parse", "HEAD"], path);
    issue("done", "https://github.com/test/repo/pull/1");
    record("w", path, "issue-42", "flow", "i", true);
    gh = new ScriptedGh({
      responses: [],
      fallback: {
        stdout:
          state === "invalid"
            ? "invalid json"
            : JSON.stringify({ state, headRefOid: ref === "same" ? head : "different" }),
        stderr: "",
        exit_code: state === "offline" ? 1 : 0,
      },
    });
    const response = await request("/api/worktrees/w", "DELETE");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "conflict",
        message: "未 push のコミットがあるため消していません",
        details: { reason: "unpushed", count: 1, sample: [] },
      },
    });
    expect(existsSync(path)).toBe(true);
    expect(git(["rev-parse", "issue-42"])).toBe(head);
  });

  it("フォルダの無い worktree は一覧に missing を出し、削除時だけ prune する", async () => {
    const path = add("missing");
    record("w", path, "missing");
    rmSync(path, { recursive: true, force: true });
    const list = await request("/api/projects/p/worktrees");
    expect(worktreeListSchema.parse(await list.json()).worktrees.at(1)).toEqual(
      row("missing", { id: "w", missing: true }),
    );
    expect(git(["worktree", "list", "--porcelain"]).includes(path)).toBe(true);
    const response = await request("/api/worktrees/w", "DELETE");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removedBranch: false, movedConversationIds: [] });
    expect(git(["worktree", "list", "--porcelain"]).includes(path)).toBe(false);
  });

  it.each(["main", "sukuna", "issue-2", "design-2", "../escape", "", "a.lock"])(
    "不正な名前 %s は理由を返す",
    async (name) => {
      const response = await request("/api/projects/p/worktrees", "POST", { name });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: "invalid_input",
          message:
            "名前は 1〜60 字の英数字・.・_・- で、先頭を英数字にしてください。.lock で終わる名前、main、sukuna、design- と issue- で始まる名前は使えません",
        },
      });
    },
  );

  it.each(["folder", "worktree", "branch"])(
    "同じ名前の %s があると conflict を返す",
    async (kind) => {
      if (kind === "folder")
        mkdirSync(join(cwd, ".claude/worktrees", "duplicate"), { recursive: true });
      if (kind === "worktree") add("duplicate");
      if (kind === "branch")
        git(["worktree", "add", "-b", "duplicate", join(root, "elsewhere"), "main"]);
      const response = await request("/api/projects/p/worktrees", "POST", { name: "duplicate" });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: {
          code: "conflict",
          message: "同じ名前の worktree、フォルダ、または使用中のブランチがあります",
        },
      });
    },
  );

  it("同時に同じ名前を作っても 1 件だけ成功する", async () => {
    const responses = await Promise.all([
      request("/api/projects/p/worktrees", "POST", { name: "race" }),
      request("/api/projects/p/worktrees", "POST", { name: "race" }),
    ]);
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([201, 409]);
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM worktrees WHERE removed_at IS NULL")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("git の失敗は最初のエラー行を worktree_failed で返す", async () => {
    const response = await request(
      "/api/projects/p/worktrees",
      "POST",
      { name: "error" },
      createGitCli({
        run: () =>
          Promise.resolve({
            stdout: "",
            stderr: "fatal: test failure\nsecond line\n",
            exitCode: 1,
          }),
      }),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "worktree_failed", message: "fatal: test failure" },
    });
  });

  it("存在しないか解除したプロジェクトと削除済み worktree は 404", async () => {
    database.sqlite.prepare("UPDATE projects SET removed_at = 1").run();
    for (const [path, method, body] of [
      ["/api/projects/p/worktrees", "GET", undefined],
      ["/api/projects/p/worktrees", "POST", { name: "try" }],
      ["/api/projects/unknown/worktrees", "GET", undefined],
      ["/api/projects/unknown/worktrees", "POST", { name: "try" }],
      ["/api/worktrees/unknown", "DELETE", undefined],
    ] as const) {
      const response = await request(path, method, body);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: {
          code: "not_found",
          message: method === "DELETE" ? "worktree がありません" : "プロジェクトがありません",
        },
      });
    }
  });

  it("改行のあるパスと rename は変更を 1 件ずつ数え、サンプルは先頭 5 件に限る", async () => {
    const path = add("paths");
    record("w", path, "paths");
    git(["mv", "README.md", "renamed\nfile.md"], path);
    for (const name of ["a", "b", "c", "d", "e", "f"]) writeFileSync(join(path, name), "new");
    const response = await request("/api/projects/p/worktrees");
    expect(response.status).toBe(200);
    expect(worktreeListSchema.parse(await response.json()).worktrees.at(1)).toEqual(
      row("paths", {
        id: "w",
        uncommittedCount: 7,
        uncommittedSample: ["renamed\nfile.md", "a", "b", "c", "d"],
      }),
    );
  });

  it("detached HEAD の外部 worktree は branch を null として一覧に出す", async () => {
    const path = join(root, "detached");
    git(["worktree", "add", "--detach", path, "main"]);
    const response = await request("/api/projects/p/worktrees");
    expect(response.status).toBe(200);
    expect(worktreeListSchema.parse(await response.json()).worktrees.at(1)).toEqual(
      row("detached", { path, branch: null }),
    );
  });

  it("リモートの無いプロジェクトでは既定ブランチにないコミットだけ数える", async () => {
    git(["remote", "remove", "origin"]);
    const path = add("local");
    record("w", path, "local");
    git(["commit", "--allow-empty", "-qm", "local"], path);
    const response = await request("/api/projects/p/worktrees");
    expect(response.status).toBe(200);
    expect(worktreeListSchema.parse(await response.json()).worktrees.at(1)).toEqual(
      row("local", { id: "w", unpushedCount: 1 }),
    );
  });

  it("git add が失敗すると予約した記録を削除済みにし、同じ名前でやり直せる", async () => {
    const real = createGitCli();
    const failure: GitRunner = {
      run: (args, options) =>
        args[0] === "worktree" && args[1] === "add"
          ? Promise.resolve({ stdout: "", stderr: "fatal: add failed\nsecond line", exitCode: 1 })
          : real.run(args, options),
    };
    const response = await request("/api/projects/p/worktrees", "POST", { name: "retry" }, failure);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "worktree_failed", message: "fatal: add failed" },
    });
    expect(database.sqlite.prepare("SELECT removed_at FROM worktrees").all()).toEqual([
      { removed_at: 12345 },
    ]);
    expect(await create("retry")).toEqual({ ...row("retry"), notice: null });
  });

  it("消す検査の間に AI が動き始めたら、最新の状態で拒否する", async () => {
    const created = await create("started");
    conversation("busy", created.path);
    const real = createGitCli();
    const changing: GitRunner = {
      async run(args, options) {
        const result = await real.run(args, options);
        if (args[0] === "status")
          database.sqlite
            .prepare("UPDATE conversations SET run_state = 'working' WHERE id = 'busy'")
            .run();
        return result;
      },
    };
    const response = await request(`/api/worktrees/${created.id}`, "DELETE", undefined, changing);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "conflict",
        message: "会話: 会話 busy の AI が動いています。止めてから消してください",
        details: { reason: "running", count: 0, sample: [] },
      },
    });
    expect(existsSync(created.path)).toBe(true);
  });

  it("現在の HEAD の PR 照合中に AI が動き始めても、フォルダを消す前に拒否する", async () => {
    const created = await create("late-ai");
    git(["commit", "--allow-empty", "-qm", "merged elsewhere"], created.path);
    const head = git(["rev-parse", "HEAD"], created.path);
    issue("done", "https://github.com/test/repo/pull/1");
    database.sqlite
      .prepare("UPDATE worktrees SET origin = 'flow', issue_id = 'i' WHERE id = ?")
      .run(created.id);
    conversation("busy", created.path);
    gh = new ScriptedGh({
      responses: [],
      fallback: { stdout: JSON.stringify({ state: "MERGED", headRefOid: head }), exit_code: 0 },
    });
    const run = gh.run.bind(gh);
    gh.run = async (args, options) => {
      const result = await run(args, options);
      if (gh.calls.length === 1)
        database.sqlite
          .prepare("UPDATE conversations SET run_state = 'working' WHERE id = 'busy'")
          .run();
      return result;
    };
    const response = await request(`/api/worktrees/${created.id}`, "DELETE");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "conflict",
        message: "会話: 会話 busy の AI が動いています。止めてから消してください",
        details: { reason: "running", count: 0, sample: [] },
      },
    });
    expect(existsSync(created.path)).toBe(true);
    expect(git(["rev-parse", "refs/heads/late-ai"])).toBe(head);
  });

  it.each(
    ["identity", "save"].flatMap((stage) =>
      ["working", "waiting_answer", "waiting_permission", "ready"].map((state) => ({
        stage,
        state,
      })),
    ),
  )("削除の $stage 中に $state へ変わった状態を削除直前に拒否する", async ({ stage, state }) => {
    const path = add("last-state");
    issue("done");
    record("w", path, "last-state", state === "ready" ? "flow" : "user", "i", true);
    conversation("c", path);
    let changed = false;
    const change = () => {
      if (changed) return;
      changed = true;
      if (state === "ready")
        database.sqlite.prepare("UPDATE issues SET state='ready' WHERE id='i'").run();
      else database.sqlite.prepare("UPDATE conversations SET run_state=? WHERE id='c'").run(state);
    };
    const response = await request("/api/worktrees/w", "DELETE", undefined, undefined, (deps) => ({
      ...deps,
      removals: {
        ...deps.removals,
        async identity(project, path) {
          const result = await deps.removals.identity(project, path);
          if (stage === "identity") change();
          return result;
        },
        async save(project, id, plan) {
          const result = await deps.removals.save(project, id, plan);
          if (stage === "save") change();
          return result;
        },
      },
    }));
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 409,
      body: {
        error: {
          code: "conflict",
          message:
            state === "ready"
              ? "issue #42 の自動フローが使っています。issue が閉じると片付けられます"
              : "会話: 会話 c の AI が動いています。止めてから消してください",
          details: { reason: state === "ready" ? "flow" : "running", count: 0, sample: [] },
        },
      },
    });
    expect(existsSync(path)).toBe(true);
  });

  it.each(
    ["identity", "save"].flatMap((stage) =>
      ["start", "send", "resume", "flow", "switch", "unrelated"].map((operation) => ({
        stage,
        operation,
      })),
    ),
  )(
    "削除の $stage 中は別接続の $operation が同じ worktree を使わない",
    async ({ stage, operation }) => {
      const path = add("lease-target");
      issue("done");
      record("w", path, "lease-target", "flow", "i", true);
      conversation("c", path);
      if (operation === "resume")
        database.sqlite
          .prepare(
            "UPDATE conversations SET run_state='stopped', stop_reason='restarted' WHERE id='c'",
          )
          .run();
      const otherPath = add("other");
      record("other", otherPath, "other");
      conversation("other-c", otherPath);
      database.sqlite
        .prepare("UPDATE conversations SET worktree_id='other' WHERE id='other-c'")
        .run();
      const runnerDb = openDatabase(home);
      const runtime = new ConversationRuntime({
        store: new SqliteConversationStore(runnerDb.sqlite),
        agent: new ScriptedAgent({ rules: [], fallback: [{ hold: true }] }),
        images: createImageFiles(home),
        clock: systemClock,
        id: () => "new-conversation",
        uuid: () => "new-session",
        log: () => {},
        notice: () => {},
      });
      let attempted = false;
      let outcome: unknown;
      const attempt = async () => {
        if (attempted) return;
        attempted = true;
        if (operation === "flow") {
          const ops = createIssueOperations(
            runnerDb,
            { now: () => 0, id: () => "new-issue" },
            { publish: () => {} },
            { stop: async () => {} },
          );
          const result = ops.reopen("i");
          outcome = result.isErr() ? result.error : result.value;
        } else if (operation === "switch") {
          try {
            createWorktreeActivity(runnerDb.sqlite.name).run((reservation) => {
              reservation.acquire(["w"]);
              runnerDb.sqlite
                .prepare("UPDATE conversations SET cwd = ? WHERE id='other-c'")
                .run(path);
            });
          } catch (error) {
            if (!(error instanceof WorktreeActivityBusy)) throw error;
            outcome = { code: "conflict", message: error.message };
          }
        } else {
          const result =
            operation === "start"
              ? await runtime.start({
                  projectId: "p",
                  kind: "chat",
                  cwd: path,
                  worktreeId: "w",
                  title: "new",
                })
              : operation === "resume"
                ? await runtime.resume("c")
                : await runtime.send(operation === "unrelated" ? "other-c" : "c", {
                    text: "continue",
                    images: [],
                    origin: "developer",
                  });
          outcome = result.isErr() ? result.error : result.value;
        }
      };
      try {
        const response = await request(
          "/api/worktrees/w",
          "DELETE",
          undefined,
          undefined,
          (deps) => ({
            ...deps,
            removals: {
              ...deps.removals,
              async identity(project, target) {
                const result = await deps.removals.identity(project, target);
                if (stage === "identity") await attempt();
                return result;
              },
              async save(project, id, plan) {
                const result = await deps.removals.save(project, id, plan);
                if (stage === "save") await attempt();
                return result;
              },
            },
          }),
        );
        expect({ status: response.status, body: await response.json() }).toEqual({
          status: 200,
          body: { removedBranch: false, movedConversationIds: ["c"] },
        });
        expect(outcome).toEqual(
          operation === "unrelated"
            ? { result: "delivered", seq: 1 }
            : operation === "flow"
              ? {
                  code: "conflict",
                  message: "issue の状態が変わりました。読み直してから操作してください。",
                }
              : {
                  code: "conflict",
                  message: "worktree を削除しています。完了してから、もう一度操作してください",
                },
        );
        expect(existsSync(path)).toBe(false);
      } finally {
        await runtime.shutdown();
        runnerDb.close();
      }
    },
  );

  function ipcRunner(
    agent: AgentPort & Pick<ScriptedAgent, "opened"> = new ScriptedAgent({
      rules: [],
      fallback: [{ hold: true }],
    }),
    clock: Clock = systemClock,
  ) {
    const runnerDb = openDatabase(home);
    let nextId = 0;
    const runtime = new ConversationRuntime({
      store: new SqliteConversationStore(runnerDb.sqlite),
      agent,
      images: createImageFiles(home),
      clock,
      id: () => `new-c-${++nextId}`,
      uuid: () => "new-session",
      log: () => {},
      notice: () => {},
    });
    const ipc = createIpcRoutes(runtime, () => {});
    return {
      runnerDb,
      agent,
      runtime,
      async until(predicate: () => boolean) {
        if (predicate()) return;
        await new Promise<void>((resolve) => {
          const off = runtime.subscribe(() => {
            if (predicate()) {
              off();
              resolve();
            }
          });
        });
      },
      async post(path: string, body: unknown) {
        const response = await ipc.request(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      },
      async close() {
        await runtime.shutdown();
        runnerDb.close();
      },
    };
  }

  it.each(
    (["scripted", "sdk"] as const).flatMap((backend) =>
      ["success", "stopped", "queue", "failed", "usage", "timer", "keep", "released"].map(
        (mode) => ({ backend, mode }),
      ),
    ),
  )(
    "$backend は worktree 削除後の $mode を現在の作業場所と同じセッションで実行する",
    async ({ backend, mode }) => {
      const path = add("cached-session");
      record("w", path, "cached-session");
      const observed = createWorkspaceAgent(backend);
      const clock = new WorkspaceClock();
      const runner = ipcRunner(observed.agent, clock);
      try {
        expect(
          await runner.post("/conversations", {
            project_id: "p",
            kind: "chat",
            cwd: path,
            worktree_id: "w",
            title: "続きの作業",
          }),
        ).toEqual({ status: 200, body: { conversation_id: "new-c-1" } });
        let client = 0;
        const send = (text: string, images: string[] = []) =>
          runner.post("/conversations/new-c-1/messages", {
            text,
            images,
            interrupt: false,
            client_id: `input-${++client}`,
            origin: "developer",
          });
        const first =
          mode === "stopped" || mode === "queue"
            ? "first-hold"
            : mode === "failed"
              ? "first-failed"
              : mode === "usage" || mode === "timer"
                ? "first-usage"
                : "first-success";
        expect(await send(first)).toEqual({ status: 200, body: { result: "delivered", seq: 1 } });
        await runner.until(() =>
          runner.runtime.store.events("new-c-1").some((event) => event.type === "tool_result"),
        );
        const initialTool = runner.runtime.store
          .events("new-c-1")
          .find((event) => event.type === "tool_result");
        expect(initialTool?.payload).toEqual({
          tool_use_id: expect.any(String),
          content: `${path}\n`,
          is_error: false,
          bytes: Buffer.byteLength(`${path}\n`),
          truncated: false,
        });
        const image = Buffer.from([137, 80, 78, 71]);
        const images = join(home, "images", "new-c-1");
        mkdirSync(images, { recursive: true });
        writeFileSync(join(images, "one.png"), image);
        if (first === "first-hold") {
          const busy = await request("/api/worktrees/w", "DELETE");
          expect(busy.status).toBe(409);
          if (mode === "queue")
            expect(await send("queued", ["one"])).toEqual({
              status: 200,
              body: { result: "queued", queued_id: "new-c-2" },
            });
          expect((await runner.post("/conversations/new-c-1/stop", {})).status).toBe(200);
        } else
          await runner.until(() => runner.runtime.store.get("new-c-1")?.runState !== "working");
        const sessionId = runner.runtime.store.get("new-c-1")?.sessionId;
        expect(sessionId).toBe("new-session");
        if (mode === "released")
          expect((await runner.post("/conversations/new-c-1/release", {})).status).toBe(200);
        if (mode !== "keep") {
          const removed = await request("/api/worktrees/w", "DELETE");
          expect({ status: removed.status, body: await removed.json() }).toEqual({
            status: 200,
            body: { removedBranch: false, movedConversationIds: ["new-c-1"] },
          });
          expect(existsSync(path)).toBe(false);
        }
        if (mode === "timer") {
          expect(clock.timers.size).toBe(1);
          await clock.advance(69000);
        } else if (mode === "usage" || mode === "failed") {
          expect((await runner.post("/conversations/new-c-1/resume", {})).status).toBe(200);
        } else if (mode === "queue") {
          expect((await runner.post("/conversations/new-c-1/queue/deliver", {})).status).toBe(200);
        } else expect((await send("again", ["one"])).status).toBe(200);
        await runner.until(() => runner.runtime.store.get("new-c-1")?.runState !== "working");
        const target = mode === "keep" ? path : cwd;
        const results = runner.runtime.store
          .events("new-c-1")
          .filter((event) => event.type === "tool_result");
        expect(results.map((event) => event.payload)).toEqual([
          {
            tool_use_id: expect.any(String),
            content: `${path}\n`,
            is_error: false,
            bytes: Buffer.byteLength(`${path}\n`),
            truncated: false,
          },
          {
            tool_use_id: expect.any(String),
            content: `${target}\n`,
            is_error: false,
            bytes: Buffer.byteLength(`${target}\n`),
            truncated: false,
          },
        ]);
        expect(
          observed.opened.map((params) => ({
            cwd: params.cwd,
            resume: params.resume,
            sessionId: params.sessionId,
          })),
        ).toEqual([
          { cwd: path, resume: false, sessionId },
          ...(mode === "keep" ? [] : [{ cwd: target, resume: true, sessionId }]),
        ]);
        expect({
          queue: runner.runtime.store.queue("new-c-1"),
          timers: clock.timers.size,
          sessionId: runner.runtime.store.get("new-c-1")?.sessionId,
        }).toEqual({ queue: [], timers: 0, sessionId });
        if (!["usage", "failed", "timer"].includes(mode))
          expect(observed.delivered.at(-1)).toEqual({
            text: mode === "queue" ? "queued" : "again",
            images: [{ data: image, mediaType: "image/png" }],
          });
      } finally {
        await runner.close();
      }
    },
  );

  it.each(
    (["scripted", "sdk"] as const).flatMap((backend) =>
      ["same-path-new-id", "same-path-cwd-only", "move-while-closing", "remove-while-closing"].map(
        (change) => ({
          backend,
          change,
        }),
      ),
    ),
  )("$backend は実行の終了待ちの後に作業場所を確かめ直す: $change", async ({ backend, change }) => {
    const path = add("close-target");
    record("w", path, "close-target");
    const observed = createWorkspaceAgent(backend);
    const runner = ipcRunner(observed.agent, new WorkspaceClock());
    let finishClose: (() => void) | undefined;
    let didClose: () => void;
    const closing = new Promise<void>((resolve) => {
      didClose = resolve;
    });
    observed.delayClose((finish) => {
      finishClose = finish;
      didClose();
    });
    const relocate = (path: string, worktreeId: string) =>
      createWorktreeActivity(runner.runnerDb.sqlite.name).run((reservation) => {
        reservation.acquire([worktreeId]);
        runner.runnerDb.sqlite
          .transaction(() => {
            runner.runnerDb.sqlite
              .prepare("UPDATE conversations SET cwd=?,worktree_id=? WHERE id='new-c-1' AND cwd=?")
              .run(path, change === "same-path-cwd-only" ? null : worktreeId, cwd);
          })
          .immediate();
      });
    try {
      expect(
        (
          await runner.post("/conversations", {
            project_id: "p",
            kind: "chat",
            cwd: path,
            worktree_id: change === "same-path-cwd-only" ? null : "w",
            title: "終了待ち",
          })
        ).status,
      ).toBe(200);
      const send = (text: string, images: string[] = []) =>
        runner.post("/conversations/new-c-1/messages", {
          text,
          images,
          interrupt: false,
          client_id: text,
          origin: "developer",
        });
      expect((await send("first-hold")).status).toBe(200);
      await runner.until(() =>
        runner.runtime.store.events("new-c-1").some((event) => event.type === "tool_result"),
      );
      const image = Buffer.from([137, 80, 78, 71]);
      mkdirSync(join(home, "images", "new-c-1"), { recursive: true });
      writeFileSync(join(home, "images", "new-c-1", "one.png"), image);
      expect(await send("queued", ["one"])).toEqual({
        status: 200,
        body: { result: "queued", queued_id: "new-c-2" },
      });
      expect((await runner.post("/conversations/new-c-1/stop", {})).status).toBe(200);
      expect((await request("/api/worktrees/w", "DELETE")).status).toBe(200);
      if (change.startsWith("same-path")) {
        const replacement = await create("close-target");
        if (replacement.id === null) throw new Error("作成した worktree の id がありません");
        relocate(replacement.path, replacement.id);
      }
      const pending = runner.post("/conversations/new-c-1/queue/deliver", {});
      await Promise.race([
        closing,
        pending.then(() => {
          throw new Error("別の worktree では実行を閉じてから配達してください");
        }),
      ]);
      expect({
        opened: observed.opened.length,
        closed: observed.closed,
        queue: runner.runtime.store.queue("new-c-1"),
      }).toEqual({
        opened: 1,
        closed: [0],
        queue: [
          {
            id: "new-c-2",
            conversationId: "new-c-1",
            text: "queued",
            images: ["one"],
            position: 1,
            clientId: "queued",
            createdAt: 1000,
          },
        ],
      });
      let target = change.startsWith("same-path") ? path : cwd;
      if (!change.startsWith("same-path")) {
        const next = add("closing-next");
        record("next", next, "closing-next");
        relocate(next, "next");
        if (change === "remove-while-closing") {
          const removed = await request(
            "/api/worktrees/next",
            "DELETE",
            undefined,
            undefined,
            (deps) => ({
              ...deps,
              removals: {
                ...deps.removals,
                async save(project, id, plan) {
                  const saved = await deps.removals.save(project, id, plan);
                  finishClose!();
                  expect(await pending).toEqual({
                    status: 409,
                    body: {
                      error: {
                        code: "conflict",
                        message:
                          "worktree を削除しています。完了してから、もう一度操作してください",
                      },
                    },
                  });
                  return saved;
                },
              },
            }),
          );
          expect({ status: removed.status, body: await removed.json() }).toEqual({
            status: 200,
            body: { removedBranch: false, movedConversationIds: ["new-c-1"] },
          });
          expect((await runner.post("/conversations/new-c-1/queue/deliver", {})).status).toBe(200);
        } else {
          target = next;
          finishClose!();
          expect((await pending).status).toBe(200);
        }
      } else {
        finishClose!();
        expect((await pending).status).toBe(200);
      }
      await runner.until(() => runner.runtime.store.get("new-c-1")?.runState === "idle");
      expect(
        observed.opened.map((params) => ({
          cwd: params.cwd,
          sessionId: params.sessionId,
          resume: params.resume,
        })),
      ).toEqual([
        { cwd: path, sessionId: "new-session", resume: false },
        { cwd: target, sessionId: "new-session", resume: true },
      ]);
      expect(observed.delivered).toEqual([
        { text: "first-hold", images: [] },
        { text: "queued", images: [{ data: image, mediaType: "image/png" }] },
      ]);
      const results = runner.runtime.store
        .events("new-c-1")
        .filter((event) => event.type === "tool_result");
      expect(results.map((event) => event.payload)).toEqual([
        {
          tool_use_id: expect.any(String),
          content: `${path}\n`,
          is_error: false,
          bytes: Buffer.byteLength(`${path}\n`),
          truncated: false,
        },
        {
          tool_use_id: expect.any(String),
          content: `${target}\n`,
          is_error: false,
          bytes: Buffer.byteLength(`${target}\n`),
          truncated: false,
        },
      ]);
      expect({
        queue: runner.runtime.store.queue("new-c-1"),
        cached: runner.runtime.executions.size,
      }).toEqual({ queue: [], cached: 1 });
    } finally {
      finishClose?.();
      observed.delayClose((finish) => finish());
      await runner.close();
    }
  });

  it.each(
    ["save", "clear", "after"].flatMap((stage) =>
      [true, false].flatMap((withId) =>
        [true, false].map((message) => ({ stage, withId, message })),
      ),
    ),
  )(
    "削除の $stage では古い作業場所の会話開始を拒否する (id=$withId, 初回指示=$message)",
    async ({ stage, withId, message }) => {
      const path = add("removed-start");
      record("w", path, "removed-start");
      const runner = ipcRunner();
      let outcome: unknown;
      let attempted = false;
      const attempt = async () => {
        if (attempted) return;
        attempted = true;
        outcome = await runner.post("/conversations", {
          project_id: "p",
          kind: "chat",
          cwd: path,
          worktree_id: withId ? "w" : null,
          title: "古い作業場所",
          ...(message ? { message: "start" } : {}),
        });
      };
      try {
        const removed = await request(
          "/api/worktrees/w",
          "DELETE",
          undefined,
          undefined,
          (deps) => ({
            ...deps,
            removals: {
              ...deps.removals,
              async save(project, id, plan) {
                const result = await deps.removals.save(project, id, plan);
                if (stage === "save") await attempt();
                return result;
              },
              async clear(project, id) {
                const result = await deps.removals.clear(project, id);
                if (stage === "clear") await attempt();
                return result;
              },
            },
          }),
        );
        if (stage === "after") await attempt();
        expect({ status: removed.status, body: await removed.json() }).toEqual({
          status: 200,
          body: { removedBranch: false, movedConversationIds: [] },
        });
        expect(outcome).toEqual({
          status: 409,
          body: {
            error: {
              code: "conflict",
              message:
                stage === "after"
                  ? "作業場所が変わりました。worktree の一覧を読み直してから、もう一度操作してください"
                  : "worktree を削除しています。完了してから、もう一度操作してください",
            },
          },
        });
        expect({
          conversations: runner.runnerDb.sqlite.prepare("SELECT id FROM conversations").all(),
          opened: runner.agent.opened.length,
          directory: existsSync(path),
          branch: git(["branch", "--list", "removed-start"]),
        }).toEqual({ conversations: [], opened: 0, directory: false, branch: "removed-start" });
      } finally {
        await runner.close();
      }
    },
  );

  it.each(
    ["clear", "after"].flatMap((stage) =>
      ["unrelated", "project", "moved", "fork", "recreated-id", "recreated-cwd", "stale-id"].map(
        (operation) => ({ stage, operation }),
      ),
    ),
  )(
    "削除の $stage では現在の作業場所に従って開始・送信する: $operation",
    async ({ stage, operation }) => {
      const path = add("deleted-control");
      record("w", path, "deleted-control");
      conversation("c", path);
      const other = add("valid-other");
      record("other", other, "valid-other");
      conversation("other-c", other);
      database.sqlite
        .prepare("UPDATE conversations SET worktree_id='other', session_id='s' WHERE id='other-c'")
        .run();
      const runner = ipcRunner();
      let outcome: unknown;
      let targetPath = cwd;
      let targetId: string | null = null;
      let conversationId = "new-c-1";
      const attempt = async () => {
        if (operation.startsWith("recreated") || operation === "stale-id") {
          const recreated = await create("deleted-control");
          targetPath = recreated.path;
          targetId =
            operation === "recreated-cwd" ? null : operation === "stale-id" ? "w" : recreated.id;
        } else if (operation === "unrelated") {
          targetPath = other;
          targetId = "other";
        }
        if (operation === "moved") {
          conversationId = "c";
          outcome = await runner.post("/conversations/c/messages", {
            text: "continue",
            images: [],
            interrupt: false,
            client_id: "moved",
            origin: "developer",
          });
        } else if (operation === "fork") {
          targetPath = other;
          targetId = "other";
          outcome = await runner.post("/conversations/other-c/fork", {
            title: "分岐",
            kind: "thread",
          });
          expect(outcome).toEqual({ status: 200, body: { conversation_id: conversationId } });
          outcome = await runner.post(`/conversations/${conversationId}/messages`, {
            text: "continue",
            images: [],
            interrupt: false,
            client_id: "forked",
            origin: "developer",
          });
        } else {
          outcome = await runner.post("/conversations", {
            project_id: "p",
            kind: "chat",
            cwd: targetPath,
            worktree_id: targetId,
            title: "有効な作業場所",
            message: "start",
          });
        }
      };
      try {
        const removed = await request(
          "/api/worktrees/w",
          "DELETE",
          undefined,
          undefined,
          (deps) => ({
            ...deps,
            removals: {
              ...deps.removals,
              async clear(project, id) {
                const result = await deps.removals.clear(project, id);
                if (stage === "clear") await attempt();
                return result;
              },
            },
          }),
        );
        if (stage === "after") await attempt();
        expect({ status: removed.status, body: await removed.json() }).toEqual({
          status: 200,
          body: { removedBranch: false, movedConversationIds: ["c"] },
        });
        if (operation === "stale-id") {
          expect(outcome).toEqual({
            status: 409,
            body: {
              error: {
                code: "conflict",
                message:
                  stage === "clear"
                    ? "worktree を削除しています。完了してから、もう一度操作してください"
                    : "作業場所が変わりました。worktree の一覧を読み直してから、もう一度操作してください",
              },
            },
          });
          expect({
            created: runner.runtime.store.get(conversationId),
            opened: runner.agent.opened.length,
          }).toEqual({ created: null, opened: 0 });
        } else {
          expect(outcome).toEqual({
            status: 200,
            body:
              operation === "moved" || operation === "fork"
                ? { result: "delivered", seq: 1 }
                : { conversation_id: conversationId },
          });
          expect(
            runner.runnerDb.sqlite
              .prepare("SELECT cwd, worktree_id, run_state FROM conversations WHERE id=?")
              .get(conversationId),
          ).toEqual({ cwd: targetPath, worktree_id: targetId, run_state: "working" });
          expect(
            runner.agent.opened.map((params) => ({
              cwd: params.cwd,
              id: params.context.conversationId,
            })),
          ).toEqual([{ cwd: targetPath, id: conversationId }]);
        }
      } finally {
        await runner.close();
      }
    },
  );

  it.each(
    ["missing", "mismatched"].flatMap((workspace) =>
      ["start", "send", "resume"].map((operation) => ({ workspace, operation })),
    ),
  )(
    "作業場所が $workspace の会話は $operation で AI を実行しない",
    async ({ workspace, operation }) => {
      const path = add("invalid-location");
      record("w", path, "invalid-location");
      const target = workspace === "missing" ? path : cwd;
      conversation("c", target, operation === "resume" ? "stopped" : "idle");
      if (operation === "resume")
        database.sqlite
          .prepare("UPDATE conversations SET stop_reason='restarted' WHERE id='c'")
          .run();
      if (workspace === "missing") git(["worktree", "remove", path]);
      const runner = ipcRunner();
      try {
        const outcome =
          operation === "start"
            ? await runner.post("/conversations", {
                project_id: "p",
                kind: "chat",
                cwd: target,
                worktree_id: "w",
                title: "無効な作業場所",
              })
            : operation === "resume"
              ? await runner.post("/conversations/c/resume", {})
              : await runner.post("/conversations/c/messages", {
                  text: "start",
                  images: [],
                  interrupt: false,
                  client_id: "invalid",
                  origin: "developer",
                });
        expect(outcome).toEqual({
          status: 409,
          body: {
            error: {
              code: "conflict",
              message:
                "作業場所が変わりました。worktree の一覧を読み直してから、もう一度操作してください",
            },
          },
        });
        expect({
          opened: runner.agent.opened.length,
          created: runner.runtime.store.get("new-c-1"),
          state: runner.runnerDb.sqlite
            .prepare("SELECT cwd, worktree_id, run_state, last_seq FROM conversations WHERE id='c'")
            .get(),
        }).toEqual({
          opened: 0,
          created: null,
          state: {
            cwd: target,
            worktree_id: "w",
            run_state: operation === "resume" ? "stopped" : "idle",
            last_seq: 0,
          },
        });
      } finally {
        await runner.close();
      }
    },
  );

  it("git で消す間に移動した会話の cwd と worktree_id は上書きしない", async () => {
    const created = await create("moved");
    conversation("c", created.path);
    const real = createGitCli();
    const changing: GitRunner = {
      async run(args, options) {
        const result = await real.run(args, options);
        if (args[0] === "worktree" && args[1] === "remove")
          database.sqlite
            .prepare("UPDATE conversations SET cwd = ?, worktree_id = 'other' WHERE id = 'c'")
            .run(root);
        return result;
      },
    };
    const response = await request(`/api/worktrees/${created.id}`, "DELETE", undefined, changing);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removedBranch: false, movedConversationIds: [] });
    expect(
      database.sqlite.prepare("SELECT cwd, worktree_id FROM conversations WHERE id = 'c'").get(),
    ).toEqual({ cwd: root, worktree_id: "other" });
  });

  it.each(["after-list", "after-status"])(
    "削除の %s で増えたコミットへの参照を残す",
    async (stage) => {
      const created = await create("head-race");
      const originalHead = git(["rev-parse", "HEAD"], created.path);
      issue("done", "https://github.com/test/repo/pull/1");
      database.sqlite
        .prepare("UPDATE worktrees SET origin = 'flow', issue_id = 'i' WHERE id = ?")
        .run(created.id);
      gh = new ScriptedGh({
        responses: [],
        fallback: {
          stdout: JSON.stringify({ state: "MERGED", headRefOid: originalHead }),
          exit_code: 0,
        },
      });
      conversation("c", created.path);
      let privateHead = "";
      const real = createGitCli();
      const changing: GitRunner = {
        async run(args, options) {
          const result = await real.run(args, options);
          if (
            !privateHead &&
            ((stage === "after-list" && args[0] === "worktree" && args[1] === "list") ||
              (stage === "after-status" && args[0] === "status"))
          ) {
            git(["commit", "--allow-empty", "-qm", "raced"], created.path);
            privateHead = git(["rev-parse", "HEAD"], created.path);
          }
          return result;
        },
      };
      const response = await request(`/api/worktrees/${created.id}`, "DELETE", undefined, changing);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: {
          code: "conflict",
          message: "未 push のコミットがあるため消していません",
          details: { reason: "unpushed", count: 1, sample: [] },
        },
      });
      expect(git(["rev-parse", "refs/heads/head-race"])).toBe(privateHead);
      expect(git(["for-each-ref", "--format=%(refname)", "--contains", privateHead])).toBe(
        "refs/heads/head-race",
      );
      expect(database.sqlite.prepare("SELECT cwd FROM conversations WHERE id = 'c'").get()).toEqual(
        { cwd: existsSync(created.path) ? created.path : cwd },
      );
    },
  );

  it.each(["GET", "POST"])("%s の応答も status の後の現在の HEAD を使う", async (method) => {
    const name = method === "GET" ? "get-head" : "post-head";
    const path = join(cwd, ".claude/worktrees", name);
    if (method === "GET") {
      const created = await create(name);
      const oldHead = git(["rev-parse", "HEAD"], path);
      issue("done", "https://github.com/test/repo/pull/1");
      database.sqlite
        .prepare("UPDATE worktrees SET origin = 'flow', issue_id = 'i' WHERE id = ?")
        .run(created.id);
      gh = new ScriptedGh({
        responses: [],
        fallback: {
          stdout: JSON.stringify({ state: "MERGED", headRefOid: oldHead }),
          exit_code: 0,
        },
      });
    }
    let committed = false;
    const real = createGitCli();
    const changing: GitRunner = {
      async run(args, options) {
        const result = await real.run(args, options);
        if (!committed && args[0] === "status" && options.cwd === path) {
          git(["commit", "--allow-empty", "-qm", "new head"], path);
          committed = true;
        }
        return result;
      },
    };
    const response = await request(
      "/api/projects/p/worktrees",
      method,
      method === "POST" ? { name } : undefined,
      changing,
    );
    expect(response.status).toBe(method === "POST" ? 201 : 200);
    if (method === "GET")
      expect(
        worktreeListSchema
          .parse(await response.json())
          .worktrees.find((entry) => entry.path === path),
      ).toEqual(
        row(name, {
          origin: "flow",
          issue: { id: "i", number: 42, title: "予約 API", state: "done" },
          unpushedCount: 1,
        }),
      );
    else
      expect(worktreeCreatedSchema.parse(await response.json())).toEqual({
        ...row(name, { unpushedCount: 1 }),
        notice: null,
      });
  });

  it.each(["branch", "other", "detached"])(
    "フォルダ削除中は %s の HEAD に未検証のコミットを追加できない",
    async (checkout) => {
      const created = await create("guarded");
      if (checkout === "detached") git(["checkout", "-q", "--detach", "main"], created.path);
      if (checkout === "other") git(["checkout", "-qb", "other", "main"], created.path);
      let commitExit: number | null = null;
      const real = createGitCli();
      const changing: GitRunner = {
        async run(args, options) {
          if (args[0] === "worktree" && args[1] === "remove") {
            commitExit = spawnSync(
              "git",
              [
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--allow-empty",
                "-qm",
                "unverified",
              ],
              { cwd: created.path, encoding: "utf8" },
            ).status;
          }
          return real.run(args, options);
        },
      };
      const response = await request(`/api/worktrees/${created.id}`, "DELETE", undefined, changing);
      expect({ commitExit, status: response.status, body: await response.json() }).toEqual({
        commitExit: 128,
        status: 200,
        body: { removedBranch: false, movedConversationIds: [] },
      });
      expect(git(["branch", "--list", "guarded"])).toBe("guarded");
    },
  );

  it.each(
    [true, false].flatMap((owned) =>
      ["same", "other", "detached"].map((checkout) => ({ owned, checkout })),
    ),
  )(
    "現在の HEAD の未 push だけで $checkout / owned=$owned の削除を判定し保存ブランチを残す",
    async ({ owned, checkout }) => {
      const path = add("owned");
      record("w", path, "owned", "user", null, owned);
      git(["commit", "--allow-empty", "-qm", "private"], path);
      const privateHead = git(["rev-parse", "HEAD"], path);
      if (checkout === "other") git(["checkout", "-qb", "other", "main"], path);
      if (checkout === "detached") git(["checkout", "-q", "--detach", "main"], path);
      const response = await request("/api/worktrees/w", "DELETE");
      const protectedCommit = checkout === "same";
      expect(response.status).toBe(protectedCommit ? 409 : 200);
      expect(await response.json()).toEqual(
        protectedCommit
          ? {
              error: {
                code: "conflict",
                message: "未 push のコミットがあるため消していません",
                details: { reason: "unpushed", count: 1, sample: [] },
              },
            }
          : { removedBranch: false, movedConversationIds: [] },
      );
      expect(existsSync(path)).toBe(protectedCommit);
      expect(git(["rev-parse", "refs/heads/owned"])).toBe(privateHead);
    },
  );

  it.each(
    [true, false].flatMap((owned) =>
      ["renamed", "checked-out-elsewhere"].map((scenario) => ({ owned, scenario })),
    ),
  )(
    "保存ブランチが $scenario / owned=$owned でも現在の worktree だけ削除する",
    async ({ owned, scenario }) => {
      const path = add("owned");
      record("w", path, "owned", "user", null, owned);
      conversation("c", path);
      if (scenario === "renamed") git(["branch", "-m", "owned", "renamed"], path);
      else {
        git(["checkout", "-qb", "other", "main"], path);
        git(["worktree", "add", join(root, "other-tree"), "owned"]);
      }
      const response = await request("/api/worktrees/w", "DELETE");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ removedBranch: false, movedConversationIds: ["c"] });
      expect(existsSync(path)).toBe(false);
      const remainingBranch = scenario === "renamed" ? "renamed" : "owned";
      expect(git(["branch", "--list", "--format=%(refname:short)", remainingBranch])).toBe(
        remainingBranch,
      );
      if (scenario === "checked-out-elsewhere")
        expect(git(["branch", "--show-current"], join(root, "other-tree"))).toBe("owned");
      expect(
        database.sqlite.prepare("SELECT cwd, worktree_id FROM conversations WHERE id = 'c'").get(),
      ).toEqual({ cwd, worktree_id: null });
    },
  );

  it.each(
    [true, false].flatMap((owned) =>
      ["worktrees", "conversations"].map((table) => ({ owned, table })),
    ),
  )(
    "$table 更新失敗は一括ロールバックし owned=$owned の削除を再試行できる",
    async ({ owned, table }) => {
      const path = add("retry-remove");
      record("w", path, "retry-remove", "user", null, owned);
      conversation("c", path);
      database.sqlite.exec(
        `CREATE TRIGGER reject_remove BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'temporary'); END`,
      );
      const first = await request("/api/worktrees/w", "DELETE");
      expect(first.status).toBe(500);
      expect(await first.json()).toEqual({
        error: { code: "internal", message: "worktree の記録を読み書きできませんでした" },
      });
      expect(existsSync(path)).toBe(false);
      expect(
        database.sqlite.prepare("SELECT removed_at FROM worktrees WHERE id = 'w'").get(),
      ).toEqual({ removed_at: null });
      expect(
        database.sqlite.prepare("SELECT cwd, worktree_id FROM conversations WHERE id = 'c'").get(),
      ).toEqual({ cwd: path, worktree_id: "w" });
      database.sqlite.exec("DROP TRIGGER reject_remove");
      const retried = await request("/api/worktrees/w", "DELETE");
      expect(retried.status).toBe(200);
      expect(await retried.json()).toEqual({ removedBranch: false, movedConversationIds: ["c"] });
      expect(
        database.sqlite.prepare("SELECT removed_at FROM worktrees WHERE id = 'w'").get(),
      ).toEqual({ removed_at: 12345 });
      expect(
        database.sqlite.prepare("SELECT cwd, worktree_id FROM conversations WHERE id = 'c'").get(),
      ).toEqual({ cwd, worktree_id: null });
    },
  );

  it("保存ブランチがロック中でも現在の HEAD が安全なら worktree を消してブランチを残す", async () => {
    const created = await create("branch-locked");
    const originalHead = git(["rev-parse", "HEAD"], created.path);
    git(["checkout", "-q", "--detach", "main"], created.path);
    writeFileSync(join(cwd, ".git/refs/heads/branch-locked.lock"), "external lock");
    conversation("c", created.path);
    const response = await request(`/api/worktrees/${created.id}`, "DELETE");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removedBranch: false, movedConversationIds: ["c"] });
    expect(existsSync(created.path)).toBe(false);
    expect(git(["rev-parse", "refs/heads/branch-locked"])).toBe(originalHead);
    expect(readFileSync(join(cwd, ".git/refs/heads/branch-locked.lock"), "utf8")).toBe(
      "external lock",
    );
    expect(
      database.sqlite.prepare("SELECT cwd, worktree_id FROM conversations WHERE id = 'c'").get(),
    ).toEqual({ cwd, worktree_id: null });
  });

  it("フォルダ削除後の途中記録の更新失敗でも会話を戻して再試行できる", async () => {
    const created = await create("journal-retry");
    conversation("c", created.path);
    let saves = 0;
    const first = await request(
      `/api/worktrees/${created.id}`,
      "DELETE",
      undefined,
      undefined,
      (deps) => ({
        ...deps,
        removals: {
          ...deps.removals,
          async save(project, id, plan) {
            saves += 1;
            return saves === 2
              ? err({
                  code: "internal" as const,
                  message: "worktree の削除の記録を読み書きできませんでした",
                })
              : deps.removals.save(project, id, plan);
          },
        },
      }),
    );
    expect(first.status).toBe(500);
    expect(await first.json()).toEqual({
      error: { code: "internal", message: "worktree の削除の記録を読み書きできませんでした" },
    });
    expect(
      database.sqlite.prepare("SELECT cwd, worktree_id FROM conversations WHERE id = 'c'").get(),
    ).toEqual({ cwd, worktree_id: null });
    const retried = await request(`/api/worktrees/${created.id}`, "DELETE");
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ removedBranch: false, movedConversationIds: [] });
    expect(existsSync(created.path)).toBe(false);
  });

  it.each(
    [true, false].flatMap((originalPresent) =>
      ["git", "journal", "database"].map((failure) => ({ originalPresent, failure })),
    ),
  )(
    "削除失敗後は排他を解放し再試行できる ($originalPresent / $failure)",
    async ({ originalPresent, failure }) => {
      const path = add("retry-lease");
      record("w", path, "retry-lease", "user", null, true);
      conversation("c", path);
      if (!originalPresent) rmSync(path, { recursive: true, force: true });
      if (failure === "database")
        database.sqlite.exec(
          "CREATE TRIGGER reject_remove BEFORE UPDATE OF removed_at ON worktrees BEGIN SELECT RAISE(ABORT, 'temporary'); END",
        );
      const real = createGitCli();
      const failingGit: GitRunner = {
        run: (args, options) =>
          args[0] === "worktree" && ["remove", "prune"].includes(args[1]!)
            ? Promise.resolve({ stdout: "", stderr: "fatal: temporary git failure", exitCode: 1 })
            : real.run(args, options),
      };
      const first = await request(
        "/api/worktrees/w",
        "DELETE",
        undefined,
        failure === "git" ? failingGit : undefined,
        (deps) =>
          failure === "journal"
            ? {
                ...deps,
                removals: {
                  ...deps.removals,
                  save: async () => err({ code: "internal", message: "journal unavailable" }),
                },
              }
            : deps,
      );
      expect(first.status).toBe(500);
      const lease = createWorktreeActivity(database.sqlite.name).acquire(["w"]);
      expect(lease.isOk()).toBe(true);
      if (lease.isOk()) lease.value.release();
      if (failure === "database") database.sqlite.exec("DROP TRIGGER reject_remove");
      const retried = await request("/api/worktrees/w", "DELETE");
      expect({ status: retried.status, body: await retried.json() }).toEqual({
        status: 200,
        body: { removedBranch: false, movedConversationIds: ["c"] },
      });
      expect(git(["branch", "--list", "retry-lease"])).toBe("retry-lease");
      expect(existsSync(path)).toBe(false);
    },
  );

  it.each(
    [true, false].flatMap((originalPresent) =>
      ["none", "folder", "worktree", "missing-worktree"].flatMap((replacement) =>
        [true, false].map((journalWorks) => ({ originalPresent, replacement, journalWorks })),
      ),
    ),
  )(
    "削除再試行は元フォルダ=$originalPresent / 置換=$replacement / journal=$journalWorks を識別する",
    async ({ originalPresent, replacement, journalWorks }) => {
      const path = add("recreated");
      record("w", path, "recreated", "user", null, true);
      conversation("c", path);
      if (!originalPresent) rmSync(path, { recursive: true, force: true });
      database.sqlite.exec(
        "CREATE TRIGGER reject_remove BEFORE UPDATE OF removed_at ON worktrees BEGIN SELECT RAISE(ABORT, 'temporary'); END",
      );
      let saves = 0;
      const first = await request("/api/worktrees/w", "DELETE", undefined, undefined, (deps) => ({
        ...deps,
        removals: {
          ...deps.removals,
          save(project, id, plan) {
            saves += 1;
            return !journalWorks && saves === 2
              ? Promise.resolve(err({ code: "internal" as const, message: "journal unavailable" }))
              : deps.removals.save(project, id, plan);
          },
        },
      }));
      expect(first.status).toBe(500);
      database.sqlite.exec("DROP TRIGGER reject_remove");
      if (replacement === "folder") mkdirSync(path, { recursive: true });
      if (replacement === "worktree" || replacement === "missing-worktree")
        git(["worktree", "add", "-b", "replacement", path, "main"]);
      if (replacement !== "none") writeFileSync(join(path, "keep.txt"), "replacement data");
      if (replacement === "worktree" || replacement === "missing-worktree") {
        git(["add", "keep.txt"], path);
        git(["commit", "-qm", "replacement data"], path);
        git(["push", "origin", "replacement"], path);
        if (replacement === "missing-worktree") rmSync(path, { recursive: true, force: true });
      }
      const response = await request("/api/worktrees/w", "DELETE");
      expect({ status: response.status, body: await response.json() }).toEqual(
        replacement === "none"
          ? { status: 200, body: { removedBranch: false, movedConversationIds: ["c"] } }
          : {
              status: 409,
              body: {
                error: {
                  code: "conflict",
                  message:
                    "worktree またはブランチの状態が変わりました。一覧を取り直してから、もう一度消してください",
                },
              },
            },
      );
      expect(existsSync(path)).toBe(replacement === "folder" || replacement === "worktree");
      expect(git(["worktree", "list", "--porcelain"]).includes(path)).toBe(
        replacement === "worktree" || replacement === "missing-worktree",
      );
      if (replacement === "folder" || replacement === "worktree")
        expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe("replacement data");
    },
  );

  it.each(
    [true, false].flatMap((existing) =>
      [true, false].map((fetchWorks) => ({ existing, fetchWorks })),
    ),
  )(
    "既存=$existing / fetch=$fetchWorks のnoticeは実際の開始点に一致する",
    async ({ existing, fetchWorks }) => {
      const publisher = join(root, "publisher");
      git(["clone", "-q", "-b", "main", remote, publisher]);
      git(["commit", "--allow-empty", "-qm", "remote only"], publisher);
      git(["push", "origin", "main"], publisher);
      const remoteHead = git(["rev-parse", "HEAD"], publisher);
      const localHead = git(["rev-parse", "HEAD"]);
      let existingHead = "";
      if (existing) {
        existingHead = git([
          "commit-tree",
          `${localHead}^{tree}`,
          "-p",
          localHead,
          "-m",
          "existing",
        ]);
        git(["branch", "notice", existingHead]);
      }
      database.sqlite.prepare("UPDATE projects SET uses_github = 1").run();
      if (!fetchWorks) rmSync(remote, { recursive: true, force: true });
      const created = await create("notice");
      expect(created).toEqual({
        ...row("notice", { unpushedCount: existing ? 1 : 0 }),
        notice:
          !existing && !fetchWorks
            ? "GitHub から取得できなかったので、手元の既定ブランチから作りました"
            : null,
      });
      expect(git(["rev-parse", "HEAD"], created.path)).toBe(
        existing ? existingHead : fetchWorks ? remoteHead : localHead,
      );
      expect(database.sqlite.prepare("SELECT branch_created FROM worktrees").get()).toEqual({
        branch_created: Number(!existing),
      });
    },
  );

  it.each(["local", "remote", "fallback"])(
    "新規ブランチの開始点は同名タグを避ける (%s)",
    async (mode) => {
      const localHead = git(["rev-parse", "refs/heads/main"]);
      const publisher = join(root, "publisher");
      git(["clone", "-q", "-b", "main", remote, publisher]);
      git(["commit", "--allow-empty", "-qm", "remote only"], publisher);
      git(["push", "origin", "main"], publisher);
      const remoteHead = git(["rev-parse", "HEAD"], publisher);
      const tagHead = git([
        "commit-tree",
        `${localHead}^{tree}`,
        "-p",
        localHead,
        "-m",
        "tag only",
      ]);
      git(["tag", mode === "remote" ? "origin/main" : "main", tagHead]);
      database.sqlite.prepare("UPDATE projects SET uses_github = ?").run(Number(mode !== "local"));
      if (mode === "fallback") rmSync(remote, { recursive: true, force: true });
      const created = await create("from-default");
      expect({
        head: git(["rev-parse", "HEAD"], created.path),
        notice: created.notice,
        branch: git(["branch", "--show-current"], created.path),
      }).toEqual({
        head: mode === "remote" ? remoteHead : localHead,
        notice:
          mode === "fallback"
            ? "GitHub から取得できなかったので、手元の既定ブランチから作りました"
            : null,
        branch: "from-default",
      });
    },
  );

  it.each([
    { tag: false, checkout: "branch", branch: "label" },
    { tag: true, checkout: "branch", branch: "label" },
    { tag: true, checkout: "detached", branch: "label" },
    { tag: true, checkout: "external", branch: "heads/label" },
  ])(
    "完全refで branch を識別する（tag=$tag / checkout=$checkout / branch=$branch）",
    async ({ tag, checkout, branch }) => {
      if (tag) git(["tag", branch]);
      let id: string;
      let path: string;
      if (checkout === "external") {
        path = join(root, "external-label");
        git(["worktree", "add", "-b", branch, path, "main"]);
        record("w", path, branch);
        id = "w";
      } else {
        const created = await create("label");
        expect(created).toEqual({ ...row("label"), notice: null });
        id = created.id!;
        path = created.path;
        if (checkout === "detached") git(["checkout", "-q", "--detach", "main"], path);
      }
      const listing = await request("/api/projects/p/worktrees");
      expect(listing.status).toBe(200);
      const currentBranch = checkout === "detached" ? null : branch;
      expect(
        worktreeListSchema
          .parse(await listing.json())
          .worktrees.find((entry) => entry.path === path),
      ).toEqual(
        row(checkout === "external" ? "external-label" : "label", {
          id,
          path,
          branch: currentBranch,
        }),
      );
      const response = await request(`/api/worktrees/${id}`, "DELETE");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        removedBranch: false,
        movedConversationIds: [],
      });
      expect(existsSync(path)).toBe(false);
      expect(git(["show-ref", "--verify", "--hash", `refs/heads/${branch}`])).toBe(
        git(["rev-parse", "refs/heads/main"]),
      );
      if (tag)
        expect(git(["show-ref", "--verify", "--hash", `refs/tags/${branch}`])).toBe(
          git(["rev-parse", "refs/heads/main"]),
        );
    },
  );

  it("本人でない接続は一覧を読む前に拒む", async () => {
    const app = createApp({
      build: "test",
      identity: {
        login: "dev@example.com",
        devIdentity: "dev@example.com",
        clock: { now: () => 0 },
        tailscale: createTailscaleLocalApi(),
      },
      worktrees: createWorktreeDependencies(() => database, { gh }),
    });
    const response = await app.request(
      "/api/projects/p/worktrees",
      undefined,
      incomingWith("192.0.2.1", 50000),
    );
    expect(response.status).toBe(401);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM worktrees").get()).toEqual({
      count: 0,
    });
  });
});
