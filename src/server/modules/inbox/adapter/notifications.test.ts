import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import {
  conversations,
  issues,
  notifications,
  projects,
  questions,
} from "../../../../shared/db/schema";
import { inboxResponseSchema } from "../../../../shared/inbox/schema";
import { serverMessageSchema, type ServerMessage } from "../../../../shared/ws";
import { WsHub } from "../../../ws-hub";
import { inboxFixture } from "../test-support";
import { createInboxRepository } from "./inbox-repository";

describe("一覧の通知と配信", () => {
  const f = inboxFixture();
  function fixture() {
    let at = 1000;
    let id = 0;
    const hub = new WsHub(f.sqlite, {
      inbox: { repository: createInboxRepository(() => f.db), resetTime: () => "12:34" },
      now: () => at,
      id: () => String(++id),
    });
    function connect() {
      const messages: ServerMessage[] = [];
      const client = {
        bufferedAmount: 0,
        send: (raw: string) => messages.push(serverMessageSchema.parse(JSON.parse(raw))),
        close: () => {},
      };
      hub.add(client);
      return {
        client,
        notices: () => messages.filter((m) => m.type === "notice").map((m) => m.payload),
      };
    }
    const first = connect();
    const second = connect();
    function changed(
      id: string,
      runState: "waiting_answer" | "idle" | "working" | "stopped",
      issueId: string | null = null,
    ) {
      hub.notice({
        kind: "conversation",
        conversation_id: id,
        project_id: "p",
        issue_id: issueId,
        seq: 1,
        run_state: runState,
      });
    }
    return {
      hub,
      first,
      second,
      changed,
      at: (value: number) => {
        at = value;
      },
    };
  }
  function question(id: string) {
    f.event(id, 1, "assistant_text", { text: "確認します" });
    f.db
      .insert(questions)
      .values({
        id: "q-" + id,
        conversationId: id,
        seq: 1,
        kind: "text",
        text: "どちらですか\n次の行",
      })
      .run();
    f.db
      .update(conversations)
      .set({ lastSeq: 1, runState: "waiting_answer" })
      .where(eq(conversations.id, id))
      .run();
  }
  const stored = () => f.db.select().from(notifications).all();

  it("判断待ちの会話をSQLiteに1回だけ記録し、全接続に知らせる", () => {
    const x = fixture();
    f.conversation("c", { runState: "working" });
    x.changed("c", "working");
    question("c");
    x.changed("c", "waiting_answer");
    x.changed("c", "waiting_answer");
    const payload = {
      level: "info",
      message: "c (project-p): どちらですか",
      notification: { tag: "conversation:c", url: "/conversations/c" },
    };
    expect([x.first.notices(), x.second.notices(), stored()]).toEqual([
      [payload],
      [payload],
      [
        {
          id: "1",
          targetKind: "conversation",
          targetId: "c",
          reason: "question",
          title: "c (project-p)",
          body: "どちらですか",
          createdAt: 1000,
          dismissedAt: null,
        },
      ],
    ]);
  });

  it("issueの判断待ちを担当の会話に重ねず、issueの通知として送る", () => {
    const x = fixture();
    f.issue("i", 13, { state: "design" });
    f.conversation("design", { kind: "design", issueId: "i", runState: "working" });
    x.changed("design", "working", "i");
    f.db.update(issues).set({ state: "design_review" }).where(eq(issues.id, "i")).run();
    x.hub.notice({ kind: "issue", issue_id: "i", project_id: "p", seq: 1 });
    expect([x.first.notices(), stored()]).toEqual([
      [
        {
          level: "info",
          message: "#13 i (project-p): 設計の承認を待っています",
          notification: { tag: "issue:i", url: "/issues/i" },
        },
      ],
      [
        {
          id: "1",
          targetKind: "issue",
          targetId: "i",
          reason: "design_review",
          title: "#13 i (project-p)",
          body: "設計の承認を待っています",
          createdAt: 1000,
          dismissedAt: null,
        },
      ],
    ]);
  });

  it.each([
    { kind: "chat", parent: null },
    { kind: "thread", parent: "parent" },
  ] as const)("$kind の番の終わりの待ちが済むと一行目を知らせる", async ({ kind, parent }) => {
    const x = fixture();
    if (parent) f.conversation(parent);
    f.conversation("c", { kind, parentConversationId: parent, runState: "working" });
    x.changed("c", "working");
    f.event("c", 1, "assistant_text", { text: "応答一行目\n応答二行目" });
    f.event("c", 2, "turn_end");
    f.db
      .update(conversations)
      .set({ lastSeq: 2, runState: "idle" })
      .where(eq(conversations.id, "c"))
      .run();
    x.changed("c", "idle");
    expect([stored(), x.first.notices()]).toEqual([[], []]);
    f.db.update(conversations).set({ recapSeq: 2 }).where(eq(conversations.id, "c")).run();
    x.hub.notice({ kind: "conversation_parts", conversation_id: "c", parts: ["recap"] });
    x.hub.notice({ kind: "conversation_parts", conversation_id: "c", parts: ["recap"] });
    const title = parent ? "スレッド: c (project-p)" : "c (project-p)";
    expect([x.first.notices(), stored()]).toEqual([
      [
        {
          level: "info",
          message: title + ": 応答一行目",
          notification: {
            tag: "conversation:c",
            url: parent ? "/conversations/parent?thread=c" : "/conversations/c",
          },
        },
      ],
      [
        {
          id: "1",
          targetKind: "conversation",
          targetId: "c",
          reason: "turn_ended",
          title,
          body: "応答一行目",
          createdAt: 1000,
          dismissedAt: null,
        },
      ],
    ]);
    if (parent) {
      const body = inboxResponseSchema.parse(await (await f.request("/api/inbox")).json());
      expect(
        body.sections.flatMap((section) =>
          section.rows.map(({ id, threadAnswers }) => ({ id, threadAnswers })),
        ),
      ).toEqual([{ id: parent, threadAnswers: 1 }]);
    }
  });

  it("一端末が会話を見ていれば通知を取り下げ済みで記録し、他端末にも送らない", () => {
    const x = fixture();
    f.conversation("c", { runState: "working" });
    x.changed("c", "working");
    x.hub.receive(x.first.client, { op: "shown", topics: ["conversation:c"] });
    question("c");
    x.changed("c", "waiting_answer");
    expect([x.first.notices(), x.second.notices(), stored()]).toEqual([
      [],
      [],
      [
        {
          id: "1",
          targetKind: "conversation",
          targetId: "c",
          reason: "question",
          title: "c (project-p)",
          body: "どちらですか",
          createdAt: 1000,
          dismissedAt: 1000,
        },
      ],
    ]);
  });

  it.each([{ action: "shown" }, { action: "working" }])(
    "$action になった時刻で既存の通知を取り下げる",
    ({ action }) => {
      const x = fixture();
      f.conversation("c", { runState: "working" });
      x.changed("c", "working");
      question("c");
      x.changed("c", "waiting_answer");
      x.at(2000);
      if (action === "shown")
        x.hub.receive(x.second.client, { op: "shown", topics: ["conversation:c"] });
      else {
        f.db
          .update(conversations)
          .set({ runState: "working" })
          .where(eq(conversations.id, "c"))
          .run();
        x.changed("c", "working");
      }
      expect(stored()).toEqual([
        {
          id: "1",
          targetKind: "conversation",
          targetId: "c",
          reason: "question",
          title: "c (project-p)",
          body: "どちらですか",
          createdAt: 1000,
          dismissedAt: 2000,
        },
      ]);
    },
  );

  it("自分で止めた会話では通知せず、その後に新たに判断待ちに入ったときだけ通知する", () => {
    const x = fixture();
    f.conversation("c", { runState: "working" });
    x.changed("c", "working");
    f.event("c", 1, "assistant_text", { text: "途中まで" });
    f.db
      .update(conversations)
      .set({ lastSeq: 1, runState: "stopped", stopReason: "user" })
      .where(eq(conversations.id, "c"))
      .run();
    x.changed("c", "stopped");
    expect(stored()).toEqual([]);
    f.db
      .update(conversations)
      .set({ runState: "working", stopReason: null })
      .where(eq(conversations.id, "c"))
      .run();
    x.changed("c", "working");
    f.db
      .insert(questions)
      .values({ id: "new-q", conversationId: "c", seq: 1, kind: "text", text: "再開後の質問" })
      .run();
    f.db
      .update(conversations)
      .set({ runState: "waiting_answer" })
      .where(eq(conversations.id, "c"))
      .run();
    x.changed("c", "waiting_answer");
    expect(x.first.notices()).toEqual([
      {
        level: "info",
        message: "c (project-p): 再開後の質問",
        notification: { tag: "conversation:c", url: "/conversations/c" },
      },
    ]);
  });

  it("プロジェクトを外すと会話とissueの通知を取り下げ、登録を戻しても再通知しない", () => {
    const x = fixture();
    f.conversation("c", { runState: "working" });
    f.issue("i", 13, { state: "design" });
    x.changed("c", "working");
    question("c");
    x.changed("c", "waiting_answer");
    f.db.update(issues).set({ state: "design_review" }).where(eq(issues.id, "i")).run();
    x.hub.notice({ kind: "issue", issue_id: "i", project_id: "p", seq: 1 });
    x.at(2000);
    f.db.update(projects).set({ removedAt: 2000 }).where(eq(projects.id, "p")).run();
    x.hub.projectRemoved("p", 2000);
    x.hub.notice({ kind: "project", project_id: "p" });
    x.at(3000);
    f.db.update(projects).set({ removedAt: null }).where(eq(projects.id, "p")).run();
    x.hub.projectRestored("p");
    x.hub.notice({ kind: "project", project_id: "p" });
    expect(stored()).toEqual([
      {
        id: "1",
        targetKind: "conversation",
        targetId: "c",
        reason: "question",
        title: "c (project-p)",
        body: "どちらですか",
        createdAt: 1000,
        dismissedAt: 2000,
      },
      {
        id: "2",
        targetKind: "issue",
        targetId: "i",
        reason: "design_review",
        title: "#13 i (project-p)",
        body: "設計の承認を待っています",
        createdAt: 1000,
        dismissedAt: 2000,
      },
    ]);
  });
});

