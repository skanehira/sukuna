import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createApp } from "../../../app";
import { createClockFake, createTailscaleFake, incomingWith } from "../../identity/test-support";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
  type OpenedDatabase,
} from "../../../../shared/db/test-helpers";
import {
  conversations,
  conversationEvents,
  issues,
  issueEvents,
} from "../../../../shared/db/schema";
import { createProgressRepository } from "./progress-repository";
import { createTimelineFilePort } from "./timeline-file";
import { progressResponseSchema } from "../../../../shared/progress/schema";

let home: string;
let database: OpenedDatabase;
beforeEach(() => {
  home = createTempHome();
  database = openMigratedDatabase(home);
  mkdirSync(join(home, "timeline/sessions"), { recursive: true });
});
afterEach(() => {
  database.close();
  removeTempHome(home);
});

function app() {
  return createApp({
    build: "test",
    identity: {
      login: "test@example.com",
      devIdentity: "1",
      tailscale: createTailscaleFake().api,
      clock: createClockFake(),
    },
    progress: {
      repository: createProgressRepository(database.db),
      timeline: createTimelineFilePort({ configDir: home, sleep: async () => {} }),
    },
  });
}
function seedConversation(
  id = "chat",
  kind: "chat" | "triage" | "design" | "impl" | "thread" = "chat",
  issueId: string | null = null,
) {
  database.db
    .insert(conversations)
    .values({
      id,
      kind,
      issueId,
      projectId: "project",
      cwd: "/work",
      sessionId: id,
      runState: "working",
    })
    .run();
  database.db
    .insert(conversationEvents)
    .values([
      {
        conversationId: id,
        seq: 1,
        type: "user_message",
        payload: { origin: "developer", text: "依頼" },
        createdAt: 100,
      },
      {
        conversationId: id,
        seq: 2,
        type: "tool_use",
        payload: { name: "Bash", input: { command: "npm test" } },
        createdAt: 200,
      },
    ])
    .run();
}
const absent = {
  conversationId: "chat",
  activity: {
    stage: "reply",
    stageLabel: "応答",
    stageStartedAt: 100,
    lastAction: "Bash(npm test)",
    lastActionAt: 200,
  },
  timeline: null,
  readError: null,
};
const emptyTimeline = {
  defaultTreeId: null,
  trees: [],
  tasks: [],
  history: [],
  reports: [],
  comments: [],
};
const file = { version: 1, journal: [], reports: [] };

