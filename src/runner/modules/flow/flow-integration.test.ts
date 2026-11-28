import { RunnerLink } from "../../../server/runner-link";
import { createApp } from "../../../server/app";
import { createConversationDependencies } from "../../../server/modules/conversation/adapter/dependencies";
import {
  createClockFake,
  createTailscaleFake,
  incomingWith,
} from "../../../server/modules/identity/test-support";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vite-plus/test";
import { git } from "../../../server/modules/flow/design-test-support";
import { ScriptedGh } from "../../../shared/gh/scripted-gh";
import { issueFixture } from "../../../server/modules/issue/test-support";
import { ScriptedAgent } from "../conversation/adapter/scripted-agent";
import { issueInstructions } from "../issue/domain/issue-instructions";
import { missingReport, restartInstruction, resumeDependency } from "./domain/instructions";
import { designSubmittedSchema } from "../../../shared/api/design";
import { issueViewSchema } from "../../../shared/issue/schema";
import { z } from "zod";
import {
  drafts,
  issueEvents,
  issues,
  projects,
  settings,
  stockItems,
} from "../../../shared/db/schema";

const issueResponse = z.object({ issue: issueViewSchema });

const f = issueFixture(
  {
    rules: [
      {
        match: "^#43「選択」",
        steps: [
          {
            ask: [
              {
                question: "使用する方式？\n続き",
                header: "設計",
                options: [{ label: "A", description: "方式 A" }],
                multi_select: false,
              },
            ],
          },
          { hold: true },
        ],
      },
      {
        match: "^#44「報告」",
        steps: [
          {
            tool: "mcp__sukuna__report_needs_human",
            input: {
              number: 44,
              questions: [{ text: "使用する方式？\n続き", options: ["A"] }],
              summary: "方式要確認",
            },
          },
          { end: "success" },
        ],
      },
      { match: "^#45「失敗」", steps: [{ end: "error_during_execution" }] },
      {
        match: "^#46「利用枠」",
        steps: [
          { rate_limit: { status: "rejected", resetsAt: 1020 } },
          { end: "error_during_execution" },
        ],
      },
      { match: "^#47「報告なし」|^この issue の結果を", steps: [{ end: "success" }] },
      {
        match: "^/dev-spec",
        steps: [
          { tool: "mcp__sukuna__issue_create", input: { title: "親", body: "", designed: true } },
          {
            tool: "mcp__sukuna__issue_create",
            input: { title: "子", body: "", parent: 1, designed: true },
          },
          { end: "success" },
        ],
      },
      {
        match: "^#1「親」",
        steps: [
          {
            tool: "mcp__sukuna__report_triage",
            input: { number: 1, result: "parent", kind: "enhancement", summary: "親" },
          },
          { end: "success" },
        ],
      },
      {
        match: "^#2「子」",
        steps: [
          {
            tool: "mcp__sukuna__report_triage",
            input: { number: 2, result: "design", kind: "enhancement", summary: "子" },
          },
          { end: "success" },
        ],
      },
      {
        match: "^#42「在庫」を精査してください。",
        steps: [
          {
            tool: "mcp__sukuna__report_triage",
            input: { number: 42, result: "design", kind: "enhancement", score: 3, summary: "在庫" },
          },
          { end: "success" },
        ],
      },
      {
        match: "^#42「在庫」を設計してください。",
        steps: [
          {
            tool: "mcp__sukuna__report_design",
            input: { number: 42, policy: "在庫を予約する", checks: [] },
          },
          { end: "success" },
        ],
      },
    ],
    fallback: [{ hold: true }],
  },
  {
    autoFlow: true,
    ghRepository: "sukuna-test/fixture",
    ghScript: {
      responses: [
        {
          match: "^repo view ",
          stdout: JSON.stringify({
            nameWithOwner: "sukuna-test/fixture",
            url: "https://github.com/sukuna-test/fixture",
          }),
          exit_code: 0,
        },
        {
          match: "^pr create ",
          stdout: "https://github.com/sukuna-test/fixture/pull/1\n",
          exit_code: 0,
        },
        {
          match: "^pr view ",
          stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "a".repeat(40) } }),
          exit_code: 0,
        },
      ],
      fallback: { exit_code: 1, stdout: "", stderr: "Unexpected command in fixture" },
    },
  },
);

function prepareGit(usesGithub = false, path = join(f.home, "repo")) {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  git(path, "commit", "--allow-empty", "-qm", "base");
  if (usesGithub) {
    const remote = join(f.home, "remote.git");
    git(f.home, "init", "--bare", "-q", "-b", "main", remote);
    git(path, "remote", "add", "origin", remote);
    git(path, "push", "-qu", "origin", "main");
  }
  f.db
    .update(projects)
    .set({ path, usesGithub, designMergeMode: usesGithub ? "pr" : "direct" })
    .where(eq(projects.id, "p"))
    .run();
}

it("精査の報告を受けて、設計用 worktree の会話を始める", async () => {
  prepareGit();
  f.addIssue("i", 42, { title: "在庫", state: "draft" });
  expect((await f.request("/api/issues/i/confirm", "POST")).status).toBe(200);

  await expect
    .poll(
      async () => issueResponse.parse(await (await f.request("/api/issues/i")).json()).issue.state,
      {
        timeout: 1_500,
      },
    )
    .toBe("design_review");
  const issued = f.runner.runtime.store
    .list()
    .filter((conversation) => conversation.issueId === "i");
  expect(issued.map(({ title, kind, worktreeId }) => ({ title, kind, worktreeId }))).toEqual([
    { title: "#42 の精査", kind: "triage", worktreeId: null },
    { title: "#42 の設計", kind: "design", worktreeId: expect.any(String) },
  ]);
  expect(git(issued[1]!.cwd, "branch", "--show-current")).toBe("sukuna/design-42");
  expect(
    f
      .events("i")
      .filter(({ type }) => type === "ai_started")
      .map(({ payload }) => payload),
  ).toEqual(issued.map(({ id, kind }) => ({ conversationId: id, kind, reason: "start" })));
  expect(
    issued.map(({ id }) => {
      const event = f.runner.runtime.store
        .events(id)
        .find((value) => value.type === "user_message");
      return event?.type === "user_message" ? event.payload.origin : null;
    }),
  ).toEqual(["flow", "flow"]);
});

it("設計済みの issue は精査で設計を省く", async () => {
  f.addIssue("i", 42, { title: "在庫", state: "draft", designed: true });
  expect((await f.request("/api/issues/i/confirm", "POST")).status).toBe(200);
  await expect
    .poll(
      async () => issueResponse.parse(await (await f.request("/api/issues/i")).json()).issue.state,
      {
        timeout: 1_500,
      },
    )
    .toBe("ready");
  expect(
    f.runner.runtime.store
      .list()
      .filter(({ issueId }) => issueId === "i")
      .map(({ kind }) => kind),
  ).toEqual(["triage"]);
});

const snapshot = async (id = "i") =>
  issueResponse.parse(await (await f.request(`/api/issues/${id}`)).json()).issue;
const stageConversation = (kind: "triage" | "design", id = "i") =>
  f.runner.runtime.store.list().find((c) => c.issueId === id && c.kind === kind);
const messages = (id: string) =>
  f.runner.runtime.store.events(id).filter((event) => event.type === "user_message");
const send = (id: string, text: string) =>
  f.link.forward("POST", `/conversations/${id}/messages`, {
    text,
    origin: "developer",
    images: [],
    interrupt: false,
    client_id: `dev-${text}`,
  });

async function confirm(number: number, title: string, id = "i") {
  f.addIssue(id, number, { title, state: "draft" });
  expect((await f.request(`/api/issues/${id}/confirm`, "POST")).status).toBe(200);
}

it("精査が作業中の間は通知を繰り返しても同じ issue の設計を始めない", async () => {
  prepareGit();
  f.runner.runtime.options.agent = new ScriptedAgent({
    rules: [
      {
        match: "^#42",
        steps: [
          {
            tool: "mcp__sukuna__report_triage",
            input: { number: 42, result: "design", kind: "bug", summary: "設計へ" },
          },
          { hold: true },
        ],
      },
    ],
    fallback: [{ hold: true }],
  });
  await confirm(42, "在庫");
  await expect.poll(async () => (await snapshot()).state).toBe("design");
  await Promise.all(
    [{}, { project_id: "p" }, { issue_id: "i" }].map(async (input) => {
      expect((await f.link.forward("POST", "/flow/notify", input)).status).toBe(200);
    }),
  );
  expect(stageConversation("triage")?.runState).toBe("working");
  expect(stageConversation("design")).toBeUndefined();
  expect(f.events("i").filter(({ type }) => type === "ai_started")).toHaveLength(1);
});