describe("表示と再起動からの通知", () => {
  const f = inboxFixture();
  function connect(now: number, suffix: string) {
    const hub = new WsHub(f.sqlite, {
      inbox: { repository: createInboxRepository(() => f.db), resetTime: () => "12:34" },
      now: () => now,
      id: () => suffix,
    });
    const notices: ServerMessage[] = [];
    const client = {
      bufferedAmount: 0,
      send(raw: string) {
        const message = serverMessageSchema.parse(JSON.parse(raw));
        if (message.type === "notice") notices.push(message);
      },
      close() {},
    };
    hub.add(client);
    return { hub, client, notices };
  }

  it("起動時の判断待ちを見えていないタブにも通知し、作成時刻が同じ通知は再起動で増やさない", () => {
    const first = connect(1000, "initial");
    f.conversation("c", { lastActivityAt: 1000, lastSeq: 1, runState: "waiting_answer" });
    f.event("c", 1, "assistant_text", { text: "質問" }, 1000);
    f.db
      .insert(questions)
      .values({ id: "q-c", conversationId: "c", seq: 1, kind: "text", text: "どちらですか" })
      .run();
    first.hub.receive(first.client, { op: "visibility", visible: false });
    first.hub.receive(first.client, { op: "shown", topics: ["conversation:c"] });
    const next = connect(2000, "next");
    next.hub.receive(next.client, { op: "shown", topics: [] });
    expect([first.notices, next.notices, f.db.select().from(notifications).all()]).toEqual([
      [
        {
          topic: "app",
          seq: 1,
          type: "notice",
          payload: {
            level: "info",
            message: "c (project-p): どちらですか",
            notification: { tag: "conversation:c", url: "/conversations/c" },
          },
        },
      ],
      [],
      [
        {
          id: "initial",
          targetKind: "conversation",
          targetId: "c",
          reason: "question",
          title: "c (project-p)",
          body: "どちらですか",
          createdAt: 1000,
          dismissedAt: null,
        },
      ],
    ]);
  });
});