describe("進捗の API と SQLite・タイムラインファイル", () => {
  it("計画が無ければ null、ファイルに木が無ければ空の trees を返す", async () => {
    seedConversation();
    const server = app();
    const request = () =>
      server.request("/api/conversations/chat/progress", {}, incomingWith("127.0.0.1", 1234));
    const missing = await request();
    expect({ status: missing.status, body: await missing.json() }).toEqual({
      status: 200,
      body: absent,
    });
    writeFileSync(join(home, "timeline/sessions/chat.json"), JSON.stringify(file));
    const empty = await request();
    const body = await empty.json();
    expect({ status: empty.status, body: progressResponseSchema.parse(body) }).toEqual({
      status: 200,
      body: { ...absent, timeline: emptyTimeline },
    });
  });

  it.each(["conversations", "issues"])("存在しない %s は 404 not_found", async (target) => {
    const response = await app().request(
      `/api/${target}/missing/progress`,
      {},
      incomingWith("127.0.0.1", 1234),
    );
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 404,
      body: {
        error: {
          code: "not_found",
          message:
            target === "issues"
              ? "issue が見つかりません。開き直してください。"
              : "会話が見つかりません。開き直してください。",
        },
      },
    });
  });

  it.each([
    ["{", "タイムラインのファイルの形式が正しくありません。"],
    [" ".repeat(4 * 1024 * 1024 + 1), "タイムラインのファイルが 4 MiB を超えています。"],
  ])("ファイルエラーでも前に読めた計画を返す", async (text, readError) => {
    seedConversation();
    const path = join(home, "timeline/sessions/chat.json");
    writeFileSync(path, JSON.stringify(file));
    const server = app();
    const request = () =>
      server.request("/api/conversations/chat/progress", {}, incomingWith("127.0.0.1", 1234));
    expect(await (await request()).json()).toEqual({ ...absent, timeline: emptyTimeline });
    writeFileSync(path, text);
    const response = await request();
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { ...absent, timeline: emptyTimeline, readError },
    });
  });

  it.each([
    ["triage", null, "triage", "triage", "精査"],
    ["design", null, "design", "design", "設計"],
    ["design_review", null, "design", "design", "設計"],
    ["ready", null, "impl", "implement", "実装"],
    ["implementing", null, "impl", "review", "レビュー"],
    ["done", null, "impl", "implement", "実装"],
    ["stopped", "implementing", "impl", "review", "レビュー"],
  ] as const)(
    "issue の %s から担当の会話を選ぶ",
    async (state, previous, kind, stage, stageLabel) => {
      database.db
        .insert(issues)
        .values({
          id: "issue",
          projectId: "project",
          number: 1,
          title: "作業",
          state,
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      for (const conversationKind of ["triage", "design", "impl"] as const)
        seedConversation(conversationKind, conversationKind, "issue");
      database.db
        .insert(issueEvents)
        .values([
          {
            issueId: "issue",
            seq: 1,
            type: "state_changed",
            payload: { from: "ready", to: previous ?? state },
            createdAt: 50,
          },
          {
            issueId: "issue",
            seq: 2,
            type: "stage_changed",
            payload: { stage: "review" },
            createdAt: 60,
          },
        ])
        .run();
      const active =
        state === "triage" || state === "design" || state === "implementing" || state === "stopped";
      if (!active)
        database.db
          .update(conversations)
          .set({ runState: "idle" })
          .where(eq(conversations.id, kind))
          .run();
      const response = await app().request(
        "/api/issues/issue/progress",
        {},
        incomingWith("127.0.0.1", 1234),
      );
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 200,
        body: {
          ...absent,
          conversationId: kind,
          activity: active
            ? {
                ...absent.activity,
                stage,
                stageLabel,
                stageStartedAt: stage === "review" ? 60 : 50,
              }
            : null,
        },
      });
    },
  );

  it.each(["draft", "withdrawn", "implementing"] as const)(
    "%s の issue に担当が無ければ null を返す",
    async (state) => {
      database.db
        .insert(issues)
        .values({
          id: "issue",
          projectId: "project",
          number: 1,
          title: "作業",
          state,
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      const response = await app().request(
        "/api/issues/issue/progress",
        {},
        incomingWith("127.0.0.1", 1234),
      );
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 200,
        body: { conversationId: null, activity: null, timeline: null, readError: null },
      });
    },
  );

  it("停止した会話の activity と session id が無いときの timeline を null にする", async () => {
    database.db
      .insert(conversations)
      .values({
        id: "chat",
        kind: "thread",
        projectId: "project",
        cwd: "/work",
        runState: "stopped",
      })
      .run();
    const response = await app().request(
      "/api/conversations/chat/progress",
      {},
      incomingWith("127.0.0.1", 1234),
    );
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { conversationId: "chat", activity: null, timeline: null, readError: null },
    });
  });

  it.each([
    ["t", "作業"],
    ["t", "CSV「BOM」の扱い"],
    ["task 1", "作業"],
    ["task[1].*", "作業"],
  ])("ID %s・題名 %s の会話の相談をファイルのコメントと合成する", async (taskId, title) => {
    seedConversation();
    database.db
      .insert(conversationEvents)
      .values([
        {
          conversationId: "chat",
          seq: 3,
          type: "user_message",
          payload: {
            origin: "developer",
            text: `タイムラインのタスク ${taskId}「${title}」について: 確認`,
          },
          createdAt: 300,
        },
        {
          conversationId: "chat",
          seq: 4,
          type: "user_message",
          payload: {
            origin: "developer",
            text: `タイムラインのタスク ${taskId}「変更前の${title}」について: 会話だけの相談`,
          },
          createdAt: 400,
        },
      ])
      .run();
    writeFileSync(
      join(home, "timeline/sessions/chat.json"),
      JSON.stringify({
        ...file,
        comments: [{ at: 300, taskId, text: "確認" }],
        journal: [
          { at: 1, toolUseId: "t", ops: [{ op: "add", id: taskId, title: `変更前の${title}` }] },
          { at: 2, toolUseId: "rename", ops: [{ op: "update", id: taskId, title }] },
        ],
      }),
    );
    const response = await app().request(
      "/api/conversations/chat/progress",
      {},
      incomingWith("127.0.0.1", 1234),
    );
    const body = progressResponseSchema.parse(await response.json());
    expect({ status: response.status, body }).toEqual({
      status: 200,
      body: {
        conversationId: "chat",
        activity: {
          stage: "reply",
          stageLabel: "応答",
          stageStartedAt: 400,
          lastAction: "応答を作成中",
          lastActionAt: null,
        },
        timeline: {
          defaultTreeId: taskId,
          trees: [
            {
              id: taskId,
              title,
              status: "pending",
              completed: 0,
              parts: { pending: 1, in_progress: 0, completed: 0, blocked: 0 },
              leaves: { total: 1, pending: 1, in_progress: 0, completed: 0, blocked: 0 },
              startedAt: 1,
            },
          ],
          tasks: [
            {
              id: taskId,
              parent: null,
              title,
              status: "pending",
              weight: 1,
              completed: 0,
              units: "0 / 1",
            },
          ],
          history: [
            {
              at: 2,
              taskId,
              title,
              from: "pending",
              to: "pending",
              weight: 1,
              completedBefore: 0,
              completedAfter: 0,
              description: null,
              note: null,
              agentId: null,
            },
            {
              at: 1,
              taskId,
              title: `変更前の${title}`,
              from: null,
              to: "pending",
              weight: 1,
              completedBefore: 0,
              completedAfter: 0,
              description: null,
              note: null,
              agentId: null,
            },
          ],
          reports: [],
          comments: [
            { at: 300, taskId, text: "確認" },
            { at: 400, taskId, text: "会話だけの相談" },
          ],
        },
        readError: null,
      },
    });
  });

  it.each([
    { id: "t1", title: "題名" },
    { id: "t1", title: "CSV「BOM」の扱い" },
    { id: "task 1", title: "題名" },
    { id: "task[1].*", title: "題名" },
    { id: "t1", title: "空白の ある題名" },
    { id: "t1", title: "CSV」形式" },
    { id: "task\n1", title: "題名" },
    { id: "t1", title: "CSV\nBOMの扱い" },
    { id: "t1", title: "「完了」について: 表示を直す" },
    { id: "task「copy", title: "題名" },
    { id: "task", title: "copy「本当の題名" },
    { id: "", title: "題名" },
    { id: "t1", title: "前半\nタイムラインのタスク other「別」について: 後半" },
  ])("既知の ID $id と現旧題名 $title から相談を混ぜずに返す", async ({ id, title }) => {
    seedConversation();
    database.db
      .update(conversations)
      .set({ runState: "idle" })
      .where(eq(conversations.id, "chat"))
      .run();
    const others = [
      { id: "other", title: "別" },
      { id: id === "task" ? "task「copy" : "task", title: "元タスク" },
    ];
    const tasks = [{ id, title }, ...others];
    const oldTitle = title === "「完了」について: 表示を直す" ? "「完了" : `変更前の${title}`;
    const text = "  確認してください\nタイムラインのタスク の説明も見直す\n本文の続き  ";
    const origins = [
      "developer",
      "queued",
      "interrupt",
      "stock",
      "answer_text",
      "flow",
      "resume",
      "finish_proposal",
    ];
    database.db
      .insert(conversationEvents)
      .values(
        origins.map((origin, index) => ({
          conversationId: "chat",
          seq: index + 3,
          type: "user_message",
          createdAt: 300 + index,
          payload: {
            origin,
            text: `下書き\n\nタイムラインのタスク other「別」について: 別の相談\n別の続き\n\nタイムラインのタスク ${id}「${index === 0 ? oldTitle : title}」について: ${text}\n\nタイムラインのタスク ${others[1]!.id}「元タスク」について: もう一方の相談`,
          },
        })),
      )
      .run();
    writeFileSync(
      join(home, "timeline/sessions/chat.json"),
      JSON.stringify({
        ...file,
        journal: [
          {
            at: 1,
            toolUseId: "add",
            ops: tasks.map((task) => ({
              op: "add",
              ...task,
              title: task.id === id ? oldTitle : task.title,
            })),
          },
          { at: 2, toolUseId: "rename", ops: [{ op: "update", id, title }] },
        ],
        comments: [
          { at: 300, taskId: id, text },
          { at: 50, taskId: id, text: "ファイルの相談" },
        ],
      }),
    );
    const response = await app().request(
      "/api/conversations/chat/progress",
      {},
      incomingWith("127.0.0.1", 1234),
    );
    const body = progressResponseSchema.parse(await response.json());
    const history = (at: number, taskId: string, taskTitle: string, from: "pending" | null) => ({
      at,
      taskId,
      title: taskTitle,
      from,
      to: "pending",
      weight: 1,
      completedBefore: 0,
      completedAfter: 0,
      description: null,
      note: null,
      agentId: null,
    });
    expect({ status: response.status, body }).toEqual({
      status: 200,
      body: {
        conversationId: "chat",
        activity: null,
        readError: null,
        timeline: {
          defaultTreeId: others[1]!.id,
          trees: tasks.map((task) => ({
            ...task,
            status: "pending",
            completed: 0,
            parts: { pending: 1, in_progress: 0, completed: 0, blocked: 0 },
            leaves: { total: 1, pending: 1, in_progress: 0, completed: 0, blocked: 0 },
            startedAt: 1,
          })),
          tasks: tasks.map((task) => ({
            ...task,
            parent: null,
            status: "pending",
            weight: 1,
            completed: 0,
            units: "0 / 1",
          })),
          history: [
            history(2, id, title, "pending"),
            ...tasks
              .toReversed()
              .map((task) => history(1, task.id, task.id === id ? oldTitle : task.title, null)),
          ],
          reports: [],
          comments: [
            { at: 50, taskId: id, text: "ファイルの相談" },
            { at: 300, taskId: id, text },
            { at: 300, taskId: "other", text: "別の相談\n別の続き" },
            { at: 300, taskId: others[1]!.id, text: "もう一方の相談" },
            ...[301, 302, 303, 304].flatMap((at) => [
              { at, taskId: "other", text: "別の相談\n別の続き" },
              { at, taskId: id, text },
              { at, taskId: others[1]!.id, text: "もう一方の相談" },
            ]),
          ],
        },
      },
    });
  });
});
