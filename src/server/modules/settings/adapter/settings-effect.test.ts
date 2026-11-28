import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { conversations, issues, projects } from "../../../../shared/db/schema";
import { ScriptedGh } from "../../../../shared/gh/scripted-gh";
import type { ServerMessage } from "../../../../shared/ws";
import { createApp } from "../../../app";
import { createConversationDependencies } from "../../conversation/adapter/dependencies";
import { git } from "../../flow/design-test-support";
import { createTailscaleFake, incomingWith } from "../../identity/test-support";
import { issueFixture } from "../../issue/test-support";
import { createProjectDependencies } from "../../workspace/adapter/project-dependencies";
import { createSettingsDependencies } from "./dependencies";

const flow = issueFixture(
  {
    rules: [
      { match: "^実行エラー$", steps: [{ end: "error_during_execution" }] },
      {
        match: "^利用枠切れ$",
        steps: [
          { rate_limit: { status: "rejected", resetsAt: 1020 } },
          { end: "error_during_execution" },
        ],
      },
      { match: "^正常終了$", steps: [{ end: "success" }] },
    ],
    fallback: [{ hold: true }],
  },
  { autoFlow: true },
);
const gh = new ScriptedGh({ responses: [], fallback: { stdout: "", stderr: "", exit_code: 0 } });
let app: ReturnType<typeof createApp>;
let cwd: string;
let messages: ServerMessage[];

beforeEach(() => {
  cwd = realpathSync(flow.home);
  execFileSync("git", ["init", "-q", "-b", "main", cwd]);
  git(cwd, "commit", "-q", "--allow-empty", "-m", "base");
  flow.db.update(projects).set({ path: cwd, model: "opus", permissionMode: "default" }).run();
  messages = [];
  const client = {
    bufferedAmount: 0,
    send: (raw: string) => messages.push(JSON.parse(raw) as ServerMessage),
    close: () => {},
  };
  flow.hub.add(client);
  flow.hub.receive(client, { op: "subscribe", topic: "app" });
  flow.hub.receive(client, { op: "subscribe", topic: "inbox" });
  app = createApp({
    build: "settings-effect",
    identity: {
      login: "dev@example.com",
      devIdentity: "1",
      tailscale: createTailscaleFake().api,
      clock: { now: Date.now },
    },
    settings: createSettingsDependencies(
      () => flow.db,
      cwd,
      () => flow.hub.settingsChanged(),
      undefined,
      {
        runner: () => flow.link,
        inboxChanged: () => flow.hub.inbox(),
      },
    ),
    projects: createProjectDependencies(() => flow.opened, {
      runner: () => flow.link,
      changed: (project_id) => flow.hub.notice({ kind: "project", project_id }),
      gh,
    }),
    conversations: createConversationDependencies({
      sqlite: flow.opened.sqlite,
      home: cwd,
      runner: flow.link,
      now: Date.now,
      id: () => crypto.randomUUID(),
      changed: () => {},
      reopened: () => {},
    }),
  });
});

function request(path: string, method = "GET", body?: unknown) {
  return app.request(
    path,
    {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    },
    incomingWith("127.0.0.1", 5000),
  );
}

function changeProject(patch: object) {
  return request("/api/projects/p", "PATCH", patch);
}

function pause(paused: boolean) {
  return request("/api/settings/flow-paused", "PUT", { paused });
}

async function chat(text: string) {
  const response = await request("/api/conversations", "POST", {
    projectId: "p",
    workspace: { kind: "project" },
  });
  expect(response.status).toBe(201);
  const { conversation } = z
    .object({ conversation: z.object({ id: z.string() }) })
    .parse(await response.json());
  await send(conversation.id, text);
  await expect.poll(() => opened(conversation.id)).toHaveLength(1);
  return conversation.id;
}

async function send(id: string, text: string) {
  const sent = await request(`/api/conversations/${id}/messages`, "POST", {
    text,
    images: [],
    mode: "send",
    clientMessageId: crypto.randomUUID(),
  });
  expect(sent.status).toBe(202);
}

async function enterTriage(id: string, number: number, projectId = "p") {
  flow.addIssue(id, number, { projectId, state: "draft" });
  expect((await flow.request(`/api/issues/${id}/confirm`, "POST", {})).status).toBe(200);
}