it("壁打ちの会話から作った設計済みの親と子を精査する", async () => {
  const chat = (
    await f.runner.runtime.start({
      projectId: "p",
      kind: "chat",
      cwd: f.home,
      title: "会話",
      message: "/dev-spec",
    })
  )._unsafeUnwrap().conversationId;
  await expect
    .poll(() =>
      f.db
        .select()
        .from(issues)
        .all()
        .map(({ number, parentId, state, designed }) => ({
          number,
          child: parentId !== null,
          state,
          designed,
        }))
        .sort((a, b) => a.number - b.number),
    )
    .toEqual([
      { number: 1, child: false, state: "ready", designed: true },
      { number: 2, child: true, state: "ready", designed: true },
    ]);
  expect(
    f.runner.runtime.store
      .list()
      .filter((c) => c.id !== chat)
      .map(({ kind }) => kind),
  ).toEqual(["triage", "triage"]);
});

it("人の判断が要る報告から同じ会話への回答で戻り、実行を開き直しても共通の指示を渡す", async () => {
  await confirm(44, "報告");
  await expect.poll(async () => (await snapshot()).stopReason).toBe("question");
  expect((await snapshot()).stopDetail).toBe("使用する方式？");
  const id = stageConversation("triage")!.id;
  await expect.poll(() => stageConversation("triage")?.runState).toBe("idle");
  expect((await f.runner.runtime.release(id)).isOk()).toBe(true);
  expect((await send(id, "方式 A で進めてください")).status).toBe(200);
  await expect.poll(async () => (await snapshot()).state).toBe("triage");
  expect(messages(id).at(-1)?.payload.text).toBe("方式 A で進めてください");
  expect(
    f.agent.opened
      .filter((open) => open.context.conversationId === id)
      .map((open) => open.appendSystemPrompt.split("\n\n")[0]),
  ).toEqual([issueInstructions(), issueInstructions()]);
});

it("選択式の質問を記録すると停止し、回答で止まった段階へ戻る", async () => {
  await confirm(43, "選択");
  await expect.poll(async () => (await snapshot()).stopReason).toBe("question");
  const id = stageConversation("triage")!.id;
  const question = f.runner.runtime.store.events(id).find((event) => event.type === "question")!;
  expect(
    (
      await f.link.forward("POST", `/conversations/${id}/answers`, {
        request_id: question.payload.request_id,
        answers: { "0": { choices: ["A"], text: null } },
      })
    ).status,
  ).toBe(200);
  await expect.poll(async () => (await snapshot()).state).toBe("triage");
  expect(f.agent.receivedAnswers).toMatchObject([
    { requestId: question.payload.request_id, answers: { "使用する方式？\n続き": "A" } },
  ]);
});

it("失敗で止まった段階は一時停止中でも開発者が同じ会話を再開できる", async () => {
  await confirm(45, "失敗");
  await expect.poll(async () => (await snapshot()).stopReason).toBe("failed");
  const id = stageConversation("triage")!.id;
  f.db.insert(settings).values({ key: "flow_paused", value: true }).run();
  expect((await f.link.forward("POST", `/conversations/${id}/resume`, {})).status).toBe(200);
  await expect.poll(async () => (await snapshot()).state).toBe("triage");
  expect(messages(id).at(-1)?.payload.origin).toBe("resume");
});

it("利用枠が戻る時刻の 1 分後に同じ段階を自動再開する", async () => {
  await confirm(46, "利用枠");
  await expect.poll(async () => (await snapshot()).stopReason).toBe("usage_limit");
  const id = stageConversation("triage")!.id;
  await f.advanceTo(1_079_999);
  expect((await snapshot()).stopReason).toBe("usage_limit");
  await f.advanceTo(1_080_000);
  await expect.poll(async () => (await snapshot()).state).toBe("triage");
  expect(
    f.runner.runtime.store.events(id).findLast((event) => event.type === "resumed")?.payload.by,
  ).toBe("usage_limit");
});

it("報告の催促は一度だけ送り、その番にも報告が無ければ停止する", async () => {
  await confirm(47, "報告なし");
  await expect.poll(async () => (await snapshot()).stopDetail).toBe(missingReport);
  expect((await snapshot()).stopReason).toBe("failed");
  const id = stageConversation("triage")!.id;
  expect(
    f
      .events("i")
      .filter(({ type }) => type === "report_nudged")
      .map(({ payload }) => payload),
  ).toEqual([{ conversationId: id }]);
  expect(messages(id)).toHaveLength(2);
});

it("取り下げられた依存先が解消すると同じ設計の会話に続きが届く", async () => {
  prepareGit();
  f.runner.runtime.options.agent = new ScriptedAgent({
    rules: [
      {
        match: "^#42.*精査",
        steps: [
          {
            tool: "mcp__sukuna__report_triage",
            input: { number: 42, result: "design", kind: "bug", summary: "設計へ" },
          },
          { end: "success" },
        ],
      },
    ],
    fallback: [{ hold: true }],
  });
  await confirm(42, "在庫");
  await expect.poll(() => stageConversation("design")?.runState).toBe("working");
  const id = stageConversation("design")!.id;
  f.addIssue("dependency", 1, { state: "ready" });
  f.depend("i", "dependency");
  f.setTime(1_001_000);
  expect((await f.request("/api/issues/dependency/withdraw", "POST")).status).toBe(200);
  expect((await snapshot()).stopReason).toBe("dependency_withdrawn");
  f.setTime(1_002_000);
  expect((await f.request("/api/issues/dependency/reopen", "POST")).status).toBe(200);
  await expect.poll(() => messages(id).at(-1)?.payload.text).toBe(resumeDependency);
  expect(f.events("i").findLast(({ type }) => type === "ai_started")?.payload).toEqual({
    conversationId: id,
    kind: "design",
    reason: "resume_dependency",
  });
});

it("取り下げられた依存先があると質問への回答後も停止前の段階を保つ", async () => {
  await confirm(44, "報告");
  await expect.poll(async () => (await snapshot()).stopReason).toBe("question");
  f.addIssue("dependency", 1, { state: "withdrawn" });
  f.depend("i", "dependency");
  const id = stageConversation("triage")!.id;
  expect((await send(id, "方式 A")).status).toBe(200);
  await expect.poll(async () => (await snapshot()).stopReason).toBe("dependency_withdrawn");
  expect(f.events("i").findLast(({ type }) => type === "state_changed")?.payload).toMatchObject({
    from: "triage",
    to: "stopped",
    stopReason: "dependency_withdrawn",
  });
  f.setTime(1_001_000);
  expect((await f.request("/api/issues/dependency/reopen", "POST")).status).toBe(200);
  await expect.poll(async () => (await snapshot()).state).toBe("triage");
});

it("ランナー再起動後は作業中だった会話へ続きの指示を送る", async () => {
  await confirm(49, "再起動");
  await expect.poll(() => stageConversation("triage")?.runState).toBe("working");
  const id = stageConversation("triage")!.id;
  f.setTime(1_001_000);
  await f.restart();
  await expect.poll(() => messages(id).at(-1)?.payload.text).toBe(restartInstruction);
  expect(f.events("i").findLast(({ type }) => type === "ai_started")?.payload).toEqual({
    conversationId: id,
    kind: "triage",
    reason: "restart",
  });
});

it("再起動で選択式の質問だった会話は続けず質問を停止理由にする", async () => {
  await confirm(43, "選択");
  await expect.poll(async () => (await snapshot()).stopReason).toBe("question");
  const id = stageConversation("triage")!.id;
  f.db.delete(issueEvents).where(eq(issueEvents.seq, 4)).run();
  f.db.update(issues).set({ state: "triage", stopReason: null }).where(eq(issues.id, "i")).run();
  await f.restart();
  expect(f.runner.runtime.store.get(id)?.runState).toBe("stopped");
  expect(f.events("i").findLast(({ type }) => type === "state_changed")?.payload).toMatchObject({
    cause: "restart_question",
    detail: "使用する方式？",
    stopReason: "question",
  });
  expect(messages(id)).toHaveLength(1);
});

it("設計用 worktree を作れなかった後の最初の指示に開発者の発言を続ける", async () => {
  await confirm(42, "在庫");
  await expect.poll(async () => (await snapshot()).stopReason).toBe("failed");
  expect(f.events("i").findLast(({ type }) => type === "state_changed")?.payload).toMatchObject({
    cause: "worktree_failed",
  });
  const id = stageConversation("design")!.id;
  expect(messages(id)).toHaveLength(0);
  prepareGit(false, f.home);
  const response = await send(id, "仕様を確認してください");
  expect(response.status).toBe(200);
  expect(messages(id)).toMatchObject([
    {
      payload: {
        origin: "developer",
        text: expect.stringMatching(
          /^#42「在庫」を設計してください。[\s\S]*\n\n仕様を確認してください$/,
        ),
      },
    },
  ]);
  expect(f.events("i").findLast(({ type }) => type === "ai_started")?.payload).toEqual({
    conversationId: id,
    kind: "design",
    reason: "worktree_retry",
  });
});

