import type { GhRunner } from "../../../shared/gh/gh-runner";
import { afterEach } from "vite-plus/test";
import { eq } from "drizzle-orm";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
} from "../../../shared/db/test-helpers";
import {
  conversations,
  issues,
  projects,
  stockItems,
  issueEvents,
  conversationEvents,
  worktrees,
} from "../../../shared/db/schema";
import { ScriptedAgent } from "../../../runner/modules/conversation/adapter/scripted-agent";
import { SqliteConversationStore } from "../../../runner/modules/conversation/adapter/sqlite-conversation-store";
import { createImageFiles } from "../../../runner/modules/conversation/adapter/image-files";
import { ConversationRuntime } from "../../../runner/modules/conversation/usecase/runtime";
import { systemClock } from "../../../runner/modules/conversation/adapter/system-clock";
import { createIpcRoutes } from "../../../runner/modules/conversation/adapter/ipc-routes";
import { createRunnerAllowMerge } from "../../../runner/modules/flow/adapter/allow-merge-dependencies";
import { createPrDependencies } from "./adapter/pr-dependencies";
import { createApp } from "../../app";
import { incomingWith, createTailscaleFake } from "../identity/test-support";
import type { CommandOptions, CommandResult } from "../../../shared/command";
export const headSha = "a".repeat(40);
export const prUrl = "https://github.com/example/review-fixture/pull/128";
export const rawPr = {
  number: 128,
  title: "テスト",
  url: prUrl,
  state: "OPEN",
  isDraft: false,
  headRefName: "impl",
  headRefOid: headSha,
  baseRefName: "main",
  mergeable: "MERGEABLE",
  mergedAt: null,
  body: "## 動作確認\n![画面](https://example.com/screen.png)",
  statusCheckRollup: [],
  files: [{ path: "a.ts", additions: 1, deletions: 1 }],
};
export const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
export const reviewUrl = prUrl + "#pullrequestreview-1";
export const reviewEndpoint = "repos/example/review-fixture/pulls/128/reviews";
export const viewArgs = [
  "pr",
  "view",
  prUrl,
  "--json",
  "number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeable,mergedAt,body,statusCheckRollup,files",
];
export const quote = (side: "old" | "new" = "new") => ({
  kind: "pr_diff",
  mode: "line",
  text: side === "new" ? "new" : "old",
  path: "a.ts",
  commit: headSha,
  start: { side, line: 1, col: 0 },
  end: { side, line: 1, col: 3 },
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
export function prFixture(options: { interruptBusy?: () => Promise<void>; gh?: GhRunner } = {}) {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  const agent = new ScriptedAgent({
    rules: [{ match: "^busy$", steps: [{ hold: true }] }],
    fallback: [{ end: "success" }],
  });
  const runtime = new ConversationRuntime({
    store: new SqliteConversationStore(database.sqlite),
    agent: {
      open: (params) => {
        const session = agent.open(params);
        return params.context.conversationId !== "busy" || options.interruptBusy === undefined
          ? session
          : {
              ...session,
              interrupt: async () => {
                await options.interruptBusy!();
                await session.interrupt();
              },
            };
      },
      fork: (sessionId, opts) => agent.fork(sessionId, opts),
      complete: (params) => agent.complete(params),
    },
    images: createImageFiles(home),
    clock: systemClock,
    id: () => "id",
    uuid: () => "session",
    log: () => {},
    notice: () => {},
  });
  const calls: { args: string[]; cwd: string; stdin?: string }[] = [];
  let pr = { ...rawPr };
  let failure = false;
  let rejectLine = false;
  let rejectBody = false;
  let runnerDown = false;
  let reverseComments = false;
  let commandFailure:
    | { command: string; stdout: string; stderr: string; exitCode: number }
    | undefined;
  let gate: Promise<void> | undefined;
  const gh = {
    run: async (args: string[], opts: CommandOptions): Promise<CommandResult> => {
      calls.push({ args: [...args], ...opts });
      if (commandFailure && args.slice(0, 2).join(" ") === commandFailure.command)
        return commandFailure;
      if (gate && args[0] === "api" && args.includes("POST")) await gate;
      if (failure) return { stdout: "", stderr: "GitHub is offline", exitCode: 1 };
      if (args[0] === "pr")
        return { stdout: args[1] === "view" ? JSON.stringify(pr) : patch, stderr: "", exitCode: 0 };
      if (args.includes("POST")) {
        const line = JSON.parse(opts.stdin ?? "{}").comments?.length;
        if ((line && rejectLine) || rejectBody)
          return {
            stdout: "",
            stderr: rejectBody
              ? "service unavailable (HTTP 503)"
              : "Validation Failed: PullRequestReviewComment line is invalid (HTTP 422)",
            exitCode: 1,
          };
        return { stdout: JSON.stringify({ id: 1, html_url: reviewUrl }), stderr: "", exitCode: 0 };
      }
      return {
        stdout: JSON.stringify(
          [
            {
              html_url: prUrl + "#discussion_r1",
              path: "a.ts",
              line: 1,
              side: "RIGHT",
              body: "right",
            },
            {
              html_url: prUrl + "#discussion_r2",
              path: "a.ts",
              line: 1,
              side: "LEFT",
              body: "left",
            },
          ]
            .slice()
            .sort((a, b) =>
              reverseComments
                ? b.html_url.localeCompare(a.html_url)
                : a.html_url.localeCompare(b.html_url),
            ),
        ),
        stderr: "",
        exitCode: 0,
      };
    },
  };
  const allowMerge = createRunnerAllowMerge(database.db, runtime, { publish: () => {} });
  const ipc = createIpcRoutes(runtime, () => {}, undefined, { allowMerge });
  const forwards: { method: string; path: string; input: unknown }[] = [];
  const deps = createPrDependencies({
    database: () => database.db,
    gh: options.gh ?? gh,
    now: () => 1000,
    runner: () => ({
      forward: async (method: string, path: string, input?: unknown) => {
        forwards.push({ method, path, input });
        if (runnerDown)
          return Response.json(
            {
              error: {
                code: "runner_unavailable",
                message:
                  "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
              },
            },
            { status: 503 },
          );
        return ipc.request(path, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
      },
    }),
    changed: () => {},
  });
  const app = createApp({
    build: "test",
    pr: deps,
    identity: {
      login: "dev",
      devIdentity: "1",
      tailscale: createTailscaleFake().api,
      clock: { now: () => 0 },
    },
  });
  database.db
    .insert(projects)
    .values({ id: "p", name: "fixture", path: home, usesGithub: true, defaultBranch: "main" })
    .run();
  database.db
    .insert(issues)
    .values({
      id: "i",
      projectId: "p",
      number: 1,
      title: "fixture",
      state: "stopped",
      stopReason: "merge_confirm",
      prUrl,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  database.db
    .insert(conversations)
    .values({ id: "c", projectId: "p", kind: "impl", issueId: "i", cwd: home })
    .run();
  cleanups.push(async () => {
    await runtime.shutdown();
    database.close();
    removeTempHome(home);
  });
  return {
    home,
    database,
    agent,
    runtime,
    calls,
    forwards,
    deps,
    app,
    allowMerge,
    ipc,
    stockRows: () =>
      database.db
        .select({ id: stockItems.id, state: stockItems.state, url: stockItems.githubCommentUrl })
        .from(stockItems)
        .orderBy(stockItems.id)
        .all(),
    publishedUrls: () =>
      database.db.select({ url: stockItems.githubCommentUrl }).from(stockItems).all(),
    eventRows: () => database.db.select().from(issueEvents).orderBy(issueEvents.seq).all(),
    issueRows: () =>
      database.db.select({ state: issues.state, reason: issues.stopReason }).from(issues).all(),
    userMessages: () =>
      database.db
        .select({ type: conversationEvents.type, payload: conversationEvents.payload })
        .from(conversationEvents)
        .where(eq(conversationEvents.type, "user_message"))
        .all(),
    addEvent: (event: typeof issueEvents.$inferInsert) =>
      database.db.insert(issueEvents).values(event).run(),
    addWorktree: () =>
      database.db
        .insert(worktrees)
        .values({
          id: "w",
          projectId: "p",
          path: home,
          branch: "impl",
          origin: "flow",
          issueId: "i",
        })
        .run(),
    addConversation: (id: string) =>
      database.db
        .insert(conversations)
        .values({ id, projectId: "p", kind: "chat", cwd: home })
        .run(),
    removeConversation: () =>
      database.db.delete(conversations).where(eq(conversations.id, "c")).run(),
    reverseComments: () => {
      reverseComments = true;
    },
    commandFailure: (command: string, result: CommandResult) => {
      commandFailure = { command, ...result };
    },
    setPr: (fields: Partial<typeof rawPr>) => {
      pr = { ...pr, ...fields };
    },
    fail: (v = true) => {
      failure = v;
    },
    rejectLine: () => {
      rejectLine = true;
    },
    rejectBody: () => {
      rejectBody = true;
    },
    runnerDown: () => {
      runnerDown = true;
    },
    gate: (p: Promise<void>) => {
      gate = p;
    },
    request: (path = "", body?: unknown) =>
      app.request(
        `/api/issues/i/pr${path}`,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
        incomingWith("127.0.0.1", 1000),
      ),
    stock: (id: string, fields: Partial<typeof stockItems.$inferInsert> = {}) =>
      database.db
        .insert(stockItems)
        .values({
          id,
          conversationId: "c",
          kind: "instruction",
          text: id,
          quote: JSON.stringify(quote()),
          state: "stocked",
          ...fields,
        })
        .run(),
    issue: (fields: Partial<typeof issues.$inferInsert>) =>
      database.db.update(issues).set(fields).where(eq(issues.id, "i")).run(),
    local: () =>
      database.db.update(projects).set({ usesGithub: false }).where(eq(projects.id, "p")).run(),
  };
}
