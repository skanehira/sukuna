import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
} from "../../../../shared/db/test-helpers";
import type { ServerMessage } from "../../../../shared/ws";
import { WsHub } from "../../../ws-hub";
import { createTimelineWatch } from "./timeline-watch";

let home: string;
let database: ReturnType<typeof openMigratedDatabase>;
let hub: WsHub;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  home = createTempHome();
  database = openMigratedDatabase(home);
  const watcher = createTimelineWatch({
    database: database.sqlite,
    configDir: home,
    changed: (id, seq) =>
      hub.publish({
        type: "changed",
        topic: `conversation:${id}`,
        seq,
        payload: { parts: ["timeline"] },
      }),
  });
  hub = new WsHub(database.sqlite, { timeline: watcher });
  cleanups.push(() => watcher.close());
  database.sqlite
    .prepare(
      "INSERT INTO conversations (id, project_id, kind, cwd, session_id) VALUES ('chat', 'p', 'chat', ?, 'session')",
    )
    .run(home);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  database.close();
  removeTempHome(home);
});

function connect() {
  const changes: ServerMessage[] = [];
  const client = {
    bufferedAmount: 0,
    close: () => {},
    send: (data: string) => {
      const message = JSON.parse(data) as ServerMessage;
      if (message.type === "changed" && message.payload.parts?.includes("timeline"))
        changes.push(message);
    },
  };
  hub.add(client);
  const subscribe = () => hub.receive(client, { op: "subscribe", topic: "conversation:chat" });
  const unsubscribe = () => hub.receive(client, { op: "unsubscribe", topic: "conversation:chat" });
  subscribe();
  return { client, changes, subscribe, unsubscribe };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

it("ファイルの新規作成・置換と MCP の記録をまとめ、最後の購読がなくなれば通知を止める", async () => {
  const first = connect();
  const second = connect();
  first.subscribe();
  const directory = join(home, "timeline", "sessions");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "session.json");
  writeFileSync(file, "{}");
  writeFileSync(join(directory, "written.json"), '{"version":1}');
  renameSync(join(directory, "written.json"), file);
  database.sqlite.prepare("UPDATE conversations SET last_seq = 1 WHERE id = 'chat'").run();
  database.sqlite
    .prepare(
      "INSERT INTO conversation_events (conversation_id, seq, type, payload, created_at) VALUES ('chat', 1, 'tool_use', ?, 0)",
    )
    .run(JSON.stringify({ name: "mcp__timeline__timeline_tasks" }));
  hub.notice({
    kind: "conversation",
    conversation_id: "chat",
    project_id: "p",
    issue_id: null,
    run_state: "working",
    seq: 1,
  });
  expect(first.changes).toEqual([]);
  await expect.poll(() => first.changes.length).toBe(1);
  expect(second.changes).toEqual([
    { type: "changed", topic: "conversation:chat", seq: 1, payload: { parts: ["timeline"] } },
  ]);
  first.unsubscribe();
  writeFileSync(file, '{"version":2}');
  await expect.poll(() => second.changes.length).toBe(2);
  expect(first.changes).toHaveLength(1);
  hub.remove(second.client);
  writeFileSync(file, '{"version":3}');
  await delay(500);
  expect(second.changes).toHaveLength(2);
});

it("購読の途中で新しく指定されたセッションのファイルだけを見る", async () => {
  const observer = connect();
  const directory = join(home, "timeline", "sessions");
  mkdirSync(directory, { recursive: true });
  const oldFile = join(directory, "session.json");
  database.sqlite.prepare("UPDATE conversations SET session_id = 'next' WHERE id = 'chat'").run();
  hub.notice({
    kind: "conversation",
    conversation_id: "chat",
    project_id: "p",
    issue_id: null,
    run_state: "working",
    seq: 0,
  });
  writeFileSync(oldFile, "{}");
  await delay(500);
  expect(observer.changes).toEqual([]);
  writeFileSync(join(directory, "next.json"), "{}");
  await expect.poll(() => observer.changes.length).toBe(1);
});

it.each(["file", "tool"])(
  "%s が短い間隔で変わり続けても、途中と最後の更新を受け取る",
  async (source) => {
    const { changes } = connect();
    const directory = join(home, "timeline", "sessions");
    mkdirSync(directory, { recursive: true });
    const file = join(directory, "session.json");
    const update = database.sqlite.prepare(
      "UPDATE conversations SET last_seq = ? WHERE id = 'chat'",
    );
    const event = database.sqlite.prepare(
      "INSERT INTO conversation_events (conversation_id, seq, type, payload, created_at) VALUES ('chat', ?, 'tool_use', ?, 0)",
    );
    for (let seq = 1; seq <= 8; seq++) {
      if (source === "file") writeFileSync(file, JSON.stringify({ seq }));
      else event.run(seq, JSON.stringify({ name: "mcp__timeline__timeline_tasks" }));
      update.run(seq);
      if (seq === 7) expect(changes.some((change) => change.seq < seq)).toBe(true);
      await delay(130);
    }
    await expect.poll(() => changes.at(-1)?.seq).toBe(8);
  },
);

it("配達した相談の記録だけを見つけ、明示的な非相談や内部の発言では通知しない", async () => {
  const { changes } = connect();
  const append = database.sqlite.transaction((seq: number, payload: unknown) => {
    database.sqlite
      .prepare(
        "INSERT INTO conversation_events (conversation_id, seq, type, payload, created_at) VALUES ('chat', ?, 'user_message', ?, 0)",
      )
      .run(seq, JSON.stringify(payload));
    database.sqlite.prepare("UPDATE conversations SET last_seq = ? WHERE id = 'chat'").run(seq);
  });
  const text = "タイムラインのタスク task「集計」について: 過去の相談";
  append(1, { text, origin: "developer", timeline_comments: [] });
  append(2, { text, origin: "flow" });
  append(3, { text: "普通の指示", origin: "developer" });
  await delay(500);
  expect(changes).toEqual([]);

  append(4, { text, origin: "developer" });
  append(5, {
    text: "別の指示",
    origin: "queued",
    timeline_comments: [{ task_id: "task", text: "新しい相談" }],
  });
  await expect.poll(() => changes.map(({ seq }) => seq)).toEqual([5]);
  await delay(400);
  expect(changes.map(({ seq }) => seq)).toEqual([5]);
});