function opened(id: string) {
  return flow.agent.opened.filter(({ context }) => context.conversationId === id);
}

function openedIssue(id: string) {
  return flow.agent.opened.filter(({ context }) => context.issueId === id);
}

function issueState(id: string) {
  return flow.db.select({ state: issues.state }).from(issues).where(eq(issues.id, id)).get()?.state;
}

function runState(id: string) {
  return flow.db
    .select({ state: conversations.runState })
    .from(conversations)
    .where(eq(conversations.id, id))
    .get()?.state;
}

it("全体の一時停止を保存してランナーと画面へ知らせ、再開して待っていた精査を始める", async () => {
  const running = await chat("実行中の指示");
  const forward = vi.spyOn(flow.link, "forward");
  try {
    messages.length = 0;
    const paused = await pause(true);
    expect(paused.status).toBe(200);
    expect(await paused.json()).toEqual({ paused: true });
    expect(await (await request("/api/settings")).json()).toMatchObject({ flowPaused: true });
    expect(forward.mock.calls).toEqual([["POST", "/flow/notify", {}]]);
    expect(
      messages.filter(
        (message) =>
          message.type === "settings_changed" ||
          (message.topic === "inbox" &&
            message.type === "changed" &&
            message.payload.project_ids?.length === 0 &&
            message.payload.issue_ids?.length === 0 &&
            message.payload.conversation_ids?.length === 0),
      ),
    ).toEqual([
      { topic: "app", seq: expect.any(Number), type: "settings_changed", payload: {} },
      {
        topic: "inbox",
        seq: expect.any(Number),
        type: "changed",
        payload: { conversation_ids: [], issue_ids: [], project_ids: [] },
      },
    ]);

    await enterTriage("globally-paused", 1);
    expect(issueState("globally-paused")).toBe("triage");
    expect(openedIssue("globally-paused")).toHaveLength(0);
    expect(runState(running)).toBe("working");

    const resumed = await pause(false);
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toEqual({ paused: false });
    await expect.poll(() => openedIssue("globally-paused")).toHaveLength(1);
    expect(runState(running)).toBe("working");
  } finally {
    forward.mockRestore();
  }
});

it("paused に真偽値以外を渡すと保存せず 400 を返す", async () => {
  const response = await request("/api/settings/flow-paused", "PUT", { paused: "false" });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "invalid_input" } });
  expect(await (await request("/api/settings")).json()).toMatchObject({ flowPaused: false });
});

it("ランナーとの接続が無いときも、全体の一時停止は設定に残る", async () => {
  flow.link.stop();
  const response = await pause(true);
  expect(response.status).toBe(200);
  expect(await (await request("/api/settings")).json()).toMatchObject({ flowPaused: true });
});

it("新しい実行と再開に保存後のモデルと許可を渡し、実行中は設定を保つ", async () => {
  const previous = await chat("設定の変更前");
  const old = opened(previous)[0]!;
  expect(old).toMatchObject({ model: "opus", permissionMode: "default", resume: false });

  expect((await changeProject({ model: "sonnet", permissionMode: "acceptEdits" })).status).toBe(
    200,
  );
  const next = await chat("設定の変更後");
  expect(opened(next)).toEqual([
    {
      ...old,
      sessionId: expect.any(String),
      model: "sonnet",
      permissionMode: "acceptEdits",
      context: { conversationId: next, projectId: "p", issueId: null },
      appendSystemPrompt: old.appendSystemPrompt.replace(`${previous}.md`, `${next}.md`),
      onQuestion: expect.any(Function),
      onPermission: expect.any(Function),
    },
  ]);
  expect(opened(previous)).toEqual([old]);
  expect(runState(previous)).toBe("working");
  expect(old).toMatchObject({ model: "opus", permissionMode: "default" });

  expect((await request(`/api/conversations/${previous}/stop`, "POST")).status).toBe(202);
  await expect.poll(() => runState(previous)).toBe("stopped");
  await send(previous, "停止した会話を続ける");
  await expect.poll(() => opened(previous)).toHaveLength(2);
  expect(opened(previous)[1]).toEqual({
    ...old,
    model: "sonnet",
    permissionMode: "acceptEdits",
    resume: true,
    onQuestion: expect.any(Function),
    onPermission: expect.any(Function),
  });
});

