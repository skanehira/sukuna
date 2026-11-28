import { beforeEach, afterEach } from "vite-plus/test";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
  type OpenedDatabase,
} from "../../../shared/db/test-helpers";
import {
  projects,
  conversations,
  conversationEvents,
  issues,
  issueEvents,
} from "../../../shared/db/schema";
import { createApp } from "../../app";
import { incomingWith } from "../identity/test-support";
import { createInboxRepository } from "./adapter/inbox-repository";
import type { InboxRow } from "../../../shared/inbox/schema";
export function inboxFixture() {
  let opened: OpenedDatabase;
  let home: string;
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    home = createTempHome();
    opened = openMigratedDatabase(home);
    opened.db
      .insert(projects)
      .values([
        { id: "p", name: "project-p", path: "/p", defaultBranch: "main" },
        { id: "q", name: "project-q", path: "/q", defaultBranch: "main" },
      ])
      .run();
    app = createApp({
      build: "test",
      inbox: { repository: createInboxRepository(() => opened.db), resetTime: () => "12:34" },
    });
  });
  afterEach(() => {
    opened?.close();
    if (home) removeTempHome(home);
  });
  return {
    get db() {
      return opened.db;
    },
    get sqlite() {
      return opened.sqlite;
    },
    request(path: string, ip = "127.0.0.1") {
      return app.request(path, {}, incomingWith(ip, 5000));
    },
    conversation(id: string, values: Partial<typeof conversations.$inferInsert> = {}) {
      opened.db
        .insert(conversations)
        .values({
          id,
          projectId: "p",
          kind: "chat",
          cwd: "/p",
          title: id,
          lastActivityAt: 100,
          ...values,
        })
        .run();
    },
    issue(id: string, number: number, values: Partial<typeof issues.$inferInsert> = {}) {
      opened.db
        .insert(issues)
        .values({
          id,
          projectId: "p",
          number,
          title: id,
          state: "triage",
          createdAt: 10,
          updatedAt: 10,
          ...values,
        })
        .run();
    },
    event(
      conversationId: string,
      seq: number,
      type: string,
      payload: unknown = {},
      createdAt = 100,
    ) {
      opened.db
        .insert(conversationEvents)
        .values({ conversationId, seq, type, payload, createdAt })
        .run();
    },
    issueEvent(issueId: string, seq: number, type: string, payload: unknown, createdAt = 100) {
      opened.db.insert(issueEvents).values({ issueId, seq, type, payload, createdAt }).run();
    },
  };
}
export function expectedRow(values: Partial<InboxRow>): InboxRow {
  return {
    key: "conversation:c",
    kind: "conversation",
    id: "c",
    project: { id: "p", name: "project-p" },
    title: "会話: c",
    section: "instruction",
    reason: "turn_ended",
    status: "",
    notice: "",
    unread: false,
    priority: null,
    lastActivityAt: 100,
    threadAnswers: 0,
    activity: null,
    issue: null,
    ...values,
  };
}
