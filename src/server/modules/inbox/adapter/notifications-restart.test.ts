import { eq } from "drizzle-orm";
import { once } from "node:events";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { conversations, issues, notifications, questions } from "../../../../shared/db/schema";
import { inboxResponseSchema } from "../../../../shared/inbox/schema";
import { serverMessageSchema, type ServerMessage } from "../../../../shared/ws";
import { WsHub } from "../../../ws-hub";
import { inboxFixture } from "../test-support";
import { createInboxRepository } from "./inbox-repository";

function decode(data: RawData): unknown {
  const bytes =
    data instanceof ArrayBuffer
      ? Buffer.from(data)
      : Array.isArray(data)
        ? Buffer.concat(data)
        : data;
  return JSON.parse(bytes.toString("utf8"));
}
describe("通知の再起動対照", () => {
  const f = inboxFixture();
  let ids = 0;
  const handles = new Set<() => Promise<void>>();
  afterEach(async () => {
    for (const stop of handles) await stop();
  });
  async function connect(now: number) {
    const hub = new WsHub(f.sqlite, {
      inbox: { repository: createInboxRepository(() => f.db), resetTime: () => "12:34" },
      now: () => now,
      id: () => String(++ids),
    });
    const messages: ServerMessage[] = [];
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (client) => {
      hub.add(client);
      client.on("message", (raw) => hub.receive(client, decode(raw)));
      client.on("close", () => hub.remove(client));
    });
    await once(server, "listening");
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("expected TCP address");
    const client = new WebSocket("ws://127.0.0.1:" + addr.port);
    const stop = async () => {
      handles.delete(stop);
      client.terminate();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    };
    handles.add(stop);
    client.on("message", (raw) => messages.push(serverMessageSchema.parse(decode(raw))));
    await once(client, "open");
    client.send(JSON.stringify({ op: "visibility", visible: true }));
    client.send(JSON.stringify({ op: "shown", topics: [] }));
    const flush = async () => {
      const pong = once(client, "pong");
      client.ping();
      await pong;
    };
    await flush();
    return {
      hub,
      flush,
      close: stop,
      tags: () =>
        messages.flatMap((m) =>
          m.type === "notice" && m.payload.notification ? [m.payload.notification.tag] : [],
        ),
    };
  }

  it("担当会話の追加記録で理由が変わらなかった設計承認を再起動で重ねない", async () => {
    f.issue("i", 1, { state: "design_review" });
    f.issueEvent("i", 1, "state_changed", { from: "design", to: "design_review" }, 1000);
    f.conversation("design", {
      kind: "design",
      issueId: "i",
      runState: "working",
      lastActivityAt: 900,
    });
    const first = await connect(1100);
    expect(first.tags()).toEqual(["issue:i"]);
    f.event("design", 1, "assistant_text", { text: "設計の報告を完了しました" }, 1500);
    f.db
      .update(conversations)
      .set({ lastActivityAt: 1500, lastSeq: 1 })
      .where(eq(conversations.id, "design"))
      .run();
    first.hub.notice({
      kind: "conversation",
      conversation_id: "design",
      issue_id: "i",
      project_id: "p",
      seq: 1,
      run_state: "working",
    });
    expect(first.tags()).toEqual(["issue:i"]);
    await first.flush();
    await first.close();
    const second = await connect(1600);
    expect({
      newTags: second.tags(),
      createdAt: f.db
        .select()
        .from(notifications)
        .all()
        .map((n) => n.createdAt),
    }).toEqual({ newTags: [], createdAt: [1100] });
  });

  it("別のスレッドの作業で理由が変わらなかった親の質問を再起動で重ねない", async () => {
    f.conversation("c", { runState: "waiting_answer", lastActivityAt: 1000, lastSeq: 1 });
    f.event("c", 1, "assistant_text", { text: "親の質問" }, 1000);
    f.db
      .insert(questions)
      .values({ id: "ask", conversationId: "c", seq: 1, kind: "text", text: "親の質問" })
      .run();
    f.conversation("t", {
      kind: "thread",
      parentConversationId: "c",
      runState: "working",
      lastActivityAt: 900,
    });
    const first = await connect(1100);
    expect(first.tags()).toEqual(["conversation:c"]);
    f.event("t", 1, "assistant_text", { text: "子の途中の発言" }, 1500);
    f.db
      .update(conversations)
      .set({ lastActivityAt: 1500, lastSeq: 1 })
      .where(eq(conversations.id, "t"))
      .run();
    first.hub.notice({
      kind: "conversation",
      conversation_id: "t",
      project_id: "p",
      issue_id: null,
      seq: 1,
      run_state: "working",
    });
    expect(first.tags()).toEqual(["conversation:c"]);
    await first.flush();
    await first.close();
    const second = await connect(1600);
    expect({
      newTags: second.tags(),
      createdAt: f.db
        .select()
        .from(notifications)
        .all()
        .map((n) => n.createdAt),
    }).toEqual({ newTags: [], createdAt: [1100] });
  });

  it("本当に新たな issue の承認待ちは再起動後に通知する", async () => {
    f.issue("i", 1, { state: "design_review" });
    f.issueEvent("i", 1, "state_changed", { from: "design", to: "design_review" }, 1000);
    const first = await connect(1100);
    expect(first.tags()).toEqual(["issue:i"]);
    f.issueEvent("i", 2, "state_changed", { from: "design_review", to: "design" }, 1300);
    f.issueEvent("i", 3, "state_changed", { from: "design", to: "design_review" }, 1500);
    f.db.update(issues).set({ state: "design_review" }).where(eq(issues.id, "i")).run();
    await first.flush();
    await first.close();
    const second = await connect(1600);
    expect({
      newTags: second.tags(),
      createdAt: f.db
        .select()
        .from(notifications)
        .all()
        .map((n) => n.createdAt),
    }).toEqual({ newTags: ["issue:i"], createdAt: [1100, 1600] });
  });
  it("前の通知と同じミリ秒でも実行中issueの新しい許可依頼を再起動後に通知する", async () => {
    f.issue("i", 1, { state: "design" });
    f.issueEvent("i", 1, "state_changed", { from: "triage", to: "design" }, 900);
    f.conversation("design", {
      kind: "design",
      issueId: "i",
      runState: "waiting_permission",
      lastSeq: 1,
      lastActivityAt: 1000,
    });
    f.event(
      "design",
      1,
      "permission_request",
      { tool_name: "Read", input: { file_path: "/p/a.md" } },
      1000,
    );
    const first = await connect(1100);
    expect(first.tags()).toEqual(["issue:i"]);
    await first.close();
    f.event("design", 2, "permission_decision", { behavior: "allow" }, 1100);
    f.event(
      "design",
      3,
      "permission_request",
      { tool_name: "Read", input: { file_path: "/p/b.md" } },
      1100,
    );
    f.db
      .update(conversations)
      .set({ lastActivityAt: 1100, lastSeq: 3 })
      .where(eq(conversations.id, "design"))
      .run();
    const second = await connect(1600);
    expect({
      tags: second.tags(),
      createdAt: f.db
        .select()
        .from(notifications)
        .all()
        .map((n) => n.createdAt),
    }).toEqual({ tags: ["issue:i"], createdAt: [1100, 1600] });
  });

  it.each([
    { parent: "conversation", restart: true, newTurn: false },
    { parent: "issue", restart: true, newTurn: false },
    { parent: "conversation", restart: false, newTurn: false },
    { parent: "conversation", restart: true, newTurn: true },
  ] as const)(
    "子の許可待ちを外した親の通知を照合する $parent $restart $newTurn",
    async ({ parent, restart, newTurn }) => {
      const issue = parent === "issue";
      if (issue) {
        f.issue("i", 1, { state: "design" });
        f.issueEvent("i", 1, "state_changed", { from: "design_review", to: "design" }, 900);
      }
      const tag = issue ? "issue:i" : "conversation:c";
      const seq = issue ? 3 : 2;
      f.conversation("c", {
        ...(issue ? { kind: "design", issueId: "i" } : {}),
        runState: "idle",
        lastActivityAt: 1000,
        lastSeq: seq,
        recapSeq: seq,
      });
      if (issue)
        f.event("c", 1, "user_message", { text: "親の作業を続けて", origin: "developer" }, 920);
      f.event("c", seq - 1, "assistant_text", { text: "親は回答済み" }, 950);
      f.event("c", seq, "turn_end", { subtype: "success" }, 1000);
      f.conversation("t", {
        kind: "thread",
        parentConversationId: "c",
        runState: "working",
        lastActivityAt: 1000,
      });
      const first = await connect(1100);
      expect(first.tags()).toEqual([tag]);
      f.event("t", 1, "permission_request", { tool_name: "Read" }, 1100);
      f.db
        .update(conversations)
        .set({ runState: "waiting_permission", lastActivityAt: 1100, lastSeq: 1 })
        .where(eq(conversations.id, "t"))
        .run();
      first.hub.notice({
        kind: "conversation",
        conversation_id: "t",
        issue_id: null,
        project_id: "p",
        seq: 1,
        run_state: "waiting_permission",
      });
      await first.flush();
      expect(first.tags()).toEqual([tag, "conversation:t"]);
      if (restart) {
        await first.close();
        f.db.delete(conversations).where(eq(conversations.id, "t")).run();
      } else {
        f.db.update(conversations).set({ closedAt: 1400 }).where(eq(conversations.id, "t")).run();
      }
      if (newTurn) {
        f.event("c", seq + 1, "assistant_text", { text: "親からの新しい回答" }, 1100);
        f.event("c", seq + 2, "turn_end", { subtype: "success" }, 1100);
        f.db
          .update(conversations)
          .set({ lastActivityAt: 1100, lastSeq: seq + 2, recapSeq: seq + 2 })
          .where(eq(conversations.id, "c"))
          .run();
      }
      const inbox = await f.request("/api/inbox");
      const { sections } = inboxResponseSchema.parse(await inbox.json());
      expect(
        sections
          .find(({ name }) => name === "instruction")
          ?.rows.map(({ key, reason }) => ({ key, reason })),
      ).toEqual([{ key: tag, reason: "turn_ended" }]);

      let received: string[];
      if (restart) {
        received = (await connect(1400)).tags();
      } else {
        first.hub.notice({ kind: "project", project_id: "p" });
        await first.flush();
        received = first.tags().slice(2);
      }
      const saved = f.db.select().from(notifications).all();
      expect({
        received,
        parentNotifications: saved
          .filter(({ targetId }) => targetId === (issue ? "i" : "c"))
          .map(({ reason, createdAt }) => ({ reason, createdAt })),
        stillShowing: saved.filter(
          ({ targetId, dismissedAt }) => targetId === "t" && dismissedAt === null,
        ),
      }).toEqual({
        received: newTurn ? [tag] : [],
        parentNotifications: [
          { reason: "turn_ended", createdAt: 1100 },
          ...(newTurn ? [{ reason: "turn_ended", createdAt: 1400 }] : []),
        ],
        stillShowing: [],
      });
    },
  );

  it.each([
    { previous: "design_review", next: "ready", observed: false, reason: null },
    { previous: "stopped", next: "done", observed: false, reason: "merge_confirm" },
    { previous: "stopped", next: "withdrawn", observed: false, reason: "failed" },
    { previous: "design_review", next: "ready", observed: true, reason: null },
    { previous: "design_review", next: "design", observed: false, reason: null },
  ] as const)(
    "一覧の行が待ち状態を外れたときに取り下げる $previous $next $observed",
    async ({ previous, next, observed, reason }) => {
      f.issue("i", 1, { state: previous, stopReason: reason });
      f.issueEvent(
        "i",
        1,
        "state_changed",
        { from: previous === "stopped" ? "implementing" : "design", to: previous },
        1000,
      );
      const first = await connect(1100);
      expect(first.tags()).toEqual(["issue:i"]);
      expect(
        f.db
          .select()
          .from(notifications)
          .all()
          .map((x) => x.dismissedAt),
      ).toEqual([null]);
      if (!observed) await first.close();
      f.issueEvent("i", 2, "state_changed", { from: previous, to: next }, 1500);
      f.db.update(issues).set({ state: next, stopReason: null }).where(eq(issues.id, "i")).run();
      if (observed) {
        first.hub.notice({ kind: "issue", issue_id: "i", project_id: "p", seq: 2 });
        await first.flush();
        expect(first.tags()).toEqual(["issue:i"]);
      } else {
        const second = await connect(1600);
        expect(second.tags()).toEqual([]);
      }
      expect(
        f.db
          .select()
          .from(notifications)
          .all()
          .map((x) => x.dismissedAt),
      ).toEqual([observed ? 1100 : 1600]);
    },
  );
  it("プロジェクト単位の更新で別プロジェクトの通知を取り下げない", async () => {
    f.issue("p-i", 1, { state: "design_review" });
    f.issue("q-i", 2, { projectId: "q", state: "design_review" });
    const first = await connect(1100);
    expect(first.tags()).toEqual(["issue:p-i", "issue:q-i"]);
    f.db.update(issues).set({ state: "ready" }).where(eq(issues.id, "q-i")).run();
    first.hub.notice({ kind: "project", project_id: "p" });
    await first.flush();
    expect(
      f.db
        .select()
        .from(notifications)
        .all()
        .map(({ targetId, dismissedAt }) => ({ targetId, dismissedAt })),
    ).toEqual([
      { targetId: "p-i", dismissedAt: null },
      { targetId: "q-i", dismissedAt: null },
    ]);
    first.hub.notice({ kind: "project", project_id: "q" });
    expect(
      f.db
        .select()
        .from(notifications)
        .all()
        .map(({ targetId, dismissedAt }) => ({ targetId, dismissedAt })),
    ).toEqual([
      { targetId: "p-i", dismissedAt: null },
      { targetId: "q-i", dismissedAt: 1100 },
    ]);
  });
});
