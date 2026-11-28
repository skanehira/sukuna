import { afterEach, expect, it } from "vite-plus/test";
import { createTempHome, openMigratedDatabase, removeTempHome } from "../shared/db/test-helpers";
import { WsHub, type HubClient } from "./ws-hub";
import type { ServerMessage } from "../shared/ws";

const home = createTempHome();
const database = openMigratedDatabase(home);
afterEach(() => {
  database.sqlite.exec("DELETE FROM conversations; DELETE FROM issue_events; DELETE FROM issues;");
});
function client() {
  const sent: ServerMessage[] = [];
  let closed = false;
  const socket: HubClient = {
    bufferedAmount: 0,
    send: (data) => sent.push(JSON.parse(data)),
    close: () => {
      closed = true;
    },
  };
  return { socket, sent, closed: () => closed };
}
function conversation(id: string, count: number) {
  database.sqlite
    .prepare(
      "INSERT INTO conversations (id, project_id, kind, cwd, run_state, last_seq) VALUES (?, 'p', 'chat', '/tmp', 'working', ?)",
    )
    .run(id, count);
  const insert = database.sqlite.prepare(
    "INSERT INTO conversation_events (conversation_id, seq, type, payload, created_at) VALUES (?, ?, 'assistant_text', ?, ?)",
  );
  database.sqlite.transaction(() => {
    for (let seq = 1; seq <= count; seq++)
      insert.run(id, seq, JSON.stringify({ text: `text ${seq}`, parent_tool_use_id: null }), seq);
  })();
}
it("最後の番号の続きだけを送り、1000件を超えると記録を送らず読み直しを知らせる", () => {
  conversation("a", 1002);
  const hub = new WsHub(database.sqlite);
  const c = client();
  hub.add(c.socket);
  hub.receive(c.socket, { op: "subscribe", topic: "conversation:a", after: 1000 });
  expect(c.sent).toEqual(
    [1001, 1002].map((seq) => ({
      topic: "conversation:a",
      seq,
      type: "event",
      payload: {
        conversation_id: "a",
        seq,
        type: "assistant_text",
        payload: { text: `text ${seq}`, parent_tool_use_id: null },
        sdk_uuid: null,
        created_at: seq,
      },
    })),
  );
  const over = client();
  hub.add(over.socket);
  hub.receive(over.socket, { op: "subscribe", topic: "conversation:a", after: 1 });
  expect(over.sent).toEqual([
    { topic: "conversation:a", seq: 1002, type: "resync", payload: { last_seq: 1002 } },
  ]);
  const boundary = client();
  hub.add(boundary.socket);
  hub.receive(boundary.socket, { op: "subscribe", topic: "conversation:a", after: 2 });
  expect(boundary.sent.length).toBe(1000);
});
it("見えているページでshownに入れた対象だけを現在表示中とし、非表示と切断で外す", () => {
  const hub = new WsHub(database.sqlite);
  const a = client();
  const b = client();
  hub.add(a.socket);
  hub.add(b.socket);
  hub.receive(a.socket, { op: "subscribe", topic: "conversation:file" });
  hub.receive(a.socket, { op: "shown", topics: ["conversation:main", "issue:right"] });
  hub.receive(b.socket, { op: "shown", topics: ["conversation:other"] });
  expect(hub.shownTopics()).toEqual(
    new Set(["conversation:main", "issue:right", "conversation:other"]),
  );
  hub.receive(a.socket, { op: "visibility", visible: false });
  expect(hub.shownTopics()).toEqual(new Set(["conversation:other"]));
  hub.remove(b.socket);
  expect(hub.shownTopics()).toEqual(new Set());
  hub.receive(a.socket, { op: "visibility", visible: true });
  expect(hub.shownTopics()).toEqual(new Set(["conversation:main", "issue:right"]));
});
it("状態が変わらない記録でもinboxへ知らせ、購読していない対象には送らない", () => {
  conversation("a", 1);
  const hub = new WsHub(database.sqlite);
  const a = client();
  const b = client();
  hub.add(a.socket);
  hub.add(b.socket);
  hub.receive(a.socket, { op: "subscribe", topic: "inbox" });
  hub.receive(b.socket, { op: "subscribe", topic: "conversation:other" });
  hub.notice({
    kind: "conversation",
    conversation_id: "a",
    project_id: "p",
    issue_id: null,
    seq: 1,
    run_state: "working",
  });
  expect(a.sent).toEqual([
    {
      topic: "inbox",
      seq: 1,
      type: "changed",
      payload: { conversation_ids: ["a"], issue_ids: [], project_ids: ["p"] },
    },
  ]);
  expect(b.sent).toEqual([]);
});
it("送り待ちが8MiBを超える接続を閉じる", () => {
  const hub = new WsHub(database.sqlite);
  const c = client();
  hub.add(c.socket);
  hub.receive(c.socket, { op: "subscribe", topic: "inbox" });
  c.socket.bufferedAmount = 8 * 1024 * 1024;
  hub.notice({ kind: "project", project_id: "p" });
  expect(c.sent).toEqual([
    {
      topic: "inbox",
      seq: 1,
      type: "changed",
      payload: { conversation_ids: [], issue_ids: [], project_ids: ["p"] },
    },
  ]);
  expect(c.closed()).toBe(false);
  c.socket.bufferedAmount++;
  hub.notice({ kind: "project", project_id: "p" });
  expect(c.closed()).toBe(true);
});
import { afterAll } from "vite-plus/test";
afterAll(() => {
  database.close();
  removeTempHome(home);
});
it("購読が無い接続へもappの通し番号を使ってpingを送る", () => {
  const hub = new WsHub(database.sqlite);
  const c = client();
  hub.add(c.socket);
  hub.ping();
  hub.receive(c.socket, { op: "subscribe", topic: "inbox" });
  hub.notice({ kind: "project", project_id: "p" });
  hub.ping();
  expect(c.sent).toEqual([
    { topic: "app", seq: 1, type: "ping", payload: {} },
    {
      topic: "inbox",
      seq: 2,
      type: "changed",
      payload: { conversation_ids: [], issue_ids: [], project_ids: ["p"] },
    },
    { topic: "app", seq: 3, type: "ping", payload: {} },
  ]);
});
it("issueの最後の番号から再送し、解除した接続へは知らせを送らない", () => {
  database.sqlite
    .prepare(
      "INSERT INTO issues (id,project_id,number,title,body,kind,state,created_at,updated_at) VALUES ('i','p',1,'Issue','','bug','draft',1,1)",
    )
    .run();
  database.sqlite
    .prepare(
      "INSERT INTO issue_events (issue_id,seq,type,payload,created_at) VALUES ('i',1,'created','{}',1),('i',2,'changed','{}',2)",
    )
    .run();
  const hub = new WsHub(database.sqlite);
  const c = client();
  hub.add(c.socket);
  hub.receive(c.socket, { op: "subscribe", topic: "issue:i", after: 1 });
  expect(c.sent).toEqual([
    {
      topic: "issue:i",
      seq: 2,
      type: "event",
      payload: { issue_id: "i", seq: 2, type: "changed", payload: {}, created_at: 2 },
    },
  ]);
  hub.receive(c.socket, { op: "unsubscribe", topic: "issue:i" });
  hub.notice({ kind: "issue", issue_id: "i", project_id: "p", seq: 2 });
  expect(c.sent).toEqual([
    {
      topic: "issue:i",
      seq: 2,
      type: "event",
      payload: { issue_id: "i", seq: 2, type: "changed", payload: {}, created_at: 2 },
    },
  ]);
});
it("後からappを購読してもランナーの現在の接続状態を受け取れる", () => {
  const hub = new WsHub(database.sqlite);
  hub.connection(true);
  const c = client();
  hub.add(c.socket);
  hub.receive(c.socket, { op: "subscribe", topic: "app" });
  expect(c.sent).toEqual([{ topic: "app", seq: 3, type: "runner", payload: { connected: true } }]);
});
it("ランナーの出力トークンの数を、会話の購読者へ最後の番号とともに送る", () => {
  conversation("a", 3);
  const hub = new WsHub(database.sqlite);
  const a = client();
  const other = client();
  hub.add(a.socket);
  hub.add(other.socket);
  hub.receive(a.socket, { op: "subscribe", topic: "conversation:a", after: 3 });
  hub.receive(other.socket, { op: "subscribe", topic: "conversation:other" });
  hub.notice({ kind: "output_tokens", conversation_id: "a", tokens: 2149 });
  expect(a.sent).toEqual([
    { topic: "conversation:a", seq: 3, type: "output_tokens", payload: { tokens: 2149 } },
  ]);
  expect(other.sent).toEqual([]);
});