it.each([
  { expired: false, status: 409, code: "conflict" },
  { expired: true, status: 503, code: "runner_unavailable" },
])(
  "worktree の準備中に別タブが下書きを変えると受理を拒否する 期限切れ=$expired",
  async ({ expired, status, code }) => {
    await confirm(42, "在庫");
    await expect.poll(async () => (await snapshot()).stopReason).toBe("failed");
    const id = stageConversation("design")!.id;
    prepareGit(false, f.home);
    const expected = {
      text: "戻した指示と書きかけ",
      images: [],
      updatedAt: 1_000_000,
      updatedBy: "tab",
    };
    const replacement = { ...expected, text: "残す書きかけ", updatedAt: 1_000_001 };
    const peer = { ...expected, text: "別のタブの編集", updatedAt: 1_000_002, updatedBy: "peer" };
    f.runner.runtime.store.writeDraft(id, expected);
    f.interceptGit((args) => {
      if (args[0] !== "worktree" || args[1] !== "add") return;
      f.interceptGit(undefined);
      f.db.update(drafts).set(peer).where(eq(drafts.conversationId, id)).run();
      if (expired) f.setTime(1_011_000);
    });
    const probe = new RunnerLink({
      socket: join(f.home, "runner.sock"),
      log: () => {},
      notice: () => {},
      connection: () => {},
      now: () => 1_000_000,
    });
    const response = (
      await probe.call("POST", `/conversations/${id}/messages`, {
        text: "戻した指示",
        images: [],
        origin: "developer",
        interrupt: false,
        client_id: "restore-after-worktree-retry",
        restore_draft: { expected, replacement },
      })
    )._unsafeUnwrap();

    expect(response).toMatchObject({ status, body: { error: { code } } });
    if (!expired)
      expect(response.body).toMatchObject({
        error: { message: "別の端末で書きかけが変わりました。預け直す前の書きかけを残しました。" },
      });
    expect(f.runner.runtime.store.draft(id)).toEqual(peer);
    expect(stageConversation("design")?.worktreeId).toBeNull();
    expect(messages(id)).toHaveLength(0);
  },
);

it("担当外の精査会話に発言すると設計の会話を案内する", async () => {
  prepareGit();
  await confirm(42, "在庫");
  await expect.poll(async () => (await snapshot()).state).toBe("design_review");
  const reply = await send(stageConversation("triage")!.id, "精査を進めて");
  expect(reply.status).toBe(409);
  expect(await reply.json()).toEqual({
    error: { code: "conflict", message: "この issue はいま 設計 の会話で進んでいます" },
  });
});

function submission() {
  return designSubmittedSchema.parse(
    f.events("i").findLast((event) => event.type === "design_submitted")?.payload,
  );
}

it("全体の一時停止中に反映した設計は、解除の通知で PR の merge を頼み番の終わりに確認する", async () => {
  prepareGit(true);
  f.runner.runtime.options.agent = new ScriptedAgent({
    rules: [
      {
        match: "^#42.*精査",
        steps: [
          {
            tool: "mcp__sukuna__report_triage",
            input: { number: 42, result: "design", kind: "enhancement", summary: "設計へ" },
          },
          { end: "success" },
        ],
      },
      {
        match: "^#42.*設計",
        steps: [
          {
            shell:
              "printf '設計\\n' > design.md && git add design.md && git -c user.name='Test' -c user.email='test@example.test' -c commit.gpgsign=false commit -qm design",
          },
          { tool: "mcp__sukuna__report_design", input: { number: 42, policy: "設計", checks: [] } },
          { end: "success" },
        ],
      },
      { match: "^設計書の PR", steps: [{ end: "success" }] },
    ],
  });
  await confirm(42, "在庫");
  await expect.poll(async () => (await snapshot()).state).toBe("design_review");
  const id = stageConversation("design")!.id;
  f.db.insert(settings).values({ key: "flow_paused", value: true }).run();
  expect((await f.runner.design.approve("i", submission().headCommit)).isOk()).toBe(true);
  await f.runner.design.drain();
  expect((await snapshot()).state).toBe("design");
  expect(messages(id)).toHaveLength(1);
  expect(f.events("i").some((event) => event.type === "design_pr_created")).toBe(true);
  f.db.update(settings).set({ value: false }).where(eq(settings.key, "flow_paused")).run();
  expect((await f.link.forward("POST", "/flow/notify", { issue_id: "i" })).status).toBe(200);
  await expect.poll(async () => (await snapshot()).state).toBe("ready");
  expect(messages(id).at(-1)?.payload).toMatchObject({
    origin: "flow",
    text: expect.stringContaining("https://github.com/sukuna-test/fixture/pull/1 は承認済みです。"),
  });
  expect(f.events("i").findLast((event) => event.type === "ai_started")?.payload).toEqual({
    kind: "design",
    conversationId: id,
    reason: "design_pr_merge",
  });
  expect(f.events("i").findLast((event) => event.type === "design_reflected")).toMatchObject({
    type: "design_reflected",
    payload: { mode: "pr", commit: "a".repeat(40) },
  });
});

it("設計承認の結果を記録する前に再起動すると同じ承認の反映をやり直す", async () => {
  prepareGit();
  await confirm(42, "在庫");
  await expect.poll(async () => (await snapshot()).state).toBe("design_review");
  const last = f.events("i").at(-1)!;
  f.db
    .insert(issueEvents)
    .values({
      issueId: "i",
      seq: last.seq + 1,
      type: "design_approved",
      createdAt: last.createdAt,
      payload: { headCommit: submission().headCommit, mode: "none" },
    })
    .run();
  await f.restart();
  await expect
    .poll(() => f.db.select().from(issues).where(eq(issues.id, "i")).get()?.state)
    .toBe("ready");
  expect(f.events("i").filter((event) => event.type === "design_approved")).toHaveLength(1);
  expect(f.events("i").findLast((event) => event.type === "design_reflected")).toMatchObject({
    type: "design_reflected",
    payload: { mode: "none" },
  });
});

it("設計の worktree の再試行が失敗しても発言を保存せず、再開は作り直してから最初の指示を送る", async () => {
  await confirm(42, "在庫");
  await expect.poll(async () => (await snapshot()).stopReason).toBe("failed");
  const id = stageConversation("design")!.id;
  const response = await send(id, "後から手動で続ける");
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: { code: "worktree_failed" } });
  expect(messages(id)).toHaveLength(0);
  expect(f.events("i").findLast((event) => event.type === "state_changed")?.payload).toMatchObject({
    from: "design",
    to: "stopped",
    cause: "worktree_failed",
  });
  prepareGit(false, f.home);
  expect((await f.link.forward("POST", `/conversations/${id}/resume`, {})).status).toBe(200);
  expect(messages(id)).toMatchObject([
    {
      payload: { origin: "flow", text: expect.stringMatching(/^#42「在庫」を設計してください。/) },
    },
  ]);
});

