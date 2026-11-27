import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { startRunnerApp } from "../../../../runner/app";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
} from "../../../../shared/db/test-helpers";
import { readEnvironment } from "../../../../shared/env";
import { ScriptedGh } from "../../../../shared/gh/scripted-gh";
import { createApp } from "../../../app";
import { createClockFake, createTailscaleFake, incomingWith } from "../../identity/test-support";
import type {
  NotificationPush,
  NotificationPushMessage,
  ShowNotification,
} from "../../inbox/domain/push-port";
import { createProjectDependencies } from "../../workspace/adapter/project-dependencies";
import { createWorkspaceAgent } from "../../workspace/adapter/worktree-conversation-test-support";

const tag = "conversation:chat";
function device() {
  const shown = new Map<string, string>();
  const dismissed = new Set<string>();
  const latest = new Map<string, number>();
  let displayCount = 0;
  return {
    current: () => shown.get(tag),
    displayCount: () => displayCount,
    receive(message: NotificationPushMessage) {
      if (message.type === "show") {
        if (message.sequence <= (latest.get(message.tag) ?? 0)) return;
        latest.set(message.tag, message.sequence);
        if (!dismissed.has(message.id)) {
          shown.set(message.tag, message.id);
          displayCount += 1;
        }
      } else {
        message.ids.forEach((id) => dismissed.add(id));
        const current = shown.get(message.tag);
        if (current && message.ids.includes(current)) shown.delete(message.tag);
      }
    },
  };
}

async function fixture(notificationPush: NotificationPush) {
  vi.resetModules();
  const runtime = await import("../../../runtime");
  const home = createTempHome();
  const cwd = join(home, "project");
  mkdirSync(cwd);
  const runnerDb = openMigratedDatabase(home);
  const sdk = createWorkspaceAgent("scripted");
  const environment = readEnvironment(
    "runner",
    { SUKUNA_HOME: home },
    home,
    () => true,
  )._unsafeUnwrap();
  const runner = await startRunnerApp({
    database: runnerDb,
    environment,
    agent: sdk.agent,
    log: () => {},
  });
  const started = await runtime.initializeRuntime(
    { homeDir: home },
    {
      socket: environment.socket,
      log: () => {},
      notificationPush,
    },
  );
  expect(started.isOk()).toBe(true);
  const link = runtime.getRunnerLink();
  await expect.poll(async () => (await link.forward("GET", "/health")).status).toBe(200);
  const db = runtime.getDatabase();
  db.sqlite
    .prepare("INSERT INTO projects(id,name,path,default_branch) VALUES ('p','Project',?,'main')")
    .run(cwd);
  db.sqlite
    .prepare(
      "INSERT INTO conversations(id,project_id,kind,title,cwd,run_state) VALUES ('chat','p','chat','親の会話',?,'idle')",
    )
    .run(cwd);
  const notice = db.sqlite.prepare(
    "INSERT INTO notifications(id,target_kind,target_id,reason,title,body,created_at) VALUES(?,'conversation','chat','waiting',?,?,?)",
  );
  notice.run("old", "親の会話", "古い通知", 1);
  db.sqlite
    .prepare("INSERT INTO settings (key, value) VALUES ('inbox_notification_sequence', '1')")
    .run();
  const hub = runtime.getWsHub();
  const app = createApp({
    build: "test",
    identity: {
      login: "test@example.com",
      devIdentity: "1",
      tailscale: createTailscaleFake().api,
      clock: createClockFake(),
    },
    lifecycle: runtime.getLifecycleDependencies(),
    conversations: runtime.getConversationDependencies(),
    projects: createProjectDependencies(runtime.getDatabase, {
      runner: runtime.getRunnerLink,
      home,
      gh: new ScriptedGh({
        responses: [],
        fallback: { stdout: "", stderr: "unexpected gh", exit_code: 1 },
      }),
      changed: (id) => hub.notice({ kind: "project", project_id: id }),
      notifications: {
        dismissProject: (id, at) => hub.projectRemoved(id, at),
        restoreProject: (id) => hub.projectRestored(id),
      },
    }),
  });
  const request = async (method: string, path: string, body?: unknown) =>
    app.request(
      "/api" + path,
      {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      },
      incomingWith("127.0.0.1", 1),
    );
  return {
    db,
    notice,
    closeConversation: () => request("POST", "/conversations/chat/close", {}),
    sendConversation: (clientMessageId = "reopen") =>
      request("POST", "/conversations/chat/messages", {
        text: "first-failed",
        clientMessageId,
        mode: "send",
        images: [],
      }),
    removeProject: () => request("DELETE", "/projects/p"),
    async close() {
      link.stop();
      await runner.shutdown();
      await sdk.dispose();
      db.close();
      runnerDb.close();
      removeTempHome(home);
    },
  };
}