it.each([
  { trigger: "実行失敗からの手動再開", text: "実行エラー", state: "failed", timer: false },
  { trigger: "利用枠切れからの手動再開", text: "利用枠切れ", state: "usage_limited", timer: false },
  {
    trigger: "利用枠が戻った時刻の自動再開",
    text: "利用枠切れ",
    state: "usage_limited",
    timer: true,
  },
])("$trigger は同じセッションに最新の設定を渡す", async ({ text, state, timer }) => {
  const id = await chat(text);
  await expect.poll(() => runState(id)).toBe(state);
  const first = opened(id)[0]!;
  expect(first).toMatchObject({ model: "opus", permissionMode: "default", resume: false });

  expect((await changeProject({ model: "sonnet", permissionMode: "acceptEdits" })).status).toBe(
    200,
  );
  if (timer) {
    await flow.advanceTo(1_079_999);
    expect(runState(id)).toBe("usage_limited");
    expect(opened(id)).toEqual([first]);
    await flow.advanceTo(1_080_000);
  } else {
    expect((await request(`/api/conversations/${id}/resume`, "POST")).status).toBe(202);
  }

  await expect
    .poll(() => flow.agent.sent)
    .toEqual([
      { sessionId: first.sessionId, text },
      { sessionId: first.sessionId, text: "中断したところから続けてください。" },
    ]);
  expect(opened(id)).toEqual([
    first,
    {
      ...first,
      model: "sonnet",
      permissionMode: "acceptEdits",
      resume: true,
      onQuestion: expect.any(Function),
      onPermission: expect.any(Function),
    },
  ]);
  expect(runState(id)).toBe("working");
});

it("正常に番が終わった会話は既存の実行で次の指示を受け取る", async () => {
  const id = await chat("正常終了");
  await expect.poll(() => runState(id)).toBe("idle");
  const first = opened(id)[0]!;
  expect((await changeProject({ model: "sonnet", permissionMode: "acceptEdits" })).status).toBe(
    200,
  );

  await send(id, "同じ実行への次の指示");
  await expect
    .poll(() => flow.agent.sent.at(-1))
    .toEqual({
      sessionId: first.sessionId,
      text: "同じ実行への次の指示",
    });
  expect(opened(id)).toEqual([first]);
  expect(first).toMatchObject({ model: "opus", permissionMode: "default" });
});

it("実装を自動処理から外すと精査だけが始まり、手動の /dev-impl は会話に届く", async () => {
  expect((await changeProject({ autoStages: ["triage"] })).status).toBe(200);
  flow.addIssue("ready-for-impl", 1, { state: "ready" });
  await enterTriage("ready-for-triage", 2);
  await expect.poll(() => openedIssue("ready-for-triage")).toHaveLength(1);
  expect(openedIssue("ready-for-impl")).toHaveLength(0);
  expect(issueState("ready-for-impl")).toBe("ready");

  const manual = await chat("/dev-impl");
  expect(flow.agent.sent).toContainEqual({
    sessionId: opened(manual)[0]!.sessionId,
    text: "/dev-impl",
  });
  expect(issueState("ready-for-impl")).toBe("ready");
});

it("プロジェクトだけを一時停止するとそのプロジェクトの精査だけが待つ", async () => {
  const otherPath = join(cwd, "other");
  mkdirSync(otherPath);
  execFileSync("git", ["init", "-q", "-b", "main", otherPath]);
  git(otherPath, "commit", "-q", "--allow-empty", "-m", "base");
  flow.db
    .insert(projects)
    .values({
      id: "other",
      name: "別のプロジェクト",
      path: otherPath,
      defaultBranch: "main",
    })
    .run();

  expect((await changeProject({ flowPaused: true })).status).toBe(200);
  await enterTriage("project-paused", 1);
  await enterTriage("other-active", 1, "other");
  await expect.poll(() => openedIssue("other-active")).toHaveLength(1);
  expect(openedIssue("project-paused")).toHaveLength(0);
  expect(issueState("project-paused")).toBe("triage");
});