it("設計の worktree の再試行でストックを最初の指示と一緒に届ける", async () => {
  await confirm(42, "在庫");
  await expect.poll(async () => (await snapshot()).stopReason).toBe("failed");
  const id = stageConversation("design")!.id;
  f.db
    .insert(stockItems)
    .values({
      id: "stock",
      conversationId: id,
      kind: "instruction",
      text: "更新方法を確認",
      quote: JSON.stringify({ kind: "terminal", mode: "line", text: "予約時間" }),
      state: "stocked",
    })
    .run();
  prepareGit(false, f.home);
  const response = await f.link.forward("POST", `/conversations/${id}/stock/send`, {
    kinds: "instructions",
    stockIds: ["stock"],
  });
  expect(response.status, JSON.stringify(await response.json())).toBe(200);
  expect(messages(id)).toMatchObject([
    {
      payload: {
        origin: "developer",
        text: expect.stringMatching(/^#42「在庫」を設計してください。[\s\S]*更新方法を確認/),
      },
    },
  ]);
  expect(f.db.select().from(stockItems).get()).toMatchObject({
    state: "sent",
    sentSeq: messages(id)[0]?.seq,
  });
});

it("設計の worktree の再試行で届く前の指示を最初の指示のあとに届ける", async () => {
  await confirm(42, "在庫");
  await expect.poll(async () => (await snapshot()).stopReason).toBe("failed");
  const id = stageConversation("design")!.id;
  f.runner.runtime.store.enqueue({
    id: "queued",
    conversationId: id,
    text: "更新時間を見直す",
    images: [],
    position: 1,
    clientId: null,
    createdAt: 1000000,
  });
  prepareGit(false, f.home);
  const response = await f.link.forward("POST", `/conversations/${id}/queue/deliver`, {});
  expect(response.status).toBe(200);
  expect(messages(id)).toMatchObject([
    {
      payload: {
        origin: "developer",
        text: expect.stringMatching(/^#42「在庫」を設計してください。[\s\S]*\n\n更新時間を見直す$/),
        queued_ids: ["queued"],
      },
    },
  ]);
  expect(f.runner.runtime.store.queue(id)).toHaveLength(0);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}
function addQueued(id: string, text: string) {
  f.runner.runtime.store.enqueue({
    id: "queued",
    conversationId: id,
    text,
    images: [],
    position: 1,
    clientId: null,
    createdAt: 1_000_000,
  });
}
const addStock = (id: string) =>
  f.db
    .insert(stockItems)
    .values({
      id: "review-stock",
      conversationId: id,
      kind: "instruction",
      text: "新しい在庫の指示",
      quote: JSON.stringify({ kind: "terminal", mode: "line", text: "予約時間" }),
      state: "stocked",
    })
    .run();

it.each(["message", "stock", "queue"] as const)(
  "再試行で先に預けた指示を新しい指示より前に届ける %s",
  async (mode) => {
    await confirm(42, "在庫");
    await expect.poll(async () => (await snapshot()).stopReason).toBe("failed");
    const id = stageConversation("design")!.id;
    addQueued(id, "先に預けた在庫の指示");
    prepareGit(false, f.home);
    if (mode === "stock") addStock(id);
    const response =
      mode === "message"
        ? await send(id, "新しい在庫の指示")
        : mode === "stock"
          ? await f.link.forward("POST", `/conversations/${id}/stock/send`, {
              kinds: "instructions",
            })
          : await f.link.forward("POST", `/conversations/${id}/queue/deliver`, {});
    expect(response.status).toBe(200);
    const text = messages(id).at(-1)!.payload.text;
    const first = text.indexOf("#42「在庫」を設計してください。");
    const old = text.indexOf("先に預けた在庫の指示");
    const fresh = text.indexOf("新しい在庫の指示");
    expect(f.agent.sent.some((message) => message.text === text)).toBe(true);
    expect(first).toBe(0);
    expect(old).toBeGreaterThan(first);
    if (mode !== "queue") expect(fresh).toBeGreaterThan(old);
  },
);

it.each([
  [false, false],
  [false, true],
  [true, true],
] as const)(
  "Git の応答時に期限を再検査する Gitが成功=%s 期限切れ=%s",
  async (validGit, expired) => {
    await confirm(42, "在庫");
    await expect.poll(async () => (await snapshot()).stopReason).toBe("failed");
    const id = stageConversation("design")!.id;
    if (validGit) prepareGit(false, f.home);
    f.interceptGit((args) => {
      if (args[0] === "worktree" && args[1] === (validGit ? "add" : "list"))
        f.setTime(expired ? 1_011_000 : 1_009_000);
    });
    const probe = new RunnerLink({
      socket: join(f.home, "runner.sock"),
      log: () => {},
      notice: () => {},
      connection: () => {},
      now: () => 1_000_000,
    });
    const before = {
      conversation: f.runner.runtime.store.get(id),
      events: f.runner.runtime.store.events(id),
      issue: f.events("i"),
    };
    const response = (await probe.call("POST", `/conversations/${id}/resume`, {}))._unsafeUnwrap();
    const after = {
      conversation: f.runner.runtime.store.get(id),
      events: f.runner.runtime.store.events(id),
      issue: f.events("i"),
    };
    if (expired) {
      expect([
        response.status,
        after.events.length,
        after.issue.length,
        after.conversation?.worktreeId,
      ]).toEqual([503, before.events.length, before.issue.length, before.conversation?.worktreeId]);
      if (validGit) {
        f.interceptGit(undefined);
        expect((await f.link.forward("POST", `/conversations/${id}/resume`, {})).status).toBe(200);
        expect(git(f.runner.runtime.store.get(id)!.cwd, "branch", "--show-current")).toBe(
          "sukuna/design-42",
        );
        expect(
          git(f.home, "worktree", "list", "--porcelain").match(
            /branch refs\/heads\/sukuna\/design-42/g,
          ),
        ).toHaveLength(1);
      }
    } else {
      expect([
        response.status,
        after.events.length,
        after.issue.length,
        after.conversation?.worktreeId,
      ]).toEqual([
        500,
        before.events.length + 1,
        before.issue.length + 1,
        before.conversation?.worktreeId,
      ]);
    }
  },
);

it("再試行中に最後の指示が取り消されたら AI を開かない", async () => {
  await confirm(42, "在庫");
  await expect.poll(async () => (await snapshot()).stopReason).toBe("failed");
  const id = stageConversation("design")!.id;
  addQueued(id, "途中で取り消す");
  prepareGit(false, f.home);
  const entered = deferred();
  const proceed = deferred();
  f.interceptGit(async (args) => {
    if (args[0] === "worktree" && args[1] === "add") {
      entered.resolve();
      await proceed.promise;
    }
  });
  const server = createApp({
    build: "review",
    identity: {
      login: "test@example.com",
      devIdentity: "1",
      tailscale: createTailscaleFake().api,
      clock: createClockFake(),
    },
    conversations: createConversationDependencies({
      sqlite: f.opened.sqlite,
      home: f.home,
      runner: f.link,
      now: () => 1_000_000,
      id: () => "unused",
      changed: () => {},
      reopened: () => {},
    }),
  });
  const pending = f.link.forward("POST", `/conversations/${id}/queue/deliver`, {});
  await entered.promise;
  let cancelled: Response;
  try {
    cancelled = await server.request(
      `/api/conversations/${id}/queue/queued`,
      { method: "DELETE" },
      incomingWith("127.0.0.1", 1),
    );
  } finally {
    proceed.resolve();
  }
  const result = await pending;
  expect(cancelled.status).toBe(204);
  const current = await snapshot();
  expect(result.status).toBe(400);
  expect(messages(id)).toHaveLength(0);
  expect(current.stopReason).toBe("failed");
});

it("利用枠が戻っても担当外になった精査の会話を再開しない", async () => {
  prepareGit();
  f.runner.runtime.options.agent = new ScriptedAgent({
    rules: [
      {
        match: "^#42「在庫」を精査",
        steps: [
          {
            tool: "mcp__sukuna__report_triage",
            input: { number: 42, result: "design", kind: "bug", summary: "設計へ" },
          },
          { rate_limit: { status: "rejected", resetsAt: 1020 } },
          { end: "error_during_execution" },
        ],
      },
    ],
    fallback: [{ hold: true }],
  });
  await confirm(42, "在庫");
  await expect.poll(() => stageConversation("design")?.runState).toBe("working");
  expect((await snapshot()).state).toBe("design");
  expect(stageConversation("triage")?.runState).toBe("usage_limited");
  await f.advanceTo(1_080_000);
  const actual = {
    triage: stageConversation("triage")?.runState,
    design: stageConversation("design")?.runState,
    resumed: f.runner.runtime.store
      .events(stageConversation("triage")!.id)
      .filter((event) => event.type === "resumed").length,
  };
  expect(actual).toEqual({ triage: "usage_limited", design: "working", resumed: 0 });
});

it("依存が戻っても先に開発者が止めた会話を再開しない", async () => {
  await confirm(49, "再起動");
  await expect.poll(() => stageConversation("triage")?.runState).toBe("working");
  const id = stageConversation("triage")!.id;
  f.setTime(1_000_500);
  expect((await f.link.forward("POST", `/conversations/${id}/stop`, {})).status).toBe(200);
  await expect.poll(() => stageConversation("triage")?.stopReason).toBe("user");
  expect((await snapshot()).state).toBe("triage");
  f.addIssue("dependency", 1, { state: "ready" });
  f.depend("i", "dependency");
  f.setTime(1_001_000);
  expect((await f.request("/api/issues/dependency/withdraw", "POST")).status).toBe(200);
  expect((await snapshot()).stopReason).toBe("dependency_withdrawn");
  f.setTime(1_002_000);
  expect((await f.request("/api/issues/dependency/reopen", "POST")).status).toBe(200);
  await expect.poll(async () => (await snapshot()).state).toBe("triage");
  expect((await f.link.forward("POST", "/flow/notify", { issue_id: "i" })).status).toBe(200);
  const actual = {
    runState: stageConversation("triage")?.runState,
    inputs: messages(id).length,
    last: messages(id).at(-1)?.payload.text,
  };
  expect(actual).toMatchObject({ runState: "stopped", inputs: 1 });
});

it("手動で再開した番も報告が無ければ催促を送る", async () => {
  f.runner.runtime.options.agent = new ScriptedAgent({
    rules: [
      { match: "^#45「失敗」", steps: [{ end: "error_during_execution" }] },
      { match: "^中断したところから", steps: [{ end: "success" }] },
    ],
    fallback: [{ hold: true }],
  });
  await confirm(45, "失敗");
  await expect.poll(async () => (await snapshot()).stopReason).toBe("failed");
  const id = stageConversation("triage")!.id;
  const response = await f.link.forward("POST", `/conversations/${id}/resume`, {});
  expect(response.status).toBe(200);
  await expect.poll(async () => (await snapshot()).state).toBe("triage");
  await expect
    .poll(() => f.events("i").filter((event) => event.type === "report_nudged"))
    .toHaveLength(1);
  expect(messages(id).map((message) => message.payload.origin)).toEqual(["flow", "resume", "flow"]);
});

it("手で依頼した設計 PR の merge を一時停止解除後に再送しない", async () => {
  prepareGit(true);
  f.runner.runtime.options.agent = new ScriptedAgent({
    rules: [
      {
        match: "^#42.*精査",
        steps: [
          {
            tool: "mcp__sukuna__report_triage",
            input: { number: 42, result: "design", kind: "enhancement", summary: "設計へ" },
          },
          { end: "success" },
        ],
      },
      {
        match: "^#42.*設計",
        steps: [
          {
            shell:
              "printf '設計\\n' > design.md && git add design.md && git -c user.name='Test' -c user.email='test@example.test' -c commit.gpgsign=false commit -qm design",
          },
          { tool: "mcp__sukuna__report_design", input: { number: 42, policy: "設計", checks: [] } },
          { end: "success" },
        ],
      },
      { match: "^設計書の PR", steps: [{ end: "success" }] },
    ],
  });
  await confirm(42, "在庫");
  await expect.poll(async () => (await snapshot()).state).toBe("design_review");
  const id = stageConversation("design")!.id;
  f.setTime(1_001_000);
  f.db.insert(settings).values({ key: "flow_paused", value: true }).run();
  expect((await f.runner.design.approve("i", submission().headCommit)).isOk()).toBe(true);
  await f.runner.design.drain();
  expect((await snapshot()).state).toBe("design");
  expect(messages(id)).toHaveLength(1);
  expect(f.events("i").some((event) => event.type === "design_pr_created")).toBe(true);
  f.setTime(1_002_000);
  const manual = await send(id, "承認された設計書の PR を merge してください");
  expect(manual.status).toBe(200);
  await expect.poll(() => stageConversation("design")?.runState).toBe("idle");
  expect(messages(id).map((event) => event.payload.origin)).toEqual(["flow", "developer"]);
  f.db.update(settings).set({ value: false }).where(eq(settings.key, "flow_paused")).run();
  expect((await f.link.forward("POST", "/flow/notify", { issue_id: "i" })).status).toBe(200);

  await expect
    .poll(
      () => ({
        state: f.db.select().from(issues).where(eq(issues.id, "i")).get()?.state,
        origins: messages(id).map((event) => event.payload.origin),
      }),
      { timeout: 600 },
    )
    .toEqual({ state: "ready", origins: ["flow", "developer"] });
});

it("精査の番が終わるまで設計の会話を手動で始められない", async () => {
  prepareGit();
  await confirm(42, "在庫");
  await expect.poll(async () => (await snapshot()).state).toBe("design_review");
  await expect.poll(() => stageConversation("design")?.runState).toBe("idle");
  const designId = stageConversation("design")!.id;

  f.setTime(1_001_000);
  expect((await f.request("/api/issues/i/withdraw", "POST")).status).toBe(200);
  await f.runner.design.drain();
  expect((await snapshot()).state).toBe("withdrawn");
  const triageId = stageConversation("triage")!.id;
  expect((await f.runner.runtime.release(triageId)).isOk()).toBe(true);
  expect((await f.runner.runtime.release(designId)).isOk()).toBe(true);
  f.runner.runtime.options.agent = new ScriptedAgent({
    rules: [
      {
        match: "^この issue は再開されました。",
        steps: [
          {
            tool: "mcp__sukuna__report_triage",
            input: { number: 42, result: "design", kind: "bug", summary: "設計へ" },
          },
          { hold: true },
        ],
      },
    ],
    fallback: [{ hold: true }],
  });
  f.setTime(1_002_000);
  expect((await f.request("/api/issues/i/reopen", "POST")).status).toBe(200);
  await expect.poll(async () => (await snapshot()).state).toBe("design");
  expect(stageConversation("triage")?.runState).toBe("working");
  const manual = await send(designId, "設計を進めてください");
  const actual = {
    status: manual.status,
    triage: stageConversation("triage")?.runState,
    design: stageConversation("design")?.runState,
  };
  expect(actual).toEqual({ status: 409, triage: "working", design: "idle" });
});

async function reviewDesign(usesGithub = false) {
  prepareGit(usesGithub);
  f.runner.runtime.options.agent = new ScriptedAgent({
    rules: [
      {
        match: "^#42.*精査",
        steps: [
          {
            tool: "mcp__sukuna__report_triage",
            input: { number: 42, result: "design", kind: "enhancement", summary: "設計へ" },
          },
          { end: "success" },
        ],
      },
      {
        match: "^#42.*設計",
        steps: [
          {
            shell:
              "printf '設計\\n' > design.md && git add design.md && git -c user.name='Test' -c user.email='test@example.test' -c commit.gpgsign=false commit -qm design",
          },
          { tool: "mcp__sukuna__report_design", input: { number: 42, policy: "設計", checks: [] } },
          { end: "success" },
        ],
      },
    ],
  });
  await confirm(42, "在庫");
  await expect.poll(async () => (await snapshot()).state).toBe("design_review");
}

it("手元に反映済みの設計を再起動後に重ねてコミットしない", async () => {
  await reviewDesign();
  const last = f.events("i").at(-1)!;
  const { headCommit } = submission();
  const path = join(f.home, "repo");
  expect(git(path, "rev-parse", "main")).not.toBe(headCommit);
  f.db
    .insert(issueEvents)
    .values({
      issueId: "i",
      seq: last.seq + 1,
      type: "design_approved",
      createdAt: last.createdAt,
      payload: { headCommit, mode: "direct" },
    })
    .run();
  git(path, "merge", "--ff-only", headCommit);
  expect(git(path, "rev-parse", "main")).toBe(headCommit);
  expect(f.events("i").some(({ type }) => type === "design_reflected")).toBe(false);
  await f.restart();
  await expect
    .poll(() => f.db.select().from(issues).where(eq(issues.id, "i")).get()?.state)
    .toBe("ready");
  const after = git(path, "rev-parse", "main");
  expect(git(path, "diff", "--name-only", headCommit, after)).toBe("");
  expect(after).toBe(headCommit);
});

function recoveryPrs(url: string, branch: string, headCommit: string) {
  const matching = {
    url,
    state: "OPEN",
    baseRefName: "main",
    headRefName: branch,
    headRefOid: headCommit,
    isCrossRepository: false,
    headRepository: { nameWithOwner: "sukuna-test/fixture" },
  };
  return [
    { ...matching, url: "https://github.com/other/fixture/pull/2" },
    { ...matching, url: url.replace(/1$/, "3"), baseRefName: "dev" },
    { ...matching, url: url.replace(/1$/, "4"), headRefName: "design/another" },
    { ...matching, url: url.replace(/1$/, "5"), headRefOid: "b".repeat(40) },
    { ...matching, url: url.replace(/1$/, "6"), isCrossRepository: true },
    {
      ...matching,
      url: url.replace(/1$/, "7"),
      headRepository: { nameWithOwner: "other/fixture" },
    },
    matching,
  ];
}
it("既定ブランチと承認 SHA が一致する作成済みの設計 PR を復旧する", async () => {
  await reviewDesign(true);
  const last = f.events("i").at(-1)!;
  const { headCommit } = submission();
  const path = join(f.home, "repo");
  const branch = "sukuna/design-42";
  const url = "https://github.com/sukuna-test/fixture/pull/1";
  expect(f.events("i").some(({ type }) => type === "design_pr_created")).toBe(false);
  f.db
    .insert(issueEvents)
    .values({
      issueId: "i",
      seq: last.seq + 1,
      type: "design_approved",
      createdAt: last.createdAt,
      payload: { headCommit, mode: "pr", prTarget: recoveryTarget() },
    })
    .run();
  git(path, "push", "origin", branch);
  expect(git(path, "ls-remote", "origin", `refs/heads/${branch}`)).toContain(headCommit);
  writeFileSync(
    join(f.home, "gh.json"),
    JSON.stringify({
      responses: [
        {
          match: "^pr create ",
          stdout: "",
          stderr: "a pull request for branch sukuna/design-42 into branch main already exists",
          exit_code: 1,
        },
        {
          match: "^repo view ",
          stdout: JSON.stringify({
            nameWithOwner: "sukuna-test/fixture",
            url: "https://github.com/sukuna-test/fixture",
          }),
          exit_code: 0,
        },
        {
          match: "^pr list ",
          stdout: JSON.stringify(recoveryPrs(url, branch, headCommit)),
          exit_code: 0,
        },
      ],
      fallback: { exit_code: 1, stdout: "", stderr: "Unexpected command in fixture" },
    }),
  );
  await f.restart();
  await expect
    .poll(() =>
      f
        .events("i")
        .find(({ type }) => type === "design_pr_created" || type === "design_reflect_failed"),
    )
    .toMatchObject({ type: "design_pr_created", payload: { prUrl: url } });
  expect(f.runner.gh).toBeInstanceOf(ScriptedGh);
  const calls = (f.runner.gh as ScriptedGh).calls;
  expect(calls.map(({ args }) => args.slice(0, 2))).toEqual([["pr", "list"]]);
  expect(calls[0]?.args).toContain("github.com/sukuna-test/fixture");
});

it("リモートに反映済みの設計を再起動後に重ねて push しない", async () => {
  await reviewDesign(true);
  const last = f.events("i").at(-1)!;
  const { headCommit } = submission();
  const path = join(f.home, "repo");
  f.db.update(projects).set({ designMergeMode: "direct" }).where(eq(projects.id, "p")).run();
  expect(git(path, "ls-remote", "origin", "refs/heads/main")).not.toContain(headCommit);
  f.db
    .insert(issueEvents)
    .values({
      issueId: "i",
      seq: last.seq + 1,
      type: "design_approved",
      createdAt: last.createdAt,
      payload: { headCommit, mode: "direct" },
    })
    .run();
  git(path, "push", "origin", `${headCommit}:refs/heads/main`);
  expect(git(path, "ls-remote", "origin", "refs/heads/main")).toContain(headCommit);
  expect(f.events("i").some(({ type }) => type === "design_reflected")).toBe(false);
  await f.restart();
  await expect
    .poll(() => f.db.select().from(issues).where(eq(issues.id, "i")).get()?.state)
    .toBe("ready");
  const after = git(path, "ls-remote", "origin", "refs/heads/main").split("\t")[0]!;
  git(path, "fetch", "origin", "main");
  expect(git(path, "diff", "--name-only", headCommit, after)).toBe("");
  expect(after).toBe(headCommit);
});

it.each(["message", "resume"] as const)(
  "依存先が取り下げられたときの worktree 再試行で停止理由を更新する %s",
  async (mode) => {
    await confirm(42, "在庫");
    await expect.poll(async () => (await snapshot()).stopReason).toBe("failed");
    expect(f.events("i").findLast(({ type }) => type === "state_changed")?.payload).toMatchObject({
      cause: "worktree_failed",
    });
    const id = stageConversation("design")!.id;
    const path = f.home;
    prepareGit(false, path);
    f.addIssue("dependency", 1, { state: "draft" });
    expect((await f.request("/api/issues/i", "PATCH", { dependsOn: [1] })).status).toBe(200);
    expect((await f.request("/api/issues/dependency/withdraw", "POST")).status).toBe(200);
    expect((await snapshot()).stopReason).toBe("failed");
    expect((await snapshot()).dependsOn).toMatchObject([{ id: "dependency", state: "withdrawn" }]);
    const response =
      mode === "message"
        ? await send(id, "仕様を確認してください")
        : await f.link.forward("POST", `/conversations/${id}/resume`, {});
    expect(git(path, "worktree", "list", "--porcelain")).toContain(
      "branch refs/heads/sukuna/design-42",
    );
    expect(stageConversation("design")!.worktreeId).toBeNull();
    expect(response.status).toBe(409);
    expect({
      response: response.status,
      body: await response.json(),
      reason: (await snapshot()).stopReason,
      change: f.events("i").findLast(({ type }) => type === "state_changed")?.payload,
    }).toMatchObject({
      reason: "dependency_withdrawn",
      change: { from: "design", to: "stopped", cause: "dependency_withdrawn" },
    });
    expect(messages(id)).toHaveLength(0);
  },
);

it("worktree の準備中に依存先が取り下げられたら、発言を残さず依存の解消を待つ", async () => {
  await confirm(42, "在庫");
  await expect.poll(async () => (await snapshot()).stopReason).toBe("failed");
  const id = stageConversation("design")!.id;
  prepareGit(false, f.home);
  f.addIssue("dependency", 1, { state: "draft" });
  expect((await f.request("/api/issues/i", "PATCH", { dependsOn: [1] })).status).toBe(200);
  f.interceptGit(async (args) => {
    if (args[0] !== "worktree" || args[1] !== "add") return;
    f.interceptGit(undefined);
    expect((await f.request("/api/issues/dependency/withdraw", "POST")).status).toBe(200);
  });
  expect((await send(id, "仕様を確認してください")).status).toBe(409);
  expect((await snapshot()).stopReason).toBe("dependency_withdrawn");
  expect(messages(id)).toHaveLength(0);
  expect(stageConversation("design")!.worktreeId).toBeNull();
  f.setTime(1_001_000);
  expect((await f.request("/api/issues/dependency/reopen", "POST")).status).toBe(200);
  await expect.poll(async () => (await snapshot()).state).toBe("design_review");
  expect(stageConversation("design")?.id).toBe(id);
  expect(git(stageConversation("design")!.cwd, "branch", "--show-current")).toBe(
    "sukuna/design-42",
  );
});

function recordApproval(mode: "direct" | "pr", payload = {}) {
  const { headCommit } = submission();
  f.db
    .insert(issueEvents)
    .values({
      issueId: "i",
      seq: f.events("i").at(-1)!.seq + 1,
      type: "design_approved",
      createdAt: 1_000_000,
      payload: { headCommit, mode, ...payload },
    })
    .run();
  return headCommit;
}

it.each([false, true])(
  "承認 SHA の後で設計書が更新されても反映済みの設計を復旧する remote=%s",
  async (remote) => {
    await reviewDesign(remote);
    const approved = recordApproval("direct");
    const path = join(f.home, "repo");
    git(path, "merge", "--ff-only", approved);
    writeFileSync(join(path, "design.md"), "利用者が後から更新した設計\n");
    git(path, "add", "design.md");
    git(path, "commit", "-qm", "update design");
    const tip = git(path, "rev-parse", "main");
    if (remote) git(path, "push", "origin", "main");
    await f.restart();
    await expect
      .poll(() => f.db.select().from(issues).where(eq(issues.id, "i")).get()?.state)
      .toBe("ready");
    expect(
      f.events("i").findLast(({ type }) => type === "design_reflected")?.payload,
    ).toMatchObject({ commit: tip });
    expect(git(path, "show", "main:design.md")).toBe("利用者が後から更新した設計");
    if (remote) expect(git(path, "ls-remote", "origin", "refs/heads/main")).toContain(tip);
  },
);

it("一時停止中も merge 済みの設計 PR を反映済みに復旧する", async () => {
  await reviewDesign(true);
  const approved = recordApproval("pr", { prTarget: recoveryTarget() });
  const path = join(f.home, "repo");
  const branch = "sukuna/design-42";
  const url = "https://github.com/sukuna-test/fixture/pull/1";
  git(path, "push", "origin", `${approved}:refs/heads/main`);
  f.db.insert(settings).values({ key: "flow_paused", value: true }).run();
  writeFileSync(
    join(f.home, "gh.json"),
    JSON.stringify({
      responses: [
        {
          match: "^repo view ",
          stdout: JSON.stringify({
            nameWithOwner: "sukuna-test/fixture",
            url: "https://github.com/sukuna-test/fixture",
          }),
          exit_code: 0,
        },
        {
          match: "^pr list ",
          stdout: JSON.stringify([
            {
              url,
              state: "MERGED",
              baseRefName: "main",
              headRefName: branch,
              headRefOid: approved,
              isCrossRepository: false,
              headRepository: { nameWithOwner: "sukuna-test/fixture" },
            },
          ]),
          exit_code: 0,
        },
        {
          match: "^pr view ",
          stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: approved } }),
          exit_code: 0,
        },
      ],
      fallback: { exit_code: 1, stdout: "", stderr: "Unexpected fixture command" },
    }),
  );
  await f.restart();
  await expect
    .poll(() => f.db.select().from(issues).where(eq(issues.id, "i")).get()?.state)
    .toBe("ready");
  expect(f.events("i").findLast(({ type }) => type === "design_pr_created")?.payload).toMatchObject(
    { prUrl: url },
  );
  expect(f.events("i").findLast(({ type }) => type === "design_reflected")?.payload).toEqual({
    mode: "pr",
    commit: approved,
    prUrl: url,
  });
  expect(f.agent.sent).toEqual([]);
});