it("閉鎖通知の再試行中に別端末から会話が再開すると、旧通知だけを端末から消す", async () => {
  const newDevice = device();
  const oldDevice = device();
  const old: ShowNotification = {
    type: "show",
    id: "old",
    tag,
    sequence: 1,
    title: "親の会話",
    body: "古い通知",
    url: "/conversations/chat",
  };
  newDevice.receive(old);
  oldDevice.receive(old);
  let calls = 0;
  let held = false;
  let release = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(async (message) => {
    if (message.type === "show") {
      newDevice.receive(message);
      return;
    }
    if (++calls === 1) throw new Error("取り下げの一時的な失敗");
    held = true;
    await hold;
    newDevice.receive(message);
    oldDevice.receive(message);
  });
  const rows = f.db.sqlite.prepare("SELECT id,dismissed_at FROM notifications ORDER BY created_at");
  let retry: Promise<Response> | undefined;
  try {
    const first = await f.closeConversation();
    expect(first.status).toBe(200);
    const closed = await first.json();
    expect(rows.all()).toEqual([{ id: "old", dismissed_at: null }]);

    retry = f.closeConversation();
    await expect.poll(() => held).toBe(true);
    expect((await f.sendConversation()).status).toBe(202);
    await expect.poll(() => newDevice.current()).not.toBe("old");
    const id = newDevice.current();
    expect(id).toEqual(expect.any(String));
    expect(rows.all()).toEqual([
      { id: "old", dismissed_at: null },
      { id, dismissed_at: null },
    ]);

    release();
    const repeated = await retry;
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(closed);
    expect(rows.all()).toEqual([
      { id: "old", dismissed_at: expect.any(Number) },
      { id, dismissed_at: null },
    ]);
    expect([newDevice.current(), oldDevice.current()]).toEqual([id, undefined]);
    newDevice.receive(old);
    oldDevice.receive(old);
    expect([newDevice.current(), oldDevice.current()]).toEqual([id, undefined]);
  } finally {
    release();
    await retry;
    await f.close();
  }
}, 15_000);

it("閉鎖通知の送信に失敗したあとでプロジェクトを解除すると、残った通知も取り下げる", async () => {
  const f = await fixture(async () => {
    throw new Error("取り下げの一時的な失敗");
  });
  const rows = f.db.sqlite.prepare("SELECT id,dismissed_at FROM notifications ORDER BY id");
  try {
    expect((await f.closeConversation()).status).toBe(200);
    expect(rows.all()).toEqual([{ id: "old", dismissed_at: null }]);
    f.notice.run("new", "親の会話", "別の通知", 2);
    f.db.sqlite
      .prepare(
        "INSERT INTO projects(id,name,path,default_branch) VALUES ('other','Other','/other','main')",
      )
      .run();
    f.db.sqlite
      .prepare(
        "INSERT INTO conversations(id,project_id,kind,title,cwd) VALUES ('other-chat','other','chat','別の会話','/other')",
      )
      .run();
    f.db.sqlite
      .prepare(
        "INSERT INTO notifications(id,target_kind,target_id,reason,title,body,created_at) VALUES ('other','conversation','other-chat','waiting','題名','本文',3)",
      )
      .run();

    expect((await f.removeProject()).status).toBe(200);
    const project = f.db.sqlite.prepare("SELECT removed_at FROM projects WHERE id='p'").get() as {
      removed_at: number;
    };
    expect(project.removed_at).toEqual(expect.any(Number));
    expect(rows.all()).toEqual([
      { id: "new", dismissed_at: project.removed_at },
      { id: "old", dismissed_at: project.removed_at },
      { id: "other", dismissed_at: null },
    ]);
  } finally {
    await f.close();
  }
}, 15_000);

it.each(["old-show-first", "old-dismiss-first"] as const)(
  "新しい通知が先着した端末は旧通知の後着順によらず新しい表示を保つ: %s",
  async (order) => {
    const desktop = device();
    const clearDesktop = device();
    const shows: ShowNotification[] = [];
    let dismissCalls = 0;
    let dismissHeld = false;
    let oldDelivered = false;
    let releaseOld = () => {};
    let releaseDismiss = () => {};
    const oldDelivery = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const dismissDelivery = new Promise<void>((resolve) => {
      releaseDismiss = resolve;
    });
    const f = await fixture(async (message) => {
      if (message.type === "show") {
        shows.push(message);
        if (shows.length === 1) {
          await oldDelivery;
          desktop.receive(message);
          oldDelivered = true;
        } else {
          desktop.receive(message);
        }
        return;
      }
      if (++dismissCalls === 1) throw new Error("取り下げの一時的な失敗");
      dismissHeld = true;
      await dismissDelivery;
      desktop.receive(message);
    });
    f.db.sqlite.prepare("DELETE FROM notifications WHERE id='old'").run();
    const rows = f.db.sqlite.prepare("SELECT id,dismissed_at FROM notifications ORDER BY rowid");
    let retry: Promise<Response> | undefined;
    try {
      expect((await f.sendConversation("first-turn")).status).toBe(202);
      await expect.poll(() => shows.length).toBe(1);
      const old = shows[0];
      expect((await f.closeConversation()).status).toBe(200);
      retry = f.closeConversation();
      await expect.poll(() => dismissHeld).toBe(true);

      expect((await f.sendConversation("second-turn")).status).toBe(202);
      await expect.poll(() => shows.length).toBe(2);
      const current = shows[1];
      expect(current.sequence).toBeGreaterThan(old.sequence);
      expect(desktop.current()).toBe(current.id);
      desktop.receive(current);
      expect(desktop.displayCount()).toBe(1);

      if (order === "old-dismiss-first") {
        releaseDismiss();
        expect((await retry).status).toBe(200);
        releaseOld();
      } else {
        releaseOld();
        await expect.poll(() => oldDelivered).toBe(true);
        expect(desktop.current()).toBe(current.id);
        releaseDismiss();
        expect((await retry).status).toBe(200);
      }
      await expect.poll(() => oldDelivered).toBe(true);
      expect(desktop.current()).toBe(current.id);
      expect(desktop.displayCount()).toBe(1);
      expect(rows.all()).toEqual([
        { id: old.id, dismissed_at: expect.any(Number) },
        { id: current.id, dismissed_at: null },
      ]);

      clearDesktop.receive(current);
      expect(clearDesktop.current()).toBe(current.id);
      clearDesktop.receive({ type: "dismiss", tag, ids: [current.id] });
      clearDesktop.receive(old);
      expect(clearDesktop.current()).toBeUndefined();
    } finally {
      releaseOld();
      releaseDismiss();
      await retry;
      await f.close();
    }
  },
  15_000,
);
