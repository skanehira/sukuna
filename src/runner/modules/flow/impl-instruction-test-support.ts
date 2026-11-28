import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { expect } from "vite-plus/test";
import { conversations, issues, projects, stockItems } from "../../../shared/db/schema";
import { git } from "../../../server/modules/flow/design-test-support";
import { issueFixture } from "../../../server/modules/issue/test-support";
import { createApp } from "../../../server/app";
import { createConversationDependencies } from "../../../server/modules/conversation/adapter/dependencies";
import { incomingWith, createTailscaleFake } from "../../../server/modules/identity/test-support";
import { createPrDependencies } from "../../../server/modules/flow/adapter/pr-dependencies";
import { createStockDependencies } from "../../../server/modules/stock/adapter/dependencies";
import { createWorkspaceDependencies } from "../../../server/modules/workspace/adapter/dependencies";
import { randomUUID } from "node:crypto";
import { ScriptedAgent } from "../conversation/adapter/scripted-agent";
import { ScriptedGh } from "../../../shared/gh/scripted-gh";

export const previousPr = "https://github.com/fixture/project/pull/41";
export const newPr = "https://github.com/fixture/project/pull/42";
const f = issueFixture(
  { rules: [], fallback: [{ hold: true }] },
  {
    autoFlow: true,
    terminalCleanup: () => () => Promise.resolve(),
    ghScript: {
      responses: [
        {
          match: "^repo view ",
          stdout: JSON.stringify({
            nameWithOwner: "fixture/project",
            url: "https://github.com/fixture/project",
          }),
          exit_code: 0,
        },
      ],
      fallback: { exit_code: 1, stdout: "", stderr: "想定していない試験コマンド" },
    },
  },
);

export function prepareGit(usesGithub = false) {
  const path = join(f.home, "repo");
  mkdirSync(path);
  const cwd = realpathSync(path);
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "commit", "--allow-empty", "-qm", "base");
  if (usesGithub) {
    const remote = join(realpathSync(f.home), "origin.git");
    git(cwd, "init", "--bare", "-q", "-b", "main", remote);
    git(cwd, "remote", "add", "origin", remote);
    git(cwd, "push", "-qu", "origin", "main");
  }
  f.db.update(projects).set({ path: cwd, usesGithub }).where(eq(projects.id, "p")).run();
  return cwd;
}

export function issue() {
  return f.db.select().from(issues).where(eq(issues.id, "i")).get()!;
}

export function implementation() {
  return f.runner.runtime.store.list().find((row) => row.issueId === "i" && row.kind === "impl")!;
}

function app() {
  return createApp({
    build: "test",
    identity: {
      login: "review@example.com",
      devIdentity: "review",
      tailscale: createTailscaleFake().api,
      clock: { now: () => 1_000_000 },
    },
    conversations: createConversationDependencies({
      sqlite: f.opened.sqlite,
      home: f.home,
      runner: f.link,
      id: () => "conversation-route",
      now: () => 1_000_000,
      changed: () => {},
      reopened: () => {},
    }),
    pr: createPrDependencies({
      database: () => f.db,
      gh: { run: (args, options) => f.runner.gh.run(args, options) },
      runner: () => f.link,
      now: () => 1_000_000,
      changed: () => {},
    }),
    stock: createStockDependencies({
      database: () => f.opened,
      workspace: createWorkspaceDependencies(() => f.db),
      runner: () => f.link,
      changed: () => {},
      id: randomUUID,
      now: () => 1_000_000,
    }),
  });
}

export function request(path: string, method = "GET", body?: unknown) {
  return app().request(
    path,
    {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    },
    incomingWith("127.0.0.1", 5220),
  );
}

export async function uploadImage(id: string) {
  const bytes = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const response = await app().request(
    `/api/conversations/${id}/images`,
    { method: "POST", headers: { "content-type": "image/png" }, body: bytes },
    incomingWith("127.0.0.1", 5220),
  );
  expect(response.status).toBe(201);
  const { image } = (await response.json()) as { image: { id: string } };
  return image.id;
}

export function send(text: string, clientMessageId = "impl-test") {
  return request(`/api/conversations/${implementation().id}/messages`, "POST", {
    text,
    images: [],
    mode: "send",
    clientMessageId,
  });
}

export function messages() {
  return f.runner.runtime.store
    .events(implementation().id)
    .flatMap((event) => (event.type === "user_message" ? [event.payload] : []));
}

