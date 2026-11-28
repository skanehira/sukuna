import type { GhRunner } from "../../../shared/gh/gh-runner";
import { designSubmittedSchema } from "../../../shared/api/design";
import { ScriptedGh } from "../../../shared/gh/scripted-gh";
import { createGitCli } from "../../../runner/modules/workspace/adapter/git-cli";
import { createIssueDependencies } from "../issue/adapter/dependencies";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { startRunnerApp } from "../../../runner/app";
import { ScriptedAgent } from "../../../runner/modules/conversation/adapter/scripted-agent";
import { createApp } from "../../app";
import { RunnerLink } from "../../runner-link";
import { createTailscaleFake, incomingWith } from "../identity/test-support";
import { createStockDependencies } from "../stock/adapter/dependencies";
import { createWorkspaceDependencies } from "../workspace/adapter/dependencies";
import { createDesignDependencies } from "./adapter/design-dependencies";
import { createConversationDependencies } from "../conversation/adapter/dependencies";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
} from "../../../shared/db/test-helpers";
import { conversations, issueEvents, issues, projects, worktrees } from "../../../shared/db/schema";
import { readEnvironment } from "../../../shared/env";
import type { GhScript } from "../../../shared/gh-script";
import { RUNNER_IPC_TIMEOUT_MS, type RunnerNotice } from "../../../shared/ipc";
import { systemClock } from "../../../runner/modules/conversation/adapter/system-clock";

export const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Sukuna test",
      "-c",
      "user.email=design@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

export function supplyDesignPrFields(
  gh: GhRunner,
  nameWithOwner: string,
  submitted: () => unknown,
) {
  const run = gh.run.bind(gh);
  const justCreated = new Set<string>();
  gh.run = async (args, options) => {
    const result = await run(args, options);
    if (result.exitCode === 0 && args[0] === "pr" && args[1] === "create")
      justCreated.add(result.stdout.trim());
    if (
      result.exitCode !== 0 ||
      args[0] !== "pr" ||
      args[1] !== "view" ||
      !args.at(-1)?.includes("headRefOid")
    )
      return result;
    const design = designSubmittedSchema.parse(submitted());
    const response = JSON.parse(result.stdout) as Record<string, unknown>;
    const firstView = justCreated.delete(args[2] ?? "");
    const state =
      firstView && response.state === "MERGED" ? { state: "OPEN", mergeCommit: null } : {};

    return {
      ...result,
      stdout: JSON.stringify({
        url: args[2],
        baseRefName: "main",
        headRefName: design.branch,
        headRefOid: design.headCommit,
        isCrossRepository: false,
        headRepository: { nameWithOwner },
        ...response,
        ...state,
      }),
    };
  };
}

