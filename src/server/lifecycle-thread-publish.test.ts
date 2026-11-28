import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import WebSocket from "ws";
import { expect, it } from "vite-plus/test";
import { startRunnerApp } from "../runner/app";
import { createTempHome, openMigratedDatabase, removeTempHome } from "../shared/db/test-helpers";
import { serverMessageSchema, type ServerMessage } from "../shared/ws";
import { createApp } from "./app";
import { incomingWith } from "./modules/identity/test-support";
import { createStockDependencies } from "./modules/stock/adapter/dependencies";
import { createWorkspaceAgent } from "./modules/workspace/adapter/worktree-conversation-test-support";
import { createWorkspaceDependencies } from "./modules/workspace/adapter/dependencies";
import {
  attachUpgradeHandler,
  getDatabase,
  getLifecycleDependencies,
  getRunnerLink,
  getWsHub,
  initializeRuntime,
} from "./runtime";
import { directoriesIn, testEnvironment } from "../test/directories";

it("既存スレッドだけの削除で、別タブの元会話に参照が消えたことを伝える", async () => {
  const home = createTempHome();
  const dir = join(home, "project");
  mkdirSync(dir);
  const runnerDb = openMigratedDatabase(home);
  const sdk = createWorkspaceAgent("scripted");
  const env = testEnvironment(home);
  const runner = await startRunnerApp({
    database: runnerDb,
    environment: env,
    agent: sdk.agent,
    log: () => {},
  });
  const websocketHttp = createServer();
  let client: WebSocket | undefined;
  try {
    expect(
      (
        await initializeRuntime(
          { directories: directoriesIn(home) },
          { socket: env.socket, log: () => {} },
        )
      ).isOk(),
    ).toBe(true);
    const db = getDatabase();
    const link = getRunnerLink();
    await expect.poll(async () => (await link.forward("GET", "/health")).status).toBe(200);
    db.sqlite
      .prepare("INSERT INTO projects(id,name,path,default_branch) VALUES ('p','Project',?,'main')")
      .run(dir);
    db.sqlite
      .prepare(
        "INSERT INTO issues(id,project_id,number,title,body,state,created_at,updated_at) VALUES ('issue','p',42,'Issue','','draft',1,1)",
      )
      .run();
    const add = db.sqlite.prepare(
      "INSERT INTO conversations(id,project_id,kind,issue_id,parent_conversation_id,title,cwd,run_state) VALUES (?,'p',?,?,?,?,?,'idle')",
    );
    add.run("chat", "chat", null, null, "chat", dir);
    add.run("impl", "impl", "issue", null, "impl", dir);
    add.run("chat-t", "thread", null, "chat", "thread", dir);
    add.run("impl-t", "thread", "issue", "impl", "thread", dir);
    const addQuestion = db.sqlite.prepare(
      "INSERT INTO stock_items(id,conversation_id,kind,text,state,thread_conversation_id) VALUES (?,?,'question','質問','sent',?)",
    );
    addQuestion.run("q-chat", "chat", "chat-t");
    addQuestion.run("q-impl", "impl", "impl-t");
    const stock = createStockDependencies({
      database: () => db,
      workspace: createWorkspaceDependencies(() => db.db),
      runner: getRunnerLink,
      changed: (id, parts) =>
        getWsHub().notice({ kind: "conversation_parts", conversation_id: id, parts }),
      now: () => 1000,
      id: () => "unused",
    });
    const app = createApp({
      build: "review",
      lifecycle: getLifecycleDependencies(),
      stock,
    });
    const request = async (method: string, path: string, body?: unknown) => {
      const response = await app.request(
        "/api" + path,
        {
          method,
          ...(body
            ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
            : {}),
        },
        incomingWith("127.0.0.1", 1),
      );
      return { status: response.status, body: await response.json() };
    };
    attachUpgradeHandler(websocketHttp, {
      hub: getWsHub,
    });
    await new Promise<void>((resolve) => websocketHttp.listen(0, "127.0.0.1", resolve));
    client = new WebSocket(
      "ws://127.0.0.1:" + (websocketHttp.address() as AddressInfo).port + "/ws",
    );
    const messages: ServerMessage[] = [];
    client.on("message", (data) => {
      const raw =
        data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Array.isArray(data)
            ? Buffer.concat(data)
            : data;
      messages.push(serverMessageSchema.parse(JSON.parse(raw.toString())));
    });
    await once(client, "open");
    for (const topic of ["inbox", "conversation:chat", "conversation:impl"]) {
      client.send(JSON.stringify({ op: "subscribe", topic }));
    }
    const flush = async () => {
      const count = messages.filter((m) => m.topic === "app" && m.type === "runner").length;
      client!.send(JSON.stringify({ op: "subscribe", topic: "app" }));
      await expect
        .poll(() => messages.filter((m) => m.topic === "app" && m.type === "runner").length)
        .toBe(count + 1);
    };
    await flush();
    for (const parent of ["chat", "impl"]) {
      const thread = parent + "-t";
      const relevant = (from: number) =>
        messages
          .slice(from)
          .filter((m) => m.topic === "conversation:" + parent && m.type === "changed");
      const beforeFinish = messages.length;
      expect(await request("POST", "/threads/" + thread + "/finish", { action: "close" })).toEqual({
        status: 200,
        body: { thread: { id: thread, closedAt: 1000 } },
      });
      await flush();
      expect(relevant(beforeFinish).map((m) => m.payload)).toEqual([
        { parts: ["stock", "threads"] },
      ]);
      const beforeDelete = messages.length;
      expect(await request("DELETE", "/conversations/" + thread)).toEqual({
        status: 200,
        body: { deleted: [thread] },
      });
      await flush();
      const inbox = messages
        .slice(beforeDelete)
        .filter((m) => m.topic === "inbox" && m.type === "changed");
      const linkAfter = db.sqlite
        .prepare("SELECT thread_conversation_id FROM stock_items WHERE id=?")
        .get("q-" + parent);
      expect(linkAfter).toEqual({ thread_conversation_id: null });
      expect(await request("GET", "/conversations/" + parent + "/threads")).toEqual({
        status: 200,
        body: { threads: [] },
      });
      expect(relevant(beforeDelete).map((m) => m.payload)).toEqual([
        { parts: ["stock", "threads"] },
      ]);
      expect(inbox.map((m) => m.payload)).toEqual([
        {
          conversation_ids: [thread],
          issue_ids: parent === "impl" ? ["issue"] : [],
          project_ids: ["p"],
        },
      ]);
    }
  } finally {
    if (client && client.readyState !== WebSocket.CLOSED) {
      const closed = once(client, "close");
      client.terminate();
      await closed;
    }
    await new Promise<void>((resolve) => websocketHttp.close(() => resolve()));
    getRunnerLink().stop();
    await runner.shutdown();
    await sdk.dispose();
    getDatabase().close();
    runnerDb.close();
    removeTempHome(home);
  }
}, 10000);