it("初回の設計 PR は gh の既定と異なる origin を明示して作る", async () => {
  await reviewDesign(true);
  const approved = submission().headCommit;
  const path = join(f.home, "repo");
  git(f.home, "init", "--bare", "-q", "-b", "main", join(f.home, "upstream.git"));
  git(path, "remote", "add", "upstream", join(f.home, "upstream.git"));
  git(path, "config", "remote.upstream.gh-resolved", "base");
  writeFileSync(
    join(f.home, "gh.json"),
    JSON.stringify({
      responses: [
        {
          match: "^repo view ",
          stdout: JSON.stringify({
            nameWithOwner: "sukuna-test/fixture",
            url: "https://github.com/sukuna-test/fixture",
          }),
          exit_code: 0,
        },
        {
          match: "^pr create --repo github.com/sukuna-test/fixture ",
          stdout: "https://github.com/sukuna-test/fixture/pull/1\n",
          exit_code: 0,
        },
        {
          match: "^pr create ",
          stdout: "https://github.com/elsewhere/fixture/pull/2\n",
          exit_code: 0,
        },
        {
          match: "^pr view ",
          stdout: JSON.stringify({ state: "OPEN", mergeCommit: null }),
          exit_code: 0,
        },
      ],
      fallback: { exit_code: 1, stdout: "", stderr: "Unexpected fixture command" },
    }),
  );
  await f.restart();
  expect((await f.runner.design.approve("i", approved)).isOk()).toBe(true);
  await f.runner.design.drain();
  expect(f.events("i").findLast(({ type }) => type === "design_pr_created")?.payload).toMatchObject(
    { prUrl: "https://github.com/sukuna-test/fixture/pull/1" },
  );
  expect(git(path, "ls-remote", "origin", "refs/heads/sukuna/design-42")).toContain(approved);
  expect(git(path, "ls-remote", "upstream", "refs/heads/sukuna/design-42")).toBe("");
});

