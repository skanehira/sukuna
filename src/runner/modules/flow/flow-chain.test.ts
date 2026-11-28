import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { expect, it } from "vite-plus/test";
import { git } from "../../../server/modules/flow/design-test-support";
import { issueFixture } from "../../../server/modules/issue/test-support";
import { designSubmittedSchema } from "../../../shared/api/design";
import { issues, projects } from "../../../shared/db/schema";

const f = issueFixture(
  {
    rules: [
      {
        match: "^#42「予約の設計」を精査してください。",
        steps: [
          {
            tool: "mcp__sukuna__report_triage",
            input: { number: 42, result: "design", kind: "enhancement", summary: "設計へ進む" },
          },
          { end: "success" },
        ],
      },
      {
        match: "^#42「予約の設計」を設計してください。",
        steps: [
          {
            shell:
              "printf '予約を記録する\n' > design.md && git add design.md && git -c user.name='Test' -c user.email='test@example.test' -c commit.gpgsign=false commit -qm design",
          },
          {
            tool: "mcp__sukuna__report_design",
            input: { number: 42, policy: "予約を記録する", checks: [] },
          },
          { end: "success" },
        ],
      },
      {
        match: "^#43「予約の親」を精査してください。",
        steps: [
          {
            tool: "mcp__sukuna__report_triage",
            input: { number: 43, result: "design", kind: "enhancement", summary: "子がある親" },
          },
          { end: "success" },
        ],
      },
      {
        match: "^#44「予約の子」を精査してください。",
        steps: [
          {
            tool: "mcp__sukuna__report_triage",
            input: { number: 44, result: "design", kind: "enhancement", summary: "設計済みの子" },
          },
          { end: "success" },
        ],
      },
    ],
    fallback: [{ hold: true }],
  },
  {
    autoFlow: true,
    autoStages: ["triage", "design", "impl"],
    ghScript: {
      responses: [],
      fallback: { exit_code: 1, stdout: "", stderr: "このローカルリポジトリでは gh を使いません" },
    },
  },
);

function prepareRepository() {
  const project = join(realpathSync(f.home), "repo");
  mkdirSync(project);
  git(project, "init", "-q", "-b", "main");
  git(project, "commit", "--allow-empty", "-qm", "base");
  f.db
    .update(projects)
    .set({ path: project, usesGithub: false, designMergeMode: "direct" })
    .where(eq(projects.id, "p"))
    .run();
  return project;
}

async function confirm(id: string) {
  expect((await f.request(`/api/issues/${id}/confirm`, "POST")).status).toBe(200);
}

function state(id: string) {
  return f.db.select().from(issues).where(eq(issues.id, id)).get()?.state;
}

function stages(id: string) {
  return f.runner.runtime.store.list().filter(({ issueId }) => issueId === id);
}

function startedKinds(id: string) {
  return f
    .events(id)
    .filter(({ type }) => type === "ai_started")
    .map(({ payload }) => (payload as { kind: string }).kind);
}

it("依存先が完了した issue を確定し、精査から設計の承認を経て実装を始める", async () => {
  const project = prepareRepository();
  f.addIssue("dependency", 41, { state: "done", closedAt: 1_000_000 });
  f.addIssue("issue", 42, { title: "予約の設計", state: "draft" });
  f.depend("issue", "dependency");

  await confirm("issue");
  await expect.poll(() => state("issue")).toBe("design_review");
  await expect
    .poll(() => stages("issue").find(({ kind }) => kind === "design")?.runState)
    .toBe("idle");
  const submission = designSubmittedSchema.parse(
    f.events("issue").find(({ type }) => type === "design_submitted")?.payload,
  );
  const approval = await f.link.call("POST", "/flow/issues/issue/design/approve", {
    head_commit: submission.headCommit,
  });
  expect(approval._unsafeUnwrap().status).toBe(202);

  await expect.poll(() => startedKinds("issue")).toEqual(["triage", "design", "impl"]);
  await expect.poll(() => f.agent.sent.length).toBe(3);
  const expectedTimes = [1_000_000, 1_000_000, 1_000_000];
  const events = f.events("issue");
  expect({
    startedAt: events.filter(({ type }) => type === "ai_started").map(({ createdAt }) => createdAt),
    waitingSince: events
      .filter(
        ({ type, payload }) =>
          type === "state_changed" &&
          ["triage", "design", "ready"].includes((payload as { to: string }).to),
      )
      .map(({ createdAt }) => createdAt),
    firstInstructions: f.agent.sent.map(({ text }) => text.split("\n", 1)[0]),
    state: state("issue"),
    design: git(project, "show", "main:design.md"),
  }).toEqual({
    startedAt: expectedTimes,
    waitingSince: expectedTimes,
    firstInstructions: [
      "#42「予約の設計」を精査してください。",
      "#42「予約の設計」を設計してください。",
      "#42「予約の設計」を実装してください。",
    ],
    state: "implementing",
    design: "予約を記録する",
  });

  const worktree = join(project, ".claude/worktrees/issue-42");
  const impl = stages("issue").find(({ kind }) => kind === "impl");
  const lastInstruction = f.agent.sent.at(-1);
  expect({
    cwd: impl?.cwd,
    branch: git(worktree, "branch", "--show-current"),
    agentCwd: f.agent.opened.at(-1)?.cwd,
    agentSessionId: f.agent.opened.at(-1)?.sessionId,
    sentSessionId: lastInstruction?.sessionId,
    recorded: f.runner.runtime.store
      .events(impl!.id)
      .filter((event) => event.type === "user_message")
      .map(({ payload }) => ({ origin: payload.origin, text: payload.text })),
  }).toEqual({
    cwd: worktree,
    branch: "sukuna/issue-42",
    agentCwd: worktree,
    agentSessionId: impl?.sessionId,
    sentSessionId: impl?.sessionId,
    recorded: [{ origin: "flow", text: lastInstruction?.text }],
  });
});

it("子を持つ issue は精査の後で親になり、子の実装中にも設計と実装を始めない", async () => {
  prepareRepository();
  f.addIssue("parent", 43, { title: "予約の親", state: "draft" });
  f.addIssue("child", 44, {
    title: "予約の子",
    state: "draft",
    designed: true,
    parentId: "parent",
  });

  await confirm("parent");
  await expect.poll(() => state("parent")).toBe("ready");
  await confirm("child");
  await expect.poll(() => startedKinds("child")).toEqual(["triage", "impl"]);
  await expect.poll(() => f.agent.sent.length).toBe(3);

  expect({
    parent: {
      state: state("parent"),
      stages: stages("parent").map(({ kind }) => kind),
      started: startedKinds("parent"),
    },
    child: {
      state: state("child"),
      stages: stages("child").map(({ kind }) => kind),
      started: startedKinds("child"),
    },
  }).toEqual({
    parent: { state: "ready", stages: ["triage"], started: ["triage"] },
    child: { state: "implementing", stages: ["triage", "impl"], started: ["triage", "impl"] },
  });
});