export const tool = (name: string, input: Record<string, unknown>) => ({
  tool: `mcp__sukuna__${name}`,
  input,
});

export function github(head: string, expectedBranch: string, mergeOnApproval = false) {
  let state: "OPEN" | "MERGED" = "OPEN";
  let branch = expectedBranch;
  const runner = f.runner.gh;
  const fallback = runner.run.bind(runner);
  runner.run = (args, options) => {
    const url = args[2]!;
    if (args[0] !== "pr") return fallback(args, options);
    const approved =
      mergeOnApproval &&
      url === previousPr &&
      args[4]?.includes("baseRefOid") &&
      f.events("i").some(({ type }) => type === "merge_allowed");
    const data =
      args[1] === "diff"
        ? ""
        : JSON.stringify({
            number: Number(url.split("/").at(-1)),
            title: "実装",
            url,
            state: approved ? "MERGED" : state,
            isDraft: false,
            headRefName: branch,
            headRefOid: head,
            baseRefName: "main",
            baseRefOid: head,
            mergeable: "MERGEABLE",
            mergedAt: null,
            mergeCommit: { oid: head },
            body: "",
            statusCheckRollup: [],
            files: [],
            isCrossRepository: false,
            headRepository: { nameWithOwner: "fixture/project" },
          });
    return new ScriptedGh({
      responses: [],
      fallback: { stdout: data, stderr: "", exit_code: 0 },
    }).run(args, options);
  };
  return (next: "OPEN" | "MERGED", headRef = expectedBranch) => {
    state = next;
    branch = headRef;
  };
}

export async function startImplementation(confirmBeforeMerge = false, parentId?: string) {
  f.addIssue("i", 42, { state: "ready", confirmBeforeMerge, parentId });
  const response = await f.link.forward("POST", "/flow/notify", { issue_id: "i" });
  expect(response.status).toBe(200);
  await expect.poll(() => f.events("i").some(({ type }) => type === "ai_started")).toBe(true);
}

export async function waitIdle(reason?: string) {
  await expect
    .poll(
      () => ({
        state: issue().state,
        reason: issue().stopReason,
        run: implementation()?.runState,
      }),
      { timeout: 5000 },
    )
    .toEqual({ state: reason ? "stopped" : "done", reason: reason ?? null, run: "idle" });
}

export const ready = (head: string, url = previousPr) =>
  tool("report_ready_for_merge", { number: 42, pr_url: url, head_sha: head, summary: "検証済み" });

export const merged = (head: string, url?: string) =>
  tool("report_implementation_done", {
    number: 42,
    ...(url ? { pr_url: url } : {}),
    merge_commit: head,
    summary: "完了",
  });

export const events = () => f.events("i");

export function useAgent(script: ConstructorParameters<typeof ScriptedAgent>[0]) {
  f.runner.runtime.options.agent = new ScriptedAgent(script);
}

export function failNextAgentOpen() {
  const agent = f.runner.runtime.options.agent;
  const open = agent.open.bind(agent);
  agent.open = () => {
    agent.open = open;
    throw new Error("実行を一時的に開けませんでした");
  };
}

export function addStock(
  conversationId: string,
  kind: "question" | "instruction",
  text: string,
  commit?: string,
  stockId: string = kind,
) {
  f.db
    .insert(stockItems)
    .values({
      id: stockId,
      conversationId,
      kind,
      text,
      quote: JSON.stringify(
        commit
          ? {
              kind: "pr_diff",
              mode: "line",
              text: "const color = 'red';",
              commit,
              path: "calendar.ts",
              start: { line: 7, col: 0, side: "new" },
              end: { line: 7, col: 20, side: "new" },
            }
          : { kind: "terminal", mode: "line", text: "休日の色" },
      ),
      state: "stocked",
    })
    .run();
}

export function sendStock(conversationId: string, kinds: "questions" | "instructions") {
  return request(`/api/conversations/${conversationId}/stock/send`, "POST", { kinds });
}

export function threadOf(conversationId: string) {
  return f.runner.runtime.store
    .list()
    .find(({ parentConversationId }) => parentConversationId === conversationId);
}

export const draft = (id: string) => f.runner.runtime.store.draft(id);
export const addParent = () => f.addIssue("parent", 41, { state: "ready" });
export const parent = () => f.db.select().from(issues).where(eq(issues.id, "parent")).get()!;
export const parentEvents = () => f.events("parent");
export const sameIssueConversations = () =>
  f.db.select().from(conversations).where(eq(conversations.issueId, "i")).all();
export { git };