it.each([false, true])(
  "保存した合成コミットの反映後に入った変更を復旧で保つ remote=%s",
  async (remote) => {
    await reviewDesign(remote);
    const path = join(f.home, "repo");
    f.db.update(projects).set({ designMergeMode: "direct" }).where(eq(projects.id, "p")).run();
    writeFileSync(join(path, "guide.md"), "既定ブランチの変更\n");
    git(path, "add", "guide.md");
    git(path, "commit", "-qm", "advance default branch");
    if (remote) git(path, "push", "origin", "main");
    f.opened.sqlite.exec(`CREATE TRIGGER refuse_result BEFORE INSERT ON issue_events
    WHEN NEW.type = 'design_reflected' BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
    const { headCommit } = submission();
    expect((await f.runner.design.approve("i", headCommit)).isOk()).toBe(true);
    await f.runner.design.drain();
    expect((await snapshot()).state).toBe("design_review");
    expect(f.events("i").findLast(({ type }) => type === "design_reflect_failed")).toBeTruthy();
    if (remote) git(path, "pull", "--ff-only", "origin", "main");
    const applied = git(path, "rev-parse", "main");
    expect(git(path, "show", "main:design.md")).toBe("設計");
    expect(() => git(path, "merge-base", "--is-ancestor", headCommit, applied)).toThrow();
    expect(
      f.events("i").findLast(({ type }) => type === "design_reflection_prepared")?.payload,
    ).toMatchObject({ targetRef: "refs/heads/main", commit: applied });

    f.opened.sqlite.exec("DROP TRIGGER refuse_result");
    f.db
      .delete(issueEvents)
      .where(and(eq(issueEvents.issueId, "i"), eq(issueEvents.type, "design_reflect_failed")))
      .run();
    writeFileSync(join(path, "design.md"), "反映後の更新\n");
    git(path, "add", "design.md");
    git(path, "commit", "-qm", "design follow-up");
    const tip = git(path, "rev-parse", "main");
    if (remote) git(path, "push", "origin", "main");
    await f.restart();
    await expect
      .poll(() => f.db.select().from(issues).where(eq(issues.id, "i")).get()?.state)
      .toBe("ready");
    expect(
      f.events("i").findLast(({ type }) => type === "design_reflected")?.payload,
    ).toMatchObject({ commit: tip });
    expect(git(path, "show", "main:design.md")).toBe("反映後の更新");
    if (remote) expect(git(path, "ls-remote", "origin", "refs/heads/main")).toContain(tip);
  },
);

it("承認した版と同じ内容でも由来を確認できないコミットを反映済みにしない", async () => {
  await reviewDesign();
  const approved = recordApproval("direct");
  const path = join(f.home, "repo");
  writeFileSync(join(path, "design.md"), "設計\n");
  git(path, "add", "design.md");
  git(path, "commit", "-qm", "written independently");
  const tip = git(path, "rev-parse", "main");
  expect(git(path, "diff", "--name-only", "main", approved)).toBe("");
  expect(() => git(path, "merge-base", "--is-ancestor", approved, tip)).toThrow();
  await f.restart();
  await expect
    .poll(() => f.events("i").findLast(({ type }) => type === "design_reflect_failed")?.payload)
    .toMatchObject({ message: expect.stringContaining("承認した版の反映を確認できない") });
  expect(git(path, "rev-parse", "main")).toBe(tip);
});

function recoveryTarget() {
  return { repository: "github.com/sukuna-test/fixture", base: "main" };
}

function updateOrigin() {
  const path = join(f.home, "repo");
  const other = join(f.home, "other.git");
  git(f.home, "init", "--bare", "-q", "-b", "other", other);
  git(path, "remote", "set-url", "origin", other);
  f.db.update(projects).set({ defaultBranch: "other" }).where(eq(projects.id, "p")).run();
  return { path, other };
}

it("設定が変わっても承認に保存した origin と既定ブランチで merge 済みの PR を確かめる", async () => {
  await reviewDesign(true);
  const target = recoveryTarget();
  const approved = recordApproval("pr", { prTarget: target });
  const { path } = updateOrigin();
  const url = "https://github.com/sukuna-test/fixture/pull/1";
  const row = { ...recoveryPrs(url, "sukuna/design-42", approved).at(-1)!, state: "MERGED" };
  writeFileSync(
    join(f.home, "gh.json"),
    JSON.stringify({
      responses: [
        {
          match: "^pr list --repo github.com/sukuna-test/fixture --state all --base main ",
          stdout: JSON.stringify([row]),
          exit_code: 0,
        },
        {
          match: "^pr view ",
          stdout: JSON.stringify({ ...row, mergeCommit: { oid: approved } }),
          exit_code: 0,
        },
      ],
      fallback: { exit_code: 1, stdout: "", stderr: "Unexpected fixture command" },
    }),
  );
  await f.restart();
  await expect
    .poll(() => f.db.select().from(issues).where(eq(issues.id, "i")).get()?.state)
    .toBe("ready");
  expect(f.events("i").findLast(({ type }) => type === "design_reflected")?.payload).toEqual({
    mode: "pr",
    commit: approved,
    prUrl: url,
  });
  expect((f.runner.gh as ScriptedGh).calls.map(({ args }) => args.slice(0, 2))).toEqual([
    ["pr", "list"],
    ["pr", "view"],
  ]);
  expect(git(path, "ls-remote", "origin")).toBe("");
});

it("承認の作成先で PR が見つからなくても変更後の origin に push しない", async () => {
  await reviewDesign(true);
  recordApproval("pr", { prTarget: recoveryTarget() });
  const { path } = updateOrigin();
  writeFileSync(
    join(f.home, "gh.json"),
    JSON.stringify({
      responses: [
        {
          match: "^pr list --repo github.com/sukuna-test/fixture --state all --base main ",
          stdout: "[]",
          exit_code: 0,
        },
        {
          match: "^repo view ",
          stdout: JSON.stringify({
            nameWithOwner: "elsewhere/fixture",
            url: "https://github.com/elsewhere/fixture",
          }),
          exit_code: 0,
        },
      ],
      fallback: { exit_code: 1, stdout: "", stderr: "Unexpected fixture command" },
    }),
  );
  await f.restart();
  await expect
    .poll(() => f.events("i").findLast(({ type }) => type === "design_reflect_failed")?.payload)
    .toMatchObject({
      message: expect.stringContaining("PR の作成先が変わりました"),
    });
  expect(git(path, "ls-remote", "origin")).toBe("");
  expect((f.runner.gh as ScriptedGh).calls.map(({ args }) => args.slice(0, 2))).toEqual([
    ["pr", "list"],
    ["repo", "view"],
  ]);
});

it("merge 済みでも確定した SHA が無い設計 PR を反映済みにしない", async () => {
  await reviewDesign(true);
  const target = recoveryTarget();
  const approved = recordApproval("pr", { prTarget: target });
  const url = "https://github.com/sukuna-test/fixture/pull/1";
  const row = { ...recoveryPrs(url, "sukuna/design-42", approved).at(-1)!, state: "MERGED" };
  writeFileSync(
    join(f.home, "gh.json"),
    JSON.stringify({
      responses: [
        { match: "^pr list ", stdout: JSON.stringify([row]), exit_code: 0 },
        { match: "^pr view ", stdout: JSON.stringify({ ...row, mergeCommit: null }), exit_code: 0 },
      ],
      fallback: { exit_code: 1, stdout: "", stderr: "Unexpected fixture command" },
    }),
  );
  await f.restart();
  await expect
    .poll(() => f.events("i").findLast(({ type }) => type === "design_reflect_failed")?.payload)
    .toMatchObject({
      message: "設計書の PR の merge コミットを確認できませんでした",
    });
  expect(f.events("i").some(({ type }) => type === "design_reflected")).toBe(false);
});

it("作成直後の PR が承認と異なる head を持つ場合は作成済みとして記録しない", async () => {
  await reviewDesign(true);
  writeFileSync(
    join(f.home, "gh.json"),
    JSON.stringify({
      responses: [
        {
          match: "^repo view ",
          stdout: JSON.stringify({
            nameWithOwner: "sukuna-test/fixture",
            url: "https://github.com/sukuna-test/fixture",
          }),
          exit_code: 0,
        },
        {
          match: "^pr create --repo github.com/sukuna-test/fixture ",
          stdout: "https://github.com/sukuna-test/fixture/pull/1\n",
          exit_code: 0,
        },
        {
          match: "^pr view ",
          stdout: JSON.stringify({ state: "OPEN", headRefOid: "b".repeat(40) }),
          exit_code: 0,
        },
      ],
      fallback: { exit_code: 1, stdout: "", stderr: "Unexpected fixture command" },
    }),
  );
  await f.restart();
  expect((await f.runner.design.approve("i", submission().headCommit)).isOk()).toBe(true);
  await f.runner.design.drain();
  expect(
    f.events("i").findLast(({ type }) => type === "design_reflect_failed")?.payload,
  ).toMatchObject({ message: "承認した設計の PR を確認できませんでした" });
  expect(f.events("i").some(({ type }) => type === "design_pr_created")).toBe(false);
});

it.each([true, false])(
  "PR 作成直後の merge を一時停止中も照合する merge SHA 確認=%s",
  async (hasMergeCommit) => {
    await reviewDesign(true);
    const { headCommit, branch } = submission();
    const path = join(f.home, "repo");
    const url = "https://github.com/sukuna-test/fixture/pull/1";
    const id = stageConversation("design")!.id;
    const before = messages(id);
    f.db.insert(settings).values({ key: "flow_paused", value: true }).run();
    const gh = f.runner.gh;
    const run = gh.run.bind(gh);
    gh.run = async (args, options) => {
      const result = await run(args, options);
      if (args[0] === "pr" && args[1] === "create" && result.exitCode === 0) {
        expect(git(path, "ls-remote", "origin", `refs/heads/${branch}`)).toContain(headCommit);
        git(path, "push", "origin", `${headCommit}:refs/heads/main`, `:refs/heads/${branch}`);
      }
      if (args[0] === "pr" && args[1] === "view" && args[2] === url && result.exitCode === 0) {
        const found = recoveryPrs(url, branch, headCommit).at(-1)!;
        return {
          ...result,
          stdout: JSON.stringify({
            ...found,
            state: "MERGED",
            mergeCommit: hasMergeCommit ? { oid: headCommit } : null,
          }),
        };
      }
      return result;
    };
    const approved = (
      await f.link.call("POST", "/flow/issues/i/design/approve", { head_commit: headCommit })
    )._unsafeUnwrap();
    expect(approved.status).toBe(202);
    await f.runner.design.drain();
    expect(git(path, "ls-remote", "origin", "refs/heads/main")).toContain(headCommit);
    expect(git(path, "ls-remote", "origin", `refs/heads/${branch}`)).toBe("");
    expect(messages(id)).toEqual(before);
    const issue = await snapshot();
    const events = f.events("i");
    if (hasMergeCommit) {
      expect(issue.state).toBe("ready");
      expect(events.filter(({ type }) => type === "design_pr_created")).toMatchObject([
        { payload: { prUrl: url } },
      ]);
      expect(events.filter(({ type }) => type === "design_reflected")).toMatchObject([
        { payload: { mode: "pr", commit: headCommit, prUrl: url } },
      ]);
    } else {
      expect(issue.state).toBe("design_review");
      expect(events.findLast(({ type }) => type === "design_reflect_failed")?.payload).toEqual({
        message: "設計書の PR の merge コミットを確認できませんでした",
      });
      expect(
        events.filter(({ type }) => type === "design_pr_created" || type === "design_reflected"),
      ).toEqual([]);
    }
  },
);

it("承認先を保存していない承認は origin 変更先に同じ SHA の PR があっても反映済みにしない", async () => {
  await reviewDesign(true);
  const { branch } = submission();
  const approved = recordApproval("pr");
  const path = join(f.home, "repo");
  const original = join(f.home, "remote.git");
  const other = join(f.home, "unrelated.git");
  git(f.home, "init", "--bare", "-q", "-b", "main", other);
  git(path, "remote", "set-url", "origin", other);
  git(path, "push", "origin", `${approved}:refs/heads/main`);
  const url = "https://github.com/elsewhere/fixture/pull/1";
  const row = {
    url,
    state: "MERGED",
    baseRefName: "main",
    headRefName: branch,
    headRefOid: approved,
    isCrossRepository: false,
    headRepository: { nameWithOwner: "elsewhere/fixture" },
  };
  writeFileSync(
    join(f.home, "gh.json"),
    JSON.stringify({
      responses: [
        {
          match: "^repo view ",
          stdout: JSON.stringify({
            nameWithOwner: "elsewhere/fixture",
            url: "https://github.com/elsewhere/fixture",
          }),
          exit_code: 0,
        },
        { match: "^pr list ", stdout: JSON.stringify([row]), exit_code: 0 },
        {
          match: "^pr view ",
          stdout: JSON.stringify({ ...row, mergeCommit: { oid: approved } }),
          exit_code: 0,
        },
      ],
      fallback: { exit_code: 1, stdout: "", stderr: "Unexpected fixture command" },
    }),
  );
  await f.restart();
  await expect
    .poll(() => f.events("i").findLast(({ type }) => type === "design_reflect_failed")?.payload)
    .toMatchObject({ message: expect.stringContaining("同じ版をもう一度承認してください") });
  expect(f.db.select().from(issues).where(eq(issues.id, "i")).get()?.state).toBe("design_review");
  expect((f.runner.gh as ScriptedGh).calls).toEqual([]);
  expect(
    f.events("i").some(({ type }) => type === "design_pr_created" || type === "design_reflected"),
  ).toBe(false);
  expect(git(original, "rev-parse", "main")).not.toBe(approved);

  expect((await f.runner.design.approve("i", approved)).isOk()).toBe(true);
  await f.runner.design.drain();
  expect(f.db.select().from(issues).where(eq(issues.id, "i")).get()?.state).toBe("ready");
  expect(f.events("i").findLast(({ type }) => type === "design_approved")?.payload).toMatchObject({
    headCommit: approved,
    prTarget: { repository: "github.com/elsewhere/fixture", base: "main" },
  });
  expect(f.events("i").findLast(({ type }) => type === "design_reflected")?.payload).toMatchObject({
    mode: "pr",
    commit: approved,
    prUrl: url,
  });
  expect((f.runner.gh as ScriptedGh).calls.map(({ args }) => args.slice(0, 2))).toEqual([
    ["repo", "view"],
    ["pr", "list"],
    ["pr", "view"],
  ]);
});

it("作成済みの旧設計 PR は origin を変えても保存した URL で確認する", async () => {
  await reviewDesign(true);
  const { branch } = submission();
  const approved = recordApproval("pr");
  const path = join(f.home, "repo");
  const other = join(f.home, "unrelated.git");
  const url = "https://github.com/sukuna-test/fixture/pull/1";
  const id = stageConversation("design")!.id;
  git(path, "push", "origin", `${approved}:refs/heads/main`);
  git(f.home, "init", "--bare", "-q", "-b", "main", other);
  git(path, "remote", "set-url", "origin", other);
  f.db
    .insert(issueEvents)
    .values({
      issueId: "i",
      seq: f.events("i").at(-1)!.seq + 1,
      type: "design_pr_created",
      payload: { prUrl: url, conversationSeq: f.runner.runtime.store.get(id)?.lastSeq },
      createdAt: 1_000_000,
    })
    .run();
  f.db.update(issues).set({ state: "design" }).where(eq(issues.id, "i")).run();
  f.db.insert(settings).values({ key: "flow_paused", value: true }).run();
  writeFileSync(
    join(f.home, "gh.json"),
    JSON.stringify({
      responses: [
        {
          match: "^pr view https://github.com/sukuna-test/fixture/pull/1 ",
          stdout: JSON.stringify({
            ...recoveryPrs(url, branch, approved).at(-1)!,
            state: "MERGED",
            mergeCommit: { oid: approved },
          }),
          exit_code: 0,
        },
      ],
      fallback: { exit_code: 1, stdout: "", stderr: "Unexpected fixture command" },
    }),
  );
  await f.restart();
  expect((await f.runner.design.completePr("i", "")).isOk()).toBe(true);
  expect(f.db.select().from(issues).where(eq(issues.id, "i")).get()?.state).toBe("ready");
  expect(f.events("i").filter(({ type }) => type === "design_pr_created")).toHaveLength(1);
  expect(f.events("i").findLast(({ type }) => type === "design_reflected")?.payload).toMatchObject({
    mode: "pr",
    commit: approved,
    prUrl: url,
  });
  expect((f.runner.gh as ScriptedGh).calls.map(({ args }) => args.slice(0, 3))).toEqual([
    ["pr", "view", url],
  ]);
});
