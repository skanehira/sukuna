import { createWorktreeActivity } from "../../../shared/workspace/sqlite-worktree-activity";
import {
  physicalDirectory,
  physicalFile,
  worktreeGitDirectory,
  worktreeRegistration,
} from "../../../shared/workspace/git-registration";
import { restartInstruction } from "./domain/instructions";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { expect, it } from "vite-plus/test";
import { issueFixture } from "../../../server/modules/issue/test-support";
import { ScriptedAgent } from "../conversation/adapter/scripted-agent";
import { ScriptedGh } from "../../../shared/gh/scripted-gh";
import type { TerminalCleanupRequest } from "../../../shared/ipc";
import { beforeEach } from "vite-plus/test";
import { ulid } from "ulid";
import { git } from "../../../server/modules/flow/design-test-support";
import {
  issueEvents,
  conversations,
  issues,
  notifications,
  projects,
  settings,
  worktrees,
} from "../../../shared/db/schema";

const pr = "https://github.com/fixture/project/pull/42";
const commit = "b".repeat(40);
let closeTerminal = (_request: TerminalCleanupRequest) => Promise.resolve();
const f = issueFixture(
  { rules: [], fallback: [{ hold: true }] },
  {
    autoFlow: true,
    terminalCleanup: (request) => () => closeTerminal(request),
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

beforeEach(() => {
  closeTerminal = () => Promise.resolve();
});

function prepareGit(usesGithub = false) {
  const path = join(f.home, "repo");
  mkdirSync(path);
  git(path, "init", "-q", "-b", "main");
  git(path, "commit", "--allow-empty", "-qm", "base");
  const cwd = realpathSync(path);
  if (usesGithub) {
    const remote = join(realpathSync(f.home), "remote.git");
    git(f.home, "init", "--bare", "-q", "-b", "main", remote);
    git(cwd, "remote", "add", "origin", remote);
    git(cwd, "push", "-qu", "origin", "main");
  }
  f.db.update(projects).set({ path: cwd, usesGithub }).where(eq(projects.id, "p")).run();
  return cwd;
}

function state(id: string) {
  return f.db.select().from(issues).where(eq(issues.id, id)).get()?.state;
}

async function notify(issueId: string) {
  const response = await f.link.forward("POST", "/flow/notify", { issue_id: issueId });
  expect(response.status).toBe(200);
}

it("実装待ちの issue を worktree で始め、続けて評価しても二重に始めない", async () => {
  const path = prepareGit();
  f.addIssue("ready", 42, { state: "ready" });
  await notify("ready");
  await notify("ready");
  await expect
    .poll(() => f.events("ready").filter((row) => row.type === "ai_started").length, {
      timeout: 350,
    })
    .toBe(1);
  const conversation = f.runner.runtime.store.list().find((row) => row.issueId === "ready");
  expect(state("ready")).toBe("implementing");
  expect(conversation).toMatchObject({
    kind: "impl",
    cwd: join(path, ".claude/worktrees/issue-42"),
  });
  expect(git(conversation!.cwd, "branch", "--show-current")).toBe("sukuna/issue-42");
  expect(f.events("ready").find((row) => row.type === "stage_changed")?.payload).toEqual({
    stage: "implement",
  });
});

function conversation(id = "ready") {
  return f.runner.runtime.store.list().find((row) => row.issueId === id && row.kind === "impl");
}

const tool = (name: string, input: Record<string, unknown>) => ({
  tool: `mcp__sukuna__${name}`,
  input,
});
const send = (id: string, text: string) =>
  f.link.forward("POST", `/conversations/${id}/messages`, {
    text,
    origin: "developer",
    images: [],
    interrupt: false,
    client_id: `impl-test-${text}`,
  });

async function report(id: string, name: string, input: Record<string, unknown>) {
  const c = conversation(id)!;
  const definition = f.runner.runtime.tools.all("impl").find((entry) => entry.name === name)!;
  return definition.handler(input, { conversationId: c.id, projectId: c.projectId, issueId: id });
}

async function ready(id = "ready", number = 42, confirmBeforeMerge = false) {
  f.addIssue(id, number, { state: "ready", confirmBeforeMerge });
  await notify(id);
  await expect
    .poll(() => f.events(id).some(({ type }) => type === "ai_started"), { timeout: 3000 })
    .toBe(true);
}

function scriptedPr(head: string, initial: "OPEN" | "MERGED" = "OPEN", onView?: () => void) {
  let viewState = initial;
  let fields = { base: "main", branch: "sukuna/issue-42", head, baseTip: head };
  const request = (next: "OPEN" | "MERGED", changes: Partial<typeof fields> = {}) => {
    viewState = next;
    fields = { ...fields, ...changes };
  };
  const runner = f.runner.gh;
  const fallback = runner.run.bind(runner);
  runner.run = (args, options) => {
    if (args[0] !== "pr" || args[1] !== "view") return fallback(args, options);
    onView?.();
    return new ScriptedGh({
      responses: [],
      fallback: {
        exit_code: 0,
        stderr: "",
        stdout: JSON.stringify({
          state: viewState,
          url: args[2],
          baseRefName: fields.base,
          baseRefOid: fields.baseTip,
          headRefName: fields.branch,
          headRefOid: fields.head,
          isCrossRepository: false,
          headRepository: { nameWithOwner: "fixture/project" },
          mergeCommit: viewState === "MERGED" ? { oid: commit } : null,
        }),
      },
    }).run(args, options);
  };
  return request;
}

const readyReport = (head: string, url: string | null = pr) => ({
  number: 42,
  head_sha: head,
  ...(url ? { pr_url: url } : {}),
  summary: "検証済み",
});
const finishReport = (sha: string, url: string | null = pr) => ({
  number: 42,
  merge_commit: sha,
  ...(url ? { pr_url: url } : {}),
  summary: "完了",
});

it("実際の報告と偽 PR を確認し、段階を記録して worktree を片付ける", async () => {
  const path = prepareGit(true);
  const head = git(path, "rev-parse", "HEAD");
  const view = scriptedPr(head);
  f.runner.runtime.options.agent = new ScriptedAgent({
    rules: [
      {
        match: "^#42",
        steps: [
          tool("report_stage", { number: 42, stage: "review" }),
          tool("report_stage", { number: 42, stage: "review" }),
          tool("report_stage", { number: 42, stage: "pr" }),
          tool("report_ready_for_merge", readyReport(head)),
          { end: "success" },
        ],
      },
      {
        match: "^確認した PR を完了",
        steps: [
          tool("report_stage", { number: 42, stage: "merge" }),
          tool("report_implementation_done", finishReport(commit)),
          { end: "success" },
        ],
      },
    ],
  });

  await ready();
  const c = conversation()!;
  const root = c.cwd;
  await expect.poll(() => f.runner.runtime.store.get(c.id)?.runState).toBe("idle");
  expect(
    f
      .events("ready")
      .filter(({ type }) => type === "stage_changed")
      .map(({ payload }) => payload),
  ).toEqual([{ stage: "implement" }, { stage: "review" }, { stage: "pr" }, { stage: "ci" }]);
  view("MERGED");
  expect((await send(c.id, "確認した PR を完了")).status).toBe(200);
  await expect
    .poll(() => f.events("ready").find(({ type }) => type === "worktree_removed"), {
      timeout: 2500,
    })
    .toMatchObject({
      payload: { worktreeId: c.worktreeId, path: root },
    });
  expect(state("ready")).toBe("done");
  expect(existsSync(root)).toBe(false);
  expect(git(path, "rev-parse", "refs/heads/sukuna/issue-42")).toBe(head);
  expect(f.runner.runtime.store.get(c.id)).toMatchObject({ cwd: path, worktreeId: null });
  expect(f.events("ready").find(({ type }) => type === "implementation_done")?.payload).toEqual({
    prUrl: pr,
    mergeCommit: commit,
    summary: "完了",
  });
  expect(
    f
      .events("ready")
      .filter(({ type }) => type === "stage_changed")
      .at(-1)?.payload,
  ).toEqual({ stage: "merge" });
});

it("実装枠を優先順に取り、1件の完了後に次の候補を始める", async () => {
  const path = prepareGit();
  const head = git(path, "rev-parse", "HEAD");
  f.addIssue("ready", 42, { state: "ready", priority: "low" });
  f.addIssue("one", 1, { state: "ready", priority: "medium" });
  for (const number of [2, 3, 4, 5, 6]) {
    f.addIssue(String(number), number, {
      state: "ready",
      priority: number === 6 ? "high" : "medium",
    });
  }
  f.depend("6", "ready");
  await notify("ready");
  await expect
    .poll(() => f.agent.sent.map(({ text }) => /^#\d+/.exec(text)?.[0]), { timeout: 3000 })
    .toEqual(["#42", "#1", "#2", "#3", "#4"]);
  expect(state("5")).toBe("ready");
  expect(state("6")).toBe("ready");
  expect(
    (await report("ready", "report_implementation_done", finishReport(head, null))).isError,
  ).toBe(false);
  await expect
    .poll(() => f.agent.sent.map(({ text }) => /^#\d+/.exec(text)?.[0]), { timeout: 3000 })
    .toEqual(["#42", "#1", "#2", "#3", "#4", "#6"]);
  expect(state("5")).toBe("ready");
});

it.each([
  { timed: false, expected: "型検査、配備" },
  { timed: true, expected: "CI が 60 分で終わりませんでした" },
])("実装の CI 失敗を停止理由に記録する ($timed)", async ({ timed, expected }) => {
  prepareGit();
  f.runner.runtime.options.agent = new ScriptedAgent({
    rules: [
      {
        match: "^#42",
        steps: [
          tool("report_ci_failed", {
            number: 42,
            checks: [
              { name: "型検査", bucket: "fail" },
              { name: "配備", bucket: "cancel" },
            ],
            timed_out: timed,
            summary: "検査失敗",
          }),
          { end: "success" },
        ],
      },
    ],
  });
  await ready();
  await expect.poll(() => state("ready")).toBe("stopped");
  expect(f.events("ready").at(-1)?.payload).toMatchObject({
    stopReason: "ci_failed",
    detail: expected,
  });
  expect(f.events("ready").some(({ type }) => type === "implementation_done")).toBe(false);
});

it("確認で止まり、既存の merge 許可から同じ実装の会話が完了する", async () => {
  const path = prepareGit(true);
  const head = git(path, "rev-parse", "HEAD");
  const view = scriptedPr(head);
  f.runner.runtime.options.agent = new ScriptedAgent({
    rules: [
      {
        match: "^#42",
        steps: [tool("report_ready_for_merge", readyReport(head)), { end: "success" }],
      },
      {
        match: "許可",
        steps: [tool("report_implementation_done", finishReport(commit)), { end: "success" }],
      },
    ],
    fallback: [{ hold: true }],
  });
  await ready("ready", 42, true);
  await expect.poll(() => state("ready")).toBe("stopped");
  expect(f.events("ready").at(-1)?.payload).toMatchObject({ stopReason: "merge_confirm" });
  const c = conversation()!;
  await expect.poll(() => f.runner.runtime.store.get(c.id)?.runState).toBe("idle");
  view("MERGED");
  const allowed = await f.link.forward("POST", "/flow/issues/ready/pr/allow-merge", {
    head_sha: head,
  });
  expect(allowed.status).toBe(200);
  await expect.poll(() => state("ready"), { timeout: 2500 }).toBe("done");
  expect(conversation()?.id).toBe(c.id);
  expect(f.events("ready").some(({ type }) => type === "merge_allowed")).toBe(true);
});

it("人への質問に回答すると実装中へ戻り、同じ worktree で続く", async () => {
  prepareGit();
  f.runner.runtime.options.agent = new ScriptedAgent({
    rules: [
      {
        match: "^#42",
        steps: [
          tool("report_needs_human", {
            number: 42,
            questions: [{ text: "色を決めてください。" }],
            summary: "色",
          }),
          { end: "success" },
        ],
      },
    ],
    fallback: [{ hold: true }],
  });
  await ready();
  const c = conversation()!;
  await expect.poll(() => state("ready")).toBe("stopped");
  expect(f.events("ready").at(-1)?.payload).toMatchObject({
    stopReason: "question",
    detail: "色を決めてください。",
  });
  await expect.poll(() => f.runner.runtime.store.get(c.id)?.runState).toBe("idle");
  expect((await send(c.id, "青を使う")).status).toBe(200);
  await expect.poll(() => state("ready")).toBe("implementing");
  expect(conversation()).toMatchObject({ id: c.id, cwd: c.cwd, worktreeId: c.worktreeId });
  expect(f.events("ready").at(-1)?.payload).toEqual({ stage: "implement" });
});

it.each(["dirty", "ahead"] as const)("完了時、%s な実装 worktree を残す", async (kind) => {
  const path = prepareGit(true);
  const head = git(path, "rev-parse", "HEAD");
  const view = scriptedPr(head);
  await ready();
  const c = conversation()!;
  expect((await report("ready", "report_ready_for_merge", readyReport(head))).isError).toBe(false);
  view("MERGED");
  const changes = join(c.cwd, "only-here.txt");
  writeFileSync(changes, "作業を保全");
  if (kind === "ahead") {
    git(c.cwd, "add", "only-here.txt");
    git(c.cwd, "commit", "-qm", "local only");
  }
  const result = await report("ready", "report_implementation_done", finishReport(commit));
  expect(result.isError, result.text).toBe(false);
  expect(state("ready")).toBe("done");
  expect(readFileSync(changes, "utf8")).toBe("作業を保全");
  expect(f.events("ready").at(-1)).toMatchObject({
    type: "worktree_kept",
    payload: {
      worktreeId: c.worktreeId,
      path: c.cwd,
      uncommittedFiles: kind === "dirty" ? 1 : 0,
      unpushedCommits: kind === "ahead" ? 1 : 0,
    },
  });
  expect(f.db.select().from(notifications).all()).toHaveLength(0);
});

it("GitHub を使わず、台本の Git 操作で既定ブランチへ fast-forward する", async () => {
  const path = prepareGit();
  writeFileSync(join(path, "change.txt"), "実装");
  git(path, "add", "change.txt");
  const tree = git(path, "write-tree");
  const head = git(path, "commit-tree", tree, "-p", "HEAD", "-m", "implementation");
  git(path, "reset", "--hard", "HEAD");
  f.runner.runtime.options.agent = new ScriptedAgent({
    rules: [
      {
        match: "^#42",
        steps: [
          { shell: `git reset --hard ${head}` },
          tool("report_ready_for_merge", readyReport(head, null)),
          { shell: `git -C ../../.. merge --ff-only ${head}` },
          tool("report_implementation_done", finishReport(head, null)),
          { end: "success" },
        ],
      },
    ],
  });
  await ready();
  await expect.poll(() => state("ready"), { timeout: 2500 }).toBe("done");
  expect(git(path, "rev-parse", "HEAD")).toBe(head);
  expect(readFileSync(join(path, "change.txt"), "utf8")).toBe("実装");
  expect(
    f.events("ready").find(({ type }) => type === "implementation_done")?.payload,
  ).toMatchObject({
    prUrl: null,
    mergeCommit: head,
  });
});

it("GitHub の直接 merge は作業中の番の終わりまで待ってから記録する", async () => {
  const path = prepareGit(true);
  const head = git(path, "rev-parse", "HEAD");
  const view = scriptedPr(head);
  await ready();
  const c = conversation()!;
  expect((await report("ready", "report_ready_for_merge", readyReport(head))).isError).toBe(false);
  view("MERGED");
  await notify("ready");
  expect(state("ready")).toBe("implementing");
  expect((await f.runner.runtime.stop(c.id)).isOk()).toBe(true);
  await expect.poll(() => state("ready"), { timeout: 2500 }).toBe("done");
  expect(f.events("ready").find(({ type }) => type === "implementation_done")?.payload).toEqual({
    prUrl: pr,
    mergeCommit: commit,
    summary: "GitHub で merge されました",
  });
});

it("報告せずに白紙の番を終えると report_ready_for_merge を名指しする", async () => {
  prepareGit();
  f.runner.runtime.options.agent = new ScriptedAgent({
    rules: [{ match: "^#42", steps: [{ end: "success" }] }],
    fallback: [{ hold: true }],
  });
  await ready();
  await expect
    .poll(() => f.events("ready").some(({ type }) => type === "report_nudged"))
    .toBe(true);
  const messages = f.runner.runtime.store.events(conversation()!.id);
  const input = messages.filter(({ type }) => type === "user_message").at(-1);
  expect(input?.type === "user_message" && input.payload.text).toBe(
    "この issue の結果を report_ready_for_merge で報告してください。人の判断が要るときは report_needs_human で報告してください",
  );
});

it("子が完了すると親も閉じ、親を待っていた実装を始める", async () => {
  const path = prepareGit();
  const head = git(path, "rev-parse", "HEAD");
  f.addIssue("parent", 41, { state: "ready" });
  f.addIssue("dependent", 43, { state: "ready" });
  f.depend("dependent", "parent");
  f.addIssue("ready", 42, { state: "ready", parentId: "parent" });
  await notify("ready");
  await expect.poll(() => state("ready")).toBe("implementing");
  await expect.poll(() => conversation()?.worktreeId).toBeTruthy();
  expect(state("parent")).toBe("ready");
  expect(state("dependent")).toBe("ready");
  expect(
    (await report("ready", "report_implementation_done", finishReport(head, null))).isError,
  ).toBe(false);
  await expect.poll(() => state("dependent")).toBe("implementing");
  expect(state("parent")).toBe("done");
  expect(f.events("parent").find(({ type }) => type === "state_changed")?.payload).toMatchObject({
    cause: "children_closed",
  });
});

it("指定した無視ファイルだけを worktree に複製する", async () => {
  const path = prepareGit();
  writeFileSync(join(path, ".gitignore"), ".local/\n");
  writeFileSync(
    join(path, ".worktreeinclude"),
    "/.local/*\n!/.local/excluded\n/not-ignored\n/tracked\n",
  );
  writeFileSync(join(path, "tracked"), "追跡済み");
  git(path, "add", ".gitignore", ".worktreeinclude", "tracked");
  git(path, "commit", "-qm", "fixture");
  const local = join(path, ".local");
  mkdirSync(local);
  writeFileSync(join(local, "config"), "設定");
  writeFileSync(join(local, "excluded"), "除外");
  writeFileSync(join(path, "tracked"), "追跡ファイルの未保存変更");
  writeFileSync(join(path, "not-ignored"), "無視していない");
  await ready();
  const cwd = conversation()!.cwd;
  expect(readFileSync(join(cwd, ".local/config"), "utf8")).toBe("設定");
  expect(readFileSync(join(cwd, "tracked"), "utf8")).toBe("追跡済み");
  expect(existsSync(join(cwd, ".local/excluded"))).toBe(false);
  expect(existsSync(join(cwd, "not-ignored"))).toBe(false);
});

it("worktree 作成に2度失敗しても指示を配達せず、直すと最初の指示と一緒に送る", async () => {
  const path = prepareGit();
  const parent = join(path, ".claude/worktrees");
  mkdirSync(parent, { recursive: true });
  const block = join(parent, "issue-42");
  writeFileSync(block, "衝突");
  f.addIssue("ready", 42, { state: "ready" });
  await notify("ready");
  await expect.poll(() => state("ready"), { timeout: 2500 }).toBe("stopped");
  const c = conversation()!;
  expect(f.events("ready").at(-1)?.payload).toMatchObject({
    stopReason: "failed",
    cause: "worktree_failed",
    detail: expect.stringMatching(/^worktree を作れませんでした:/),
  });
  const blocked = await send(c.id, "追加の指示");
  expect(blocked.status).toBe(500);
  expect(await blocked.json()).toMatchObject({ error: { code: "worktree_failed" } });
  expect(state("ready")).toBe("stopped");
  expect(
    f.runner.runtime.store.events(c.id).filter(({ type }) => type === "user_message"),
  ).toHaveLength(0);
  unlinkSync(block);
  expect((await send(c.id, "修正して再開")).status).toBe(200);
  await expect.poll(() => state("ready")).toBe("implementing");
  expect(conversation()?.cwd).toBe(block);
  const messages = f.runner.runtime.store
    .events(c.id)
    .filter(({ type }) => type === "user_message");
  expect(messages).toHaveLength(1);
  expect(messages[0]?.payload).toMatchObject({
    origin: "developer",
    text: expect.stringMatching(/^#42[\s\S]*修正して再開$/),
  });
  expect(f.events("ready").at(-1)?.payload).toMatchObject({ reason: "worktree_retry" });
});

function seededImplementation(id: string, number: number, path: string) {
  const now = 1000000;
  f.addIssue(id, number, { state: "implementing" });
  f.db
    .insert(issueEvents)
    .values({
      issueId: id,
      seq: 1,
      type: "state_changed",
      createdAt: now,
      payload: {
        from: "ready",
        to: "implementing",
        stopReason: null,
        detail: null,
        cause: "impl_started",
      },
    })
    .run();
  const branch = `sukuna/issue-${number}`;
  const tree = {
    id: ulid(now),
    projectId: "p",
    issueId: id,
    branch,
    path: join(path, `.claude/worktrees/issue-${number}`),
    branchCreated: true,
    origin: "flow" as const,
    portSlot: 0,
  };
  git(path, "worktree", "add", "-b", branch, tree.path, "main");
  f.db.insert(worktrees).values(tree).run();
  const gitDir = worktreeGitDirectory(tree.path)!;
  const registration = worktreeRegistration(gitDir, tree.path)!.id;
  const directory = physicalDirectory(tree.path)!;
  f.db
    .insert(settings)
    .values({
      key: `implementation-worktree:${tree.id}`,
      value: { identity: { registration, directory }, cleanupPath: null },
    })
    .run();
  return tree;
}

it("再起動のとき未配達なら最初から同じ worktree を使い、作業中なら続きの指示を送る", async () => {
  const path = prepareGit();
  const existing = seededImplementation("ready", 42, path);
  await f.restart();
  await expect.poll(() => conversation()?.worktreeId, { timeout: 2500 }).toBe(existing.id);
  await expect.poll(() => conversation()?.runState).toBe("working");
  const c = conversation()!;
  expect(c.cwd).toBe(existing.path);
  await f.restart();
  await expect
    .poll(
      () =>
        f
          .events("ready")
          .some(({ payload }) => (payload as { reason?: string }).reason === "restart"),
      { timeout: 2500 },
    )
    .toBe(true);
  expect(conversation()?.worktreeId).toBe(existing.id);
  expect(conversation()?.id).toBe(c.id);
  expect(f.agent.sent.map(({ text }) => text)).toEqual([restartInstruction]);
  expect(f.db.select().from(worktrees).all()).toHaveLength(1);
});

it("片付け前に止まった完了 issue を起動後に片付ける", async () => {
  const path = prepareGit();
  const existing = seededImplementation("ready", 42, path);
  f.db.update(issues).set({ state: "done" }).where(eq(issues.id, "ready")).run();
  await f.restart();
  await expect
    .poll(() => f.events("ready").some(({ type }) => type === "worktree_removed"), {
      timeout: 2500,
    })
    .toBe(true);
  expect(existsSync(existing.path)).toBe(false);
  expect(
    f.db.select().from(worktrees).where(eq(worktrees.id, existing.id)).get()?.removedAt,
  ).not.toBeNull();
});

it("端末の終了確認が届くまで古い ID の作業場所を保持し、確認後に片付ける", async () => {
  const path = prepareGit();
  const head = git(path, "rev-parse", "HEAD");
  let notified!: (value: TerminalCleanupRequest) => void;
  let confirm!: () => void;
  const request = new Promise<TerminalCleanupRequest>((resolve) => (notified = resolve));
  closeTerminal = (value) =>
    new Promise<void>((resolve) => {
      notified(value);
      confirm = resolve;
    });
  await ready();
  const c = conversation()!;
  const completion = report("ready", "report_implementation_done", finishReport(head, null));
  try {
    expect(await request).toMatchObject({ worktree_id: c.worktreeId, path: c.cwd });
    expect(state("ready")).toBe("done");
    expect(existsSync(c.cwd)).toBe(true);
    expect(f.events("ready").some(({ type }) => type === "worktree_removed")).toBe(false);
  } finally {
    confirm();
  }
  expect((await completion).isError).toBe(false);
  expect(existsSync(c.cwd)).toBe(false);
});

it("画面サーバーがいなければ完了だけ記録し、接続が戻ったときに片付ける", async () => {
  const path = prepareGit();
  const head = git(path, "rev-parse", "HEAD");
  await ready();
  const c = conversation()!;
  f.link.stop();
  await expect.poll(() => f.runner.changes.terminalCleanupAvailable).toBe(false);
  expect(
    (await report("ready", "report_implementation_done", finishReport(head, null))).isError,
  ).toBe(false);
  expect(state("ready")).toBe("done");
  expect(existsSync(c.cwd)).toBe(true);
  expect(f.events("ready").some(({ type }) => type === "worktree_kept")).toBe(false);
  f.link.start();
  await expect
    .poll(() => f.events("ready").some(({ type }) => type === "worktree_removed"), {
      timeout: 2500,
    })
    .toBe(true);
  expect(existsSync(c.cwd)).toBe(false);
});

it("先に完了させた PR の通知では、やり直す実装を完了にしない", async () => {
  const path = prepareGit(true);
  const head = git(path, "rev-parse", "HEAD");
  scriptedPr(head, "MERGED");
  f.addIssue("ready", 42, { state: "ready", prUrl: pr });
  f.db
    .insert(issueEvents)
    .values({
      issueId: "ready",
      seq: 1,
      type: "implementation_done",
      createdAt: 900000,
      payload: { prUrl: pr, mergeCommit: commit, summary: "前の実装" },
    })
    .run();
  await notify("ready");
  await expect.poll(() => conversation()?.worktreeId, { timeout: 2000 }).toBeTruthy();
  const result = await report("ready", "report_implementation_done", finishReport(commit));
  expect(result.isError).toBe(true);
  expect(state("ready")).toBe("implementing");
  expect(f.events("ready").filter(({ type }) => type === "implementation_done")).toHaveLength(1);
});

it("実際に孫を再開すると、祖先まで戻してから祖父に依存する実装を評価する", async () => {
  prepareGit();
  f.addIssue("grandparent", 1, { state: "done", closedAt: 900000 });
  f.addIssue("parent", 2, { state: "done", parentId: "grandparent", closedAt: 900000 });
  f.addIssue("child", 3, { state: "done", parentId: "parent", closedAt: 900000 });
  f.addIssue("waiting", 4, { state: "ready" });
  f.depend("waiting", "grandparent");
  expect((await f.request("/api/issues/child/reopen", "POST")).status).toBe(200);
  await expect.poll(() => state("grandparent")).toBe("ready");
  expect(state("parent")).toBe("ready");
  expect(state("waiting")).toBe("ready");
  expect(conversation("waiting")).toBeUndefined();
  expect(f.events("grandparent").filter(({ type }) => type === "state_changed")).toHaveLength(1);
});

function replaceWorktree(project: string, path: string, protectedBranch: string, parked: string) {
  git(project, "worktree", "move", path, parked);
  if (git(parked, "branch", "--show-current") === protectedBranch)
    git(parked, "checkout", "--detach", "HEAD");
  git(project, "worktree", "add", path, protectedBranch);
  writeFileSync(join(path, "developer-local.txt"), "この作業場所を所有する人の変更");
}

it("Git add 直後に作り直した worktree には初回の指示を渡さない", async () => {
  const project = prepareGit();
  const path = join(project, ".claude/worktrees/issue-42");
  const parked = join(project, "parked");
  f.interceptGit((args) => {
    if (args[0] !== "worktree" || args[1] !== "add" || !args.includes(path)) return;
    f.interceptGit(undefined);
    replaceWorktree(project, path, "sukuna/issue-42", parked);
  });
  f.addIssue("ready", 42, { state: "ready" });
  await notify("ready");
  await expect.poll(() => state("ready"), { timeout: 2500 }).toBe("stopped");
  expect(conversation()?.worktreeId).toBeNull();
  expect(f.agent.sent).toHaveLength(0);
  expect(existsSync(join(path, "developer-local.txt"))).toBe(true);
});

it("以前の Git 登録でない同パス・同ブランチには再起動から配達しない", async () => {
  const project = prepareGit();
  const original = seededImplementation("ready", 42, project);
  replaceWorktree(project, original.path, original.branch, join(project, "parked"));
  await f.restart();
  await expect.poll(() => state("ready"), { timeout: 2500 }).toBe("stopped");
  expect(f.agent.sent).toHaveLength(0);
  expect(conversation()?.worktreeId).toBeNull();
  expect(existsSync(join(original.path, "developer-local.txt"))).toBe(true);
});

it("端末終了後の最後の Git 状況確認で登録が差し替わっても、新しい作業場所を消さない", async () => {
  const project = prepareGit();
  const head = git(project, "rev-parse", "HEAD");
  await ready();
  const c = conversation()!;
  const parked = join(project, "parked");
  let acknowledged = false;
  closeTerminal = () => {
    acknowledged = true;
    return Promise.resolve();
  };
  f.interceptGit((args) => {
    if (!acknowledged || args[0] !== "rev-list") return;
    f.interceptGit(undefined);
    git(project, "worktree", "move", c.cwd, parked);
    git(project, "worktree", "add", "-b", "developer/new", c.cwd, "main");
    writeFileSync(join(c.cwd, "developer-local.txt"), "この作業場所を所有する人の変更");
  });
  expect(
    (await report("ready", "report_implementation_done", finishReport(head, null))).isError,
  ).toBe(false);
  expect(f.events("ready").at(-1)?.type).toBe("worktree_kept");
  expect(existsSync(parked)).toBe(true);
  expect(existsSync(join(c.cwd, "developer-local.txt"))).toBe(true);
  expect(git(c.cwd, "branch", "--show-current")).toBe("developer/new");
});

it("保留後に同じ場所を作り直すと再接続しても新しい worktree を残す", async () => {
  const project = prepareGit();
  const head = git(project, "rev-parse", "HEAD");
  await ready();
  const c = conversation()!;
  f.link.stop();
  await expect.poll(() => f.runner.changes.terminalCleanupAvailable).toBe(false);
  expect(
    (await report("ready", "report_implementation_done", finishReport(head, null))).isError,
  ).toBe(false);
  replaceWorktree(project, c.cwd, "sukuna/issue-42", join(project, "parked"));
  f.link.start();
  await expect.poll(() => f.events("ready").at(-1)?.type, { timeout: 2500 }).toBe("worktree_kept");
  expect(existsSync(join(c.cwd, "developer-local.txt"))).toBe(true);
});

it("旧端末の終了応答を待つ間に再接続しても排他解放後に片付けを再試行する", async () => {
  const project = prepareGit();
  const head = git(project, "rev-parse", "HEAD");
  let releaseOld: (() => void) | undefined;
  const requests: string[] = [];
  closeTerminal = (request) => {
    requests.push(request.request_id);
    return requests.length === 1
      ? new Promise<void>((resolve) => {
          releaseOld = resolve;
        })
      : Promise.resolve();
  };
  await ready();
  const c = conversation()!;
  const pending = report("ready", "report_implementation_done", finishReport(head, null));
  try {
    await expect.poll(() => requests.length).toBe(1);
    f.link.stop();
    await expect.poll(() => f.runner.changes.terminalCleanupAvailable).toBe(false);
    f.link.start();
    expect((await pending).isError).toBe(false);
    await expect
      .poll(() => f.events("ready").at(-1)?.type, { timeout: 2500 })
      .toBe("worktree_removed");
    expect(requests.length).toBe(2);
    expect(requests[0]).not.toBe(requests[1]);
    expect(existsSync(c.cwd)).toBe(false);
  } finally {
    releaseOld?.();
  }
});

it("用意した実装の base とブランチを照合し、前回の ready を今回に持ち越さない", async () => {
  const path = prepareGit(true);
  const head = git(path, "rev-parse", "HEAD");
  const view = scriptedPr(head);
  const prior = "https://github.com/fixture/project/pull/99";
  f.addIssue("ready", 42, { state: "ready", prUrl: prior });
  for (const [seq, type, payload] of [
    [1, "ready_for_merge", { prUrl: prior, headSha: head }],
    [2, "implementation_done", { prUrl: prior, mergeCommit: commit }],
  ] as const) {
    f.db
      .insert(issueEvents)
      .values({
        issueId: "ready",
        seq,
        type,
        createdAt: 900000,
        payload,
      })
      .run();
  }
  await notify("ready");
  await expect.poll(() => conversation()?.worktreeId, { timeout: 2500 }).toBeTruthy();
  view("OPEN", { base: "release" });
  expect((await report("ready", "report_ready_for_merge", readyReport(head))).isError).toBe(true);
  view("MERGED", { base: "main", branch: "other" });
  expect((await report("ready", "report_implementation_done", finishReport(commit))).isError).toBe(
    true,
  );
  view("OPEN", { branch: "sukuna/issue-42" });
  expect((await report("ready", "report_ready_for_merge", readyReport(head))).isError).toBe(false);
  expect(f.events("ready").at(-2)?.payload).toMatchObject({
    prUrl: pr,
    worktreeId: conversation()?.worktreeId,
  });
});

it("許可済み rebase の扱いを別 PR に広げない", async () => {
  const path = prepareGit(true);
  const head = git(path, "rev-parse", "HEAD");
  scriptedPr(head);
  f.runner.runtime.options.agent = new ScriptedAgent({
    rules: [
      {
        match: "^#42",
        steps: [tool("report_ready_for_merge", readyReport(head)), { end: "success" }],
      },
    ],
    fallback: [{ hold: true }],
  });
  await ready("ready", 42, true);
  const c = conversation()!;
  await expect.poll(() => f.runner.runtime.store.get(c.id)?.runState).toBe("idle");
  expect(state("ready")).toBe("stopped");
  expect(
    (await f.link.forward("POST", "/flow/issues/ready/pr/allow-merge", { head_sha: head })).status,
  ).toBe(200);
  const other = "https://github.com/fixture/project/pull/99";
  const announced = await report("ready", "report_ready_for_merge", {
    ...readyReport(head, other),
    rebased: true,
  });
  expect(announced.isError).toBe(false);
  expect(announced.text).toContain("merge 前の確認で止めました");
  expect(state("ready")).toBe("stopped");
});

it("確認を求める手元実装は既定ブランチに入っていても未許可の完了を受けない", async () => {
  const path = prepareGit();
  const head = git(path, "rev-parse", "HEAD");
  await ready("ready", 42, true);
  const c = conversation()!;
  expect(
    (await report("ready", "report_implementation_done", finishReport(head, null))).isError,
  ).toBe(true);
  expect(state("ready")).toBe("implementing");
  expect(existsSync(c.cwd)).toBe(true);
});

it("同じ PR の確認済み rebase は許可を引き継ぎ、その head の完了だけを受ける", async () => {
  const path = prepareGit(true);
  const head = git(path, "rev-parse", "HEAD");
  const view = scriptedPr(head);
  f.runner.runtime.options.agent = new ScriptedAgent({
    rules: [
      {
        match: "^#42",
        steps: [tool("report_ready_for_merge", readyReport(head)), { end: "success" }],
      },
    ],
    fallback: [{ hold: true }],
  });
  await ready("ready", 42, true);
  const c = conversation()!;
  await expect.poll(() => f.runner.runtime.store.get(c.id)?.runState).toBe("idle");
  expect(state("ready")).toBe("stopped");
  expect(
    (await f.link.forward("POST", "/flow/issues/ready/pr/allow-merge", { head_sha: head })).status,
  ).toBe(200);
  git(c.cwd, "commit", "--allow-empty", "-qm", "rebased head");
  const rebasedHead = git(c.cwd, "rev-parse", "HEAD");
  view("OPEN", { head: rebasedHead });
  const reply = await report("ready", "report_ready_for_merge", {
    ...readyReport(rebasedHead),
    rebased: true,
  });
  expect(reply).toMatchObject({ isError: false, text: "CI を待って merge してください" });
  view("MERGED", { head });
  expect((await report("ready", "report_implementation_done", finishReport(commit))).isError).toBe(
    true,
  );
  expect(state("ready")).toBe("implementing");
  view("MERGED", { head: rebasedHead });
  expect((await report("ready", "report_implementation_done", finishReport(commit))).isError).toBe(
    false,
  );
  expect(state("ready")).toBe("done");
});

it("子の再開を処理する同じ評価で ready の祖父を仮に完了へ進めない", async () => {
  prepareGit();
  f.addIssue("grandparent", 1, { state: "ready" });
  f.addIssue("parent", 2, { state: "done", parentId: "grandparent", closedAt: 900000 });
  f.addIssue("child", 3, { state: "done", parentId: "parent", closedAt: 900000 });
  f.addIssue("waiting", 4, { state: "ready" });
  f.depend("waiting", "grandparent");
  expect((await f.request("/api/issues/child/reopen", "POST")).status).toBe(200);
  await expect.poll(() => state("parent")).toBe("ready");
  expect(state("grandparent")).toBe("ready");
  expect(f.events("grandparent")).toHaveLength(0);
  expect(state("waiting")).toBe("ready");
  expect(conversation("waiting")).toBeUndefined();
});

it.each(["amend", "rebase", "local"] as const)(
  "許可済みの差分は実際の GitHub base で確かめる (%s)",
  async (operation) => {
    const project = prepareGit(true);
    const lines = Array.from({ length: 20 }, (_, index) => `初期値 ${index}\n`);
    writeFileSync(join(project, "approved.txt"), lines.join(""));
    git(project, "add", "approved.txt");
    git(project, "commit", "-qm", "initial tracked lines");
    git(project, "push", "origin", "main");
    const main = git(project, "rev-parse", "HEAD");
    const view = scriptedPr(main);
    await ready("ready", 42, true);
    const c = conversation()!;
    expect((await f.runner.runtime.stop(c.id)).isOk()).toBe(true);
    await expect.poll(() => f.runner.runtime.store.get(c.id)?.runState).toBe("stopped");
    const approvedLines = [...lines];
    approvedLines[1] = "確認する内容\n";
    writeFileSync(join(c.cwd, "approved.txt"), approvedLines.join(""));
    git(c.cwd, "add", "approved.txt");
    git(c.cwd, "commit", "-qm", "approved");
    const approved = git(c.cwd, "rev-parse", "HEAD");
    view("OPEN", { head: approved });
    expect((await report("ready", "report_ready_for_merge", readyReport(approved))).isError).toBe(
      false,
    );
    expect(
      (await f.link.forward("POST", "/flow/issues/ready/pr/allow-merge", { head_sha: approved }))
        .status,
    ).toBe(200);

    let baseTip = main;
    if (operation === "amend") {
      approvedLines[1] = "許可を取っていない変更\n";
      writeFileSync(join(c.cwd, "approved.txt"), approvedLines.join(""));
      git(c.cwd, "add", "approved.txt");
      git(c.cwd, "commit", "--amend", "--no-edit", "-q");
    } else {
      if (operation === "local") {
        writeFileSync(join(project, "unreviewed.txt"), "origin にない変更");
        git(project, "add", "unreviewed.txt");
      } else {
        lines[18] = "同じファイルの無関係な上流変更\n";
        writeFileSync(join(project, "approved.txt"), lines.join(""));
        git(project, "add", "approved.txt");
      }
      git(project, "commit", "-qm", "unrelated");
      if (operation === "rebase") {
        git(project, "push", "origin", "main");
        baseTip = git(project, "rev-parse", "HEAD");
      }
      git(c.cwd, "rebase", "main");
    }

    const head = git(c.cwd, "rev-parse", "HEAD");
    view("OPEN", { head, baseTip });
    const reply = await report("ready", "report_ready_for_merge", {
      ...readyReport(head),
      rebased: true,
    });
    expect(reply.isError).toBe(false);
    const readyEvent = f.events("ready").findLast(({ type }) => type === "ready_for_merge");
    if (operation === "rebase") {
      expect(state("ready")).toBe("implementing");
      expect(readyEvent?.payload).toHaveProperty("approvedReadySeq");
    } else {
      expect(state("ready")).toBe("stopped");
      expect(readyEvent?.payload).not.toHaveProperty("approvedReadySeq");
    }
  },
);

it("PR 確認中の head の変更を検出して古い ready を書かない", async () => {
  const project = prepareGit(true);
  const head = git(project, "rev-parse", "HEAD");
  await ready();
  const c = conversation()!;
  scriptedPr(head, "OPEN", () => {
    git(c.cwd, "commit", "--allow-empty", "-qm", "new work during view");
  });
  expect((await report("ready", "report_ready_for_merge", readyReport(head))).isError).toBe(true);
  expect(f.events("ready").some(({ type }) => type === "ready_for_merge")).toBe(false);
  expect(git(c.cwd, "rev-parse", "HEAD")).not.toBe(head);
});

it("手元の包含確認後の head の変更では古い完了を書かない", async () => {
  const project = prepareGit();
  const head = git(project, "rev-parse", "HEAD");
  await ready();
  const c = conversation()!;
  f.interceptGit((args) => {
    if (args[0] !== "merge-base" || args[1] !== "--is-ancestor" || args[2] !== head) return;
    f.interceptGit(undefined);
    git(c.cwd, "commit", "--allow-empty", "-qm", "new work during verification");
  });
  expect(
    (await report("ready", "report_implementation_done", finishReport(head, null))).isError,
  ).toBe(true);
  expect(state("ready")).toBe("implementing");
  expect(existsSync(c.cwd)).toBe(true);
  expect(git(c.cwd, "rev-parse", "HEAD")).not.toBe(head);
});

it("物理的な隔離先を Git の通常の move の対象にできない", async () => {
  const project = prepareGit();
  const head = git(project, "rev-parse", "HEAD");
  await ready();
  const c = conversation()!;
  const developer = join(project, "developer");
  git(project, "worktree", "add", "-b", "developer/new", developer, "main");
  const protectedFile = join(developer, "local-only.txt");
  writeFileSync(protectedFile, "開発者の変更");
  let checked = false;
  f.interceptGit((args) => {
    const flag = args.indexOf("--work-tree");
    if (flag === -1 || !args.includes("status")) return;
    const hidden = args[flag + 1]!;
    const listing = git(project, "worktree", "list", "--porcelain");
    expect(listing).toContain(`worktree ${c.cwd}`);
    expect(listing).not.toContain(`worktree ${hidden}`);
    expect(() => git(project, "worktree", "move", hidden, join(project, "stolen"))).toThrow();
    checked = true;
  });
  expect(
    (await report("ready", "report_implementation_done", finishReport(head, null))).isError,
  ).toBe(false);
  expect(checked).toBe(true);
  expect(f.events("ready").at(-1)?.type).toBe("worktree_removed");
  expect(existsSync(protectedFile)).toBe(true);
  expect(git(project, "worktree", "list", "--porcelain")).not.toContain(`worktree ${c.cwd}`);
  expect(git(project, "branch", "--list", "sukuna/issue-42")).toContain("sukuna/issue-42");
});

it.each(["移動", "削除"] as const)(
  "片付けの%s直後に発生したランナー再起動で旧 cwd を処理する",
  async (boundary) => {
    const project = prepareGit();
    const head = git(project, "rev-parse", "HEAD");
    await ready();
    const c = conversation()!;
    f.link.stop();
    await expect.poll(() => f.runner.changes.terminalCleanupAvailable).toBe(false);
    expect(
      (await report("ready", "report_implementation_done", finishReport(head, null))).isError,
    ).toBe(false);
    const gitDir = worktreeGitDirectory(c.cwd)!;
    const directory = physicalDirectory(c.cwd)!;
    const registration = worktreeRegistration(gitDir, c.cwd)!.id;
    const container = mkdtempSync(join(project, ".claude/worktrees/.sukuna-remove-"));
    const stage = join(container, "worktree");
    const headLock = join(gitDir, "HEAD.lock");
    writeFileSync(headLock, "");
    const otherLock = join(project, ".git/refs/heads/elsewhere.lock");
    writeFileSync(otherLock, "");
    const locks = [
      { path: headLock, key: physicalFile(headLock)! },
      { path: otherLock, key: physicalFile(otherLock)! },
    ];
    const detached = boundary === "削除";
    f.db
      .update(settings)
      .set({
        value: {
          identity: { directory, registration },
          cleanupPath: stage,
          cleanupDetached: detached,
          cleanupLocks: locks,
        },
      })
      .where(eq(settings.key, `implementation-worktree:${c.worktreeId}`))
      .run();
    renameSync(c.cwd, stage);
    if (detached) {
      const quarantined = join(container, "registration");
      renameSync(gitDir, quarantined);
      rmSync(stage, { recursive: true });
      rmSync(quarantined, { recursive: true });
    }
    f.db.update(conversations).set({ runState: "working" }).where(eq(conversations.id, c.id)).run();
    await f.restart();
    expect(existsSync(otherLock)).toBe(true);
    expect(existsSync(headLock)).toBe(false);
    if (detached) {
      expect(conversation()).toMatchObject({ cwd: project, worktreeId: null });
      expect(f.events("ready").filter(({ type }) => type === "worktree_removed")).toHaveLength(1);
    } else {
      expect(conversation()).toMatchObject({ cwd: c.cwd, worktreeId: c.worktreeId });
      expect(existsSync(c.cwd)).toBe(true);
    }
  },
);

it("中間の親の再開を排他で保存できない間は祖父とその依存側を待たせる", async () => {
  const project = prepareGit();
  f.addIssue("grandparent", 1, { state: "ready" });
  const parent = seededImplementation("parent", 2, project);
  f.db
    .update(issues)
    .set({ state: "done", parentId: "grandparent", closedAt: 900000 })
    .where(eq(issues.id, "parent"))
    .run();
  f.addIssue("child", 3, { state: "done", parentId: "parent", closedAt: 900000 });
  f.addIssue("waiting", 4, { state: "ready" });
  f.depend("waiting", "grandparent");
  f.addIssue("independent", 5, { state: "ready" });
  const held = createWorktreeActivity(f.opened.sqlite.name).acquire([parent.id])._unsafeUnwrap();
  try {
    expect((await f.request("/api/issues/child/reopen", "POST")).status).toBe(200);
    await expect.poll(() => conversation("independent")?.worktreeId).toBeTruthy();
    expect(state("parent")).toBe("done");
    expect(state("grandparent")).toBe("ready");
    expect(state("waiting")).toBe("ready");
    expect(f.events("grandparent")).toHaveLength(0);
    expect(conversation("waiting")).toBeUndefined();
  } finally {
    held.release();
  }
  await notify("child");
  await expect.poll(() => state("parent")).toBe("ready");
  expect(state("grandparent")).toBe("ready");
  expect(state("waiting")).toBe("ready");
});

it("既定ブランチが包含判定中だけ実装の head を指しても古い tip では完了しない", async () => {
  const project = prepareGit();
  const initial = git(project, "rev-parse", "HEAD");
  await ready();
  const c = conversation()!;
  git(c.cwd, "commit", "--allow-empty", "-qm", "only in worktree");
  const head = git(c.cwd, "rev-parse", "HEAD");
  let intervened = false;
  f.interceptGitBefore((args) => {
    if (args[0] !== "merge-base" || args[1] !== "--is-ancestor" || args[2] !== head) return;
    f.interceptGitBefore(undefined);
    expect(args[3]).toBe(initial);
    git(project, "update-ref", "refs/heads/main", head);
    intervened = true;
  });
  f.interceptGit((args) => {
    if (!intervened || args[0] !== "merge-base" || args[1] !== "--is-ancestor" || args[2] !== head)
      return;
    f.interceptGit(undefined);
    git(project, "update-ref", "refs/heads/main", initial);
  });
  expect(
    (await report("ready", "report_implementation_done", finishReport(head, null))).isError,
  ).toBe(true);
  expect(intervened).toBe(true);
  expect(state("ready")).toBe("implementing");
  expect(git(project, "rev-parse", "HEAD")).toBe(initial);
});

it("git status に出ない初期化済みサブモジュールのファイルを片付けで保持する", async () => {
  const project = prepareGit();
  const payload = join(f.home, "payload");
  mkdirSync(payload);
  git(payload, "init", "-q", "-b", "main");
  writeFileSync(join(payload, "tracked.txt"), "base");
  git(payload, "add", "tracked.txt");
  git(payload, "commit", "-qm", "payload");

  await ready();
  const c = conversation()!;
  git(c.cwd, "-c", "protocol.file.allow=always", "submodule", "add", payload, "vendor/payload");
  git(c.cwd, "config", "-f", ".gitmodules", "submodule.vendor/payload.ignore", "all");
  git(c.cwd, "add", ".gitmodules");
  git(c.cwd, "commit", "-qm", "initialize submodule");
  git(project, "merge", "--ff-only", "sukuna/issue-42");
  const head = git(c.cwd, "rev-parse", "HEAD");
  const localNote = join(c.cwd, "vendor/payload/local-note.txt");
  writeFileSync(localNote, "開発者の作業");
  expect(git(c.cwd, "status", "--porcelain")).toBe("");
  expect(() => git(project, "worktree", "remove", c.cwd)).toThrow();
  expect(
    (await report("ready", "report_implementation_done", finishReport(head, null))).isError,
  ).toBe(false);
  expect(f.events("ready").at(-1)?.type).toBe("worktree_kept");
  expect(readFileSync(localNote, "utf8")).toBe("開発者の作業");
});

it.each([false, true])(
  "最初の公開ロックの前後で止まっても記録した個体だけを解除する (%s)",
  async (published) => {
    prepareGit();
    await ready();
    const c = conversation()!;
    const admin = worktreeGitDirectory(c.cwd)!;
    const directory = physicalDirectory(c.cwd)!;
    const registration = worktreeRegistration(admin, c.cwd)!.id;
    const stage = mkdtempSync(join(admin, ".sukuna-lock-"));
    const stagedPath = join(stage, "lock");
    const path = join(admin, "HEAD.lock");
    writeFileSync(stagedPath, "");
    if (published) linkSync(stagedPath, path);
    else writeFileSync(path, "別の操作が開いたロック");
    const publicKey = physicalFile(path);
    f.db
      .update(settings)
      .set({
        value: {
          identity: { directory, registration },
          cleanupPath: null,
          cleanupLocks: [{ path, stagedPath, key: physicalFile(stagedPath)! }],
        },
      })
      .where(eq(settings.key, `implementation-worktree:${c.worktreeId}`))
      .run();
    await f.restart();
    expect(existsSync(stage)).toBe(false);
    expect(physicalFile(path)).toBe(published ? null : publicKey);
    expect(conversation()).toMatchObject({ cwd: c.cwd, worktreeId: c.worktreeId });
    expect(state("ready")).toBe("implementing");
  },
);

it("隔離中断からの復旧でも初期化したサブモジュールを削除しない", async () => {
  const project = prepareGit();
  const payload = join(f.home, "payload");
  mkdirSync(payload);
  git(payload, "init", "-q", "-b", "main");
  git(payload, "commit", "--allow-empty", "-qm", "payload");
  await ready();
  const c = conversation()!;
  git(c.cwd, "-c", "protocol.file.allow=always", "submodule", "add", payload, "vendor/payload");
  git(c.cwd, "config", "-f", ".gitmodules", "submodule.vendor/payload.ignore", "all");
  git(c.cwd, "add", ".gitmodules");
  git(c.cwd, "commit", "-qm", "initialize");
  git(project, "merge", "--ff-only", "sukuna/issue-42");
  const head = git(c.cwd, "rev-parse", "HEAD");
  writeFileSync(join(c.cwd, "vendor/payload/local-note.txt"), "残すデータ");
  expect(git(c.cwd, "status", "--porcelain")).toBe("");
  f.link.stop();
  await expect.poll(() => f.runner.changes.terminalCleanupAvailable).toBe(false);
  expect(
    (await report("ready", "report_implementation_done", finishReport(head, null))).isError,
  ).toBe(false);
  const admin = worktreeGitDirectory(c.cwd)!;
  const directory = physicalDirectory(c.cwd)!;
  const registration = worktreeRegistration(admin, c.cwd)!.id;
  const container = mkdtempSync(join(project, ".claude/worktrees/.sukuna-remove-"));
  const stage = join(container, "worktree");
  f.db
    .update(settings)
    .set({
      value: { identity: { directory, registration }, cleanupPath: stage, cleanupDetached: true },
    })
    .where(eq(settings.key, `implementation-worktree:${c.worktreeId}`))
    .run();
  renameSync(c.cwd, stage);
  renameSync(admin, join(container, "registration"));
  await f.restart();
  expect(readFileSync(join(stage, "vendor/payload/local-note.txt"), "utf8")).toBe("残すデータ");
  expect(f.events("ready").at(-1)?.type).toBe("worktree_kept");
  expect(conversation()).toMatchObject({ cwd: project, worktreeId: null });
});

it("データのない未初期化 gitlink は正常に片付ける", async () => {
  const project = prepareGit();
  const target = git(project, "rev-parse", "HEAD");
  writeFileSync(
    join(project, ".gitmodules"),
    `[submodule "payload"]\n\tpath = payload\n\turl = ${project}\n`,
  );
  git(project, "add", ".gitmodules");
  git(project, "update-index", "--add", "--cacheinfo", `160000,${target},payload`);
  git(project, "commit", "-qm", "uninitialized gitlink");
  const head = git(project, "rev-parse", "HEAD");
  await ready();
  const c = conversation()!;
  expect(existsSync(join(c.cwd, "payload/.git"))).toBe(false);
  expect(
    (await report("ready", "report_implementation_done", finishReport(head, null))).isError,
  ).toBe(false);
  expect(f.events("ready").at(-1)?.type).toBe("worktree_removed");
  expect(existsSync(c.cwd)).toBe(false);
});
