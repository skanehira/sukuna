import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { startRunnerApp } from "../../../../runner/app";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
} from "../../../../shared/db/test-helpers";
import { createApp } from "../../../app";
import {
  getDatabase,
  getLifecycleDependencies,
  getRunnerLink,
  getWsHub,
  initializeRuntime,
} from "../../../runtime";
import { incomingWith } from "../../identity/test-support";
import type { DismissNotification } from "../../inbox/domain/push-port";
import { createWorkspaceAgent } from "../../workspace/adapter/worktree-conversation-test-support";
import { directoriesIn, testEnvironment } from "../../../../test/directories";

it("会話の閉鎖と削除は、対象の未取り下げ通知だけを端末から取り下げる", async () => {
  const home = createTempHome();
  const cwd = join(home, "project");
  mkdirSync(cwd);
  const runnerDb = openMigratedDatabase(home);
  const sdk = createWorkspaceAgent("scripted");
  const environment = testEnvironment(home);
  const runner = await startRunnerApp({
    database: runnerDb,
    environment,
    agent: sdk.agent,
    log: () => {},
  });
  const messages: DismissNotification[] = [];
  const targetsAtSend: unknown[] = [];
  let shouldFail = true;
  try {
    const started = await initializeRuntime(
      { directories: directoriesIn(home) },
      {
        socket: environment.socket,
        log: () => {},
        async notificationPush(message) {
          if (message.type !== "dismiss") return;
          if (shouldFail) {
            shouldFail = false;
            throw new Error("取り下げの送信失敗");
          }
          messages.push(message);
          const conversationId = message.tag.slice("conversation:".length);
          targetsAtSend.push(
            getDatabase()
              .sqlite.prepare("SELECT id FROM conversations WHERE id = ?")
              .get(conversationId),
          );
        },
      },
    );
    expect(started.isOk()).toBe(true);
    await expect
      .poll(async () => (await getRunnerLink().forward("GET", "/health")).status)
      .toBe(200);
    const { sqlite } = getDatabase();
    sqlite
      .prepare("INSERT INTO projects(id,name,path,default_branch) VALUES ('p','Project',?,'main')")
      .run(cwd);
    const active = sqlite.prepare(
      "INSERT INTO conversations(id,project_id,kind,parent_conversation_id,title,cwd,run_state) VALUES (?,'p',?,?,?,?,'idle')",
    );
    active.run("chat", "chat", null, "親の会話", cwd);
    active.run("thread", "thread", "chat", "子のスレッド", cwd);
    const notices = sqlite.prepare("SELECT id, dismissed_at FROM notifications ORDER BY id");
    const addNotice = sqlite.prepare(
      "INSERT INTO notifications(id,target_kind,target_id,reason,title,body,created_at,dismissed_at) VALUES(?,'conversation',?,'waiting','題名','本文',?,?)",
    );
    addNotice.run("chat-old", "chat", 11, null);
    addNotice.run("chat-old-2", "chat", 12, null);
    addNotice.run("thread-old", "thread", 11, null);
    addNotice.run("thread-already-dismissed", "thread", 12, 13);
    const app = createApp({
      build: "test",
      lifecycle: getLifecycleDependencies(),
    });
    const request = (method: string, route: string) =>
      app.request(
        "/api/conversations/chat" + route,
        method === "POST"
          ? { method, headers: { "content-type": "application/json" }, body: "{}" }
          : { method },
        incomingWith("127.0.0.1", 1),
      );

    const first = await request("POST", "/close");
    expect(first.status).toBe(200);
    const result = (await first.json()) as { closedAt: number };
    expect(notices.all()).toEqual([
      { id: "chat-old", dismissed_at: null },
      { id: "chat-old-2", dismissed_at: null },
      { id: "thread-already-dismissed", dismissed_at: 13 },
      { id: "thread-old", dismissed_at: null },
    ]);

    getWsHub().inbox(["chat"], [], ["p"]);
    const retry = await request("POST", "/close");
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(result);
    expect(notices.all()).toEqual([
      { id: "chat-old", dismissed_at: expect.any(Number) },
      { id: "chat-old-2", dismissed_at: expect.any(Number) },
      { id: "thread-already-dismissed", dismissed_at: 13 },
      { id: "thread-old", dismissed_at: expect.any(Number) },
    ]);
    expect(messages).toEqual([
      { type: "dismiss", tag: "conversation:chat", ids: ["chat-old", "chat-old-2"] },
      { type: "dismiss", tag: "conversation:thread", ids: ["thread-old"] },
    ]);

    addNotice.run("thread-new", "thread", result.closedAt + 1, null);
    expect((await request("POST", "/close")).status).toBe(200);
    expect(notices.all()).toContainEqual({ id: "thread-new", dismissed_at: null });
    expect(messages).toHaveLength(2);

    const deletion = await request("DELETE", "");
    expect(deletion.status).toBe(200);
    expect(await deletion.json()).toEqual({ deleted: ["chat", "thread"] });
    expect(messages).toEqual([
      { type: "dismiss", tag: "conversation:chat", ids: ["chat-old", "chat-old-2"] },
      { type: "dismiss", tag: "conversation:thread", ids: ["thread-old"] },
      { type: "dismiss", tag: "conversation:thread", ids: ["thread-new"] },
    ]);
    expect(targetsAtSend).toEqual([{ id: "chat" }, { id: "thread" }, { id: "thread" }]);
    expect(notices.all()).toEqual([]);
  } finally {
    getRunnerLink().stop();
    await runner.shutdown();
    await sdk.dispose();
    getDatabase().close();
    runnerDb.close();
    removeTempHome(home);
  }
}, 15_000);
