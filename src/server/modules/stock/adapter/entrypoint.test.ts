import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
import { isValid } from "ulid";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
} from "../../../../shared/db/test-helpers";
import { readEnvironment } from "../../../../shared/env";
import { startRunnerApp } from "../../../../runner/app";
import { ScriptedAgent } from "../../../../runner/modules/conversation/adapter/scripted-agent";
import { incomingWith } from "../../identity/test-support";
import { getDatabase, getRunnerLink, getWsHub, initializeRuntime } from "../../../runtime";
import type { HubClient } from "../../../ws-hub";
import { stockItemResponseSchema, finishThreadResponseSchema } from "../../../../shared/stock";

it("開発の入口からもストックを保存・配信でき、スレッドの実行を解放して閉じられる", async () => {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  database.sqlite
    .prepare(
      "INSERT INTO settings (key,value) VALUES ('runner-release:orphan', ?), ('fixture-setting', ?)",
    )
    .run(
      JSON.stringify({ token: "orphan", expiresAt: 9999999999999 }),
      JSON.stringify({ kept: true }),
    );
  database.sqlite
    .prepare(
      "INSERT INTO conversations (id,project_id,kind,cwd,run_state,stop_reason,closed_at) VALUES ('closed','p','thread',?,'usage_limited','usage_limit',1)",
    )
    .run(home);
  const scheduled: number[] = [];
  const runner = await startRunnerApp({
    clock: {
      now: () => 0,
      setTimeout: (_callback, milliseconds) => {
        scheduled.push(milliseconds);
        return () => {};
      },
    },
    database,
    environment: readEnvironment("runner", { SUKUNA_HOME: home }, home, () => true)._unsafeUnwrap(),
    agent: new ScriptedAgent({ rules: [], fallback: [{ hold: true }] }),
    log: () => {},
  });
  await initializeRuntime({ homeDir: home }, { socket: join(home, "runner.sock"), log: () => {} });
  let client: HubClient | undefined;
  try {
    const { default: app } = await import("../../../dev");
    const db = getDatabase().sqlite;
    expect(scheduled).toEqual([]);
    expect(db.prepare("SELECT key,value FROM settings ORDER BY key").all()).toEqual([
      { key: "fixture-setting", value: JSON.stringify({ kept: true }) },
    ]);
    writeFileSync(join(home, "quote.txt"), "引用");
    const quote = {
      kind: "file",
      mode: "line",
      text: "引用",
      path: "quote.txt",
      start: { line: 1, col: 0 },
      end: { line: 1, col: 2 },
    };
    db.prepare("INSERT INTO conversations (id,project_id,kind,cwd) VALUES ('c','p','chat',?)").run(
      home,
    );
    db.prepare(
      "INSERT INTO conversations (id,project_id,kind,cwd,parent_conversation_id) VALUES ('t','p','thread',?,'c')",
    ).run(home);
    const messages: unknown[] = [];
    await new Promise<void>((resolve) => {
      client = {
        bufferedAmount: 0,
        close: () => {},
        send: (message: string) => {
          const data = JSON.parse(message) as { type: string; payload: { connected?: boolean } };
          if (data.type === "runner" && data.payload.connected) resolve();
          if (data.type === "changed") messages.push(data);
        },
      };
      getWsHub().add(client);
      getWsHub().receive(client, { op: "subscribe", topic: "app" });
      getWsHub().receive(client, { op: "subscribe", topic: "conversation:c" });
    });
    const request = (path: string, body: unknown) =>
      app.request(
        path,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        incomingWith("127.0.0.1", 50000),
      );
    const created = await request("/api/conversations/c/stock", {
      kind: "question",
      text: "質問",
      quote,
    });
    expect(created.status).toBe(201);
    const { item } = stockItemResponseSchema.parse(await created.json());
    expect(isValid(item.id)).toBe(true);
    expect(item).toEqual({
      id: item.id,
      conversationId: "c",
      kind: "question",
      text: "質問",
      quote,
      state: "stocked",
      stale: false,
      sentAt: null,
      sentSeq: null,
      thread: null,
      githubCommentUrl: null,
    });
    expect(messages).toEqual([
      { topic: "conversation:c", seq: 0, type: "changed", payload: { parts: ["stock"] } },
    ]);
    const closed = await request("/api/threads/t/finish", { action: "close" });
    expect(closed.status).toBe(200);
    const result = finishThreadResponseSchema.parse(await closed.json());
    expect(result).toEqual({ thread: { id: "t", closedAt: expect.any(Number) } });
    expect(db.prepare("SELECT closed_at FROM conversations WHERE id='t'").get()).toEqual({
      closed_at: result.thread.closedAt,
    });
  } finally {
    if (client) getWsHub().remove(client);
    getRunnerLink().stop();
    await runner.shutdown();
    getDatabase().close();
    database.close();
    removeTempHome(home);
  }
});