export function designFixture() {
  let home: string;
  let repository: string;
  let remote: string;
  let serverDb: ReturnType<typeof openMigratedDatabase>;
  let runnerDb: ReturnType<typeof openMigratedDatabase>;
  let runner: Awaited<ReturnType<typeof startRunnerApp>>;
  let link: RunnerLink;
  let app: ReturnType<typeof createApp>;
  const changes: RunnerNotice[] = [];
  const realGit = createGitCli();
  let afterGit: ((args: string[]) => Promise<void>) | undefined;
  let beforeGit: ((args: string[]) => Promise<void>) | undefined;
  const errorLogs: string[] = [];
  let time: number;
  const linkTimeouts = new Set<() => void>();

  beforeEach(async () => {
    home = realpathSync(createTempHome());
    repository = join(home, "project");
    remote = join(home, "remote.git");
    changes.length = 0;
    beforeGit = undefined;
    afterGit = undefined;
    time = Date.now();
    linkTimeouts.clear();
    errorLogs.length = 0;
    mkdirSync(repository);
    git(repository, "init", "-q", "-b", "main");
    writeFileSync(join(repository, "design.md"), "first\nold\nlast\n");
    git(repository, "add", ".");
    git(repository, "commit", "-qm", "base");
    git(home, "init", "--bare", "-q", "-b", "main", remote);
    git(repository, "remote", "add", "origin", remote);
    git(repository, "push", "-q", "-u", "origin", "main");
    const ghScript: GhScript = {
      responses: [
        {
          match: "^repo view ",
          stdout: JSON.stringify({
            nameWithOwner: "example/design",
            url: "https://github.com/example/design",
          }),
          exit_code: 0,
        },
        {
          match: "^pr create .*未merge",
          stdout: "https://github.com/example/design/pull/2\n",
          exit_code: 0,
        },
        {
          match: "^pr create ",
          stdout: "https://github.com/example/design/pull/1\n",
          exit_code: 0,
        },
        {
          match: "^pr view .*/1 --json ",
          stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "a".repeat(40) } }),
          exit_code: 0,
        },
        {
          match: "^pr view .*/2 --json ",
          stdout: JSON.stringify({ state: "OPEN", mergeCommit: null }),
          exit_code: 0,
        },
      ],
      fallback: { stdout: "", stderr: "unexpected gh command", exit_code: 1 },
    };
    const scriptPath = join(home, "gh.json");
    writeFileSync(scriptPath, JSON.stringify(ghScript));
    serverDb = openMigratedDatabase(home);
    serverDb.db
      .insert(projects)
      .values({
        id: "project",
        path: repository,
        defaultBranch: "main",
        usesGithub: false,
        name: "設計",
        autoStages: ["triage", "design"],
      })
      .run();
    serverDb.db
      .insert(issues)
      .values({
        id: "issue",
        projectId: "project",
        number: 42,
        title: "在庫の設計",
        state: "design",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    serverDb.db
      .insert(conversations)
      .values({
        id: "design",
        projectId: "project",
        issueId: "issue",
        sessionId: "design-session",
        kind: "design",
        cwd: repository,
      })
      .run();
    runnerDb = openMigratedDatabase(home);
    runner = await startRunnerApp({
      database: runnerDb,
      environment: readEnvironment(
        "runner",
        { SUKUNA_HOME: home, SUKUNA_GH: scriptPath },
        home,
        () => true,
      )._unsafeUnwrap(),
      designGit: {
        run: async (args, options) => {
          await beforeGit?.(args);
          const result = await realGit.run(args, options);
          await afterGit?.(args);
          return result;
        },
      },
      clock: { ...systemClock, now: () => time },
      agent: new ScriptedAgent({ rules: [], fallback: [{ end: "success" }] }),
      log: (entry) => {
        if (entry.level === "error") errorLogs.push(entry.message);
      },
    });
    supplyDesignPrFields(
      runner.gh,
      "example/design",
      () =>
        serverDb.db
          .select()
          .from(issueEvents)
          .where(eq(issueEvents.issueId, "issue"))
          .orderBy(issueEvents.seq)
          .all()
          .findLast(({ type }) => type === "design_submitted")?.payload,
    );
    await new Promise<void>((resolve) => {
      link = new RunnerLink({
        socket: join(home, "runner.sock"),
        log: () => {},
        now: () => time,
        clock: {
          setTimeout(callback, ms) {
            if (ms !== RUNNER_IPC_TIMEOUT_MS) return systemClock.setTimeout(callback, ms);
            linkTimeouts.add(callback);
            return () => {
              linkTimeouts.delete(callback);
            };
          },
        },
        notice: (notice) => changes.push(notice),
        connection: (connected) => {
          if (connected) resolve();
        },
      });
      link.start();
    });
    app = createApp({
      conversations: createConversationDependencies({
        sqlite: serverDb.sqlite,
        home,
        runner: link,
        id: randomUUID,
        now: () => time,
        changed: () => {},
        reopened: () => {},
      }),
      issues: createIssueDependencies(
        () => serverDb.db,
        () => link,
        () => {},
      ),
      stock: createStockDependencies({
        database: () => serverDb,
        workspace: createWorkspaceDependencies(() => serverDb.db),
        runner: () => link,
        changed: () => {},
        id: randomUUID,
        now: () => time,
      }),
      build: "test",
      identity: {
        login: "dev@example.test",
        devIdentity: "1",
        tailscale: createTailscaleFake().api,
        clock: { now: Date.now },
      },
      design: createDesignDependencies(
        () => serverDb.db,
        () => link,
        () => {},
      ),
    });
  });

  afterEach(async () => {
    link?.stop();
    await runner?.shutdown();
    runnerDb?.close();
    serverDb?.close();
    if (home) removeTempHome(home);
  });

  const options = (patch: Partial<typeof projects.$inferInsert>) =>
    serverDb.db.update(projects).set(patch).where(eq(projects.id, "project")).run();
  const request = (
    url = "/api/issues/issue/design",
    method = "GET",
    body?: unknown,
    ip = "127.0.0.1",
  ) =>
    app.request(
      url,
      {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      },
      incomingWith(ip, 5000),
    );
  const state = () => serverDb.db.select().from(issues).where(eq(issues.id, "issue")).get()!.state;
  const events = () =>
    serverDb.db
      .select()
      .from(issueEvents)
      .where(eq(issueEvents.issueId, "issue"))
      .orderBy(issueEvents.seq)
      .all();
  const worktree = () => runner.design.workspace({ issueId: "issue", conversationId: "design" });
  const submit = () =>
    runner.design.submit("issue", "design", {
      policy: "在庫を先に確保する",
      checks: ["期限は30分?"],
    });
  return {
    state,
    events,
    options,
    worktree,
    submit,
    request,
    changes,
    advanceToDeadline() {
      time += RUNNER_IPC_TIMEOUT_MS;
    },
    disconnectAtDeadline() {
      time += RUNNER_IPC_TIMEOUT_MS;
      for (const timeout of linkTimeouts) timeout();
    },
    expireAfterInsert(table: "issue_events" | "conversation_events" | "settings", event: string) {
      runnerDb.sqlite.function("expire_after_event", () => {
        time += RUNNER_IPC_TIMEOUT_MS;
        return 0;
      });
      const condition =
        table === "settings"
          ? "NEW.key GLOB 'runner-accepted-input:*'"
          : `NEW.type = '${event.replaceAll("'", "''")}'`;
      runnerDb.sqlite.exec(`
        CREATE TEMP TRIGGER expire_after_event AFTER INSERT ON ${table}
        WHEN ${condition}
        BEGIN SELECT expire_after_event(); END
      `);
    },
    clearExpiryTrigger() {
      runnerDb.sqlite.exec("DROP TRIGGER IF EXISTS temp.expire_after_event");
    },
    async backupDatabase(path: string) {
      await serverDb.sqlite.backup(path);
    },
    afterGit(fn: typeof afterGit) {
      afterGit = fn;
    },
    interceptGit(fn: typeof beforeGit) {
      beforeGit = fn;
    },
    ghCalls() {
      expect(runner.gh).toBeInstanceOf(ScriptedGh);
      return (runner.gh as ScriptedGh).calls;
    },
    get home() {
      return home;
    },
    get repository() {
      return repository;
    },
    get remote() {
      return remote;
    },
    get runner() {
      return runner;
    },
    get link() {
      return link;
    },
    get db() {
      return serverDb.db;
    },
    get errorLogs() {
      return errorLogs;
    },
    worktrees: () =>
      serverDb.db.select().from(worktrees).where(eq(worktrees.issueId, "issue")).all(),
    async prepare(change = true) {
      const tree = (await worktree())._unsafeUnwrap();
      const base = git(tree.path, "rev-parse", "HEAD");
      if (change) {
        writeFileSync(join(tree.path, "design.md"), "first\nnew\nlast\n");
        git(tree.path, "add", ".");
        git(tree.path, "commit", "-qm", "design");
      }
      const head = git(tree.path, "rev-parse", "HEAD");
      expect((await submit()).isOk()).toBe(true);
      return { ...tree, base, head };
    },
  };
}
