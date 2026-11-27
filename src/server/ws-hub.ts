import type Database from "better-sqlite3";
import type { RunnerNotice } from "../shared/ipc";
import { clientMessageSchema, type ServerMessage } from "../shared/ws";
import type { RunState, StopReason } from "../shared/events";
import type { TimelineWatch } from "./modules/conversation/adapter/timeline-watch";
import { createNotificationRepository } from "./modules/inbox/adapter/notification-repository";
import type { InboxDependencies } from "./modules/inbox/domain/ports";
import { createNotifications } from "./modules/inbox/usecase/notify";
import type { NotificationWithdrawal } from "./modules/inbox/domain/notification";
import type { NotificationPush } from "./modules/inbox/domain/push-port";

const conversationPrefix = "conversation:";

export type HubClient = { bufferedAmount: number; send(data: string): unknown; close(): unknown };
type Subscription = { after: number };
type Connection = { topics: Map<string, Subscription>; shown: Set<string>; visible: boolean };
type ConversationRow = {
  last_seq: number;
  run_state: RunState;
  stop_reason: StopReason | null;
  resets_at: number | null;
  project_id: string;
  issue_id: string | null;
};
type EventRow = {
  seq: number;
  type: string;
  payload: string;
  created_at: number;
  sdk_uuid?: string | null;
};
type NotificationOptions = {
  inbox: InboxDependencies;
  now(): number;
  id(): string;
  onError?(error: unknown): void;
  notificationPush?: NotificationPush;
};
type HubOptions = { timeline?: TimelineWatch } & (NotificationOptions | { inbox?: never });

export class WsHub {
  private clients = new Map<HubClient, Connection>();
  private seq = 0;
  private runnerConnected = false;
  private database: Database.Database;
  private notifications?: ReturnType<typeof createNotifications>;
  private snapshotPending = true;
  private notificationError?: (error: unknown) => void;
  private timeline?: TimelineWatch;
  constructor(database: Database.Database, options?: HubOptions) {
    this.database = database;
    this.timeline = options?.timeline;
    if (!options?.inbox) return;
    const { inbox } = options;
    this.notificationError = (error) => options.onError?.(error);
    this.notifications = createNotifications({
      notificationPush: options.notificationPush,
      now: () => options.now(),
      id: () => options.id(),
      inbox: {
        ...inbox,
        repository: {
          load: database.transaction((id?: string) => inbox.repository.load(id)),
        },
      },
      repository: createNotificationRepository(database),
      shown: () => this.shownTopics(),
      publish: (notification) => {
        const { tag, title, body, url } = notification;
        const message: ServerMessage = {
          topic: "app",
          seq: ++this.seq,
          type: "notice",
          payload: { level: "info", message: title + ": " + body, notification: { tag, url } },
        };
        for (const client of this.clients.keys()) this.send(client, message);
        const push = options.notificationPush;
        if (push)
          void Promise.resolve()
            .then(() => push(notification))
            .catch((error: unknown) => this.notificationError?.(error));
      },
    });
  }
  async withdrawNotifications(target: NotificationWithdrawal): Promise<void> {
    await this.notifications?.withdraw(target);
  }
  projectRemoved(id: string, at: number): void {
    this.notifications?.dismissProject(id, at);
  }
  projectRestored(id: string): void {
    this.notifications?.restoreProject(id);
  }
  private updateNotifications(update: () => void): void {
    try {
      update();
    } catch (error) {
      this.notificationError?.(error);
    }
  }
  add(client: HubClient): void {
    this.clients.set(client, { topics: new Map(), shown: new Set(), visible: true });
  }
  remove(client: HubClient): void {
    const connection = this.clients.get(client);
    this.clients.delete(client);
    for (const topic of connection?.topics.keys() ?? []) this.releaseTimeline(topic);
  }
  receive(client: HubClient, input: unknown): void {
    const parsed = clientMessageSchema.safeParse(input);
    const connection = this.clients.get(client);
    if (!parsed.success || !connection) return;
    const message = parsed.data;
    if (message.op === "subscribe") {
      const subscription = { after: message.after ?? 0 };
      if (message.topic.startsWith(conversationPrefix) && !connection.topics.has(message.topic))
        this.timeline?.retain(message.topic.slice(conversationPrefix.length));
      connection.topics.set(message.topic, subscription);
      this.replay(client, message.topic, subscription);
      if (message.topic === "app")
        this.send(client, {
          topic: "app",
          seq: ++this.seq,
          type: "runner",
          payload: { connected: this.runnerConnected },
        });
    } else if (message.op === "unsubscribe") {
      if (connection.topics.delete(message.topic)) this.releaseTimeline(message.topic);
    } else if (message.op === "shown") {
      connection.shown = new Set(
        message.topics.filter(
          (topic) => topic.startsWith("conversation:") || topic.startsWith("issue:"),
        ),
      );
      this.updateNotifications(() => {
        if (this.snapshotPending) {
          this.notifications?.refresh();
          this.snapshotPending = false;
        }
        this.notifications?.seen();
      });
    } else {
      connection.visible = message.visible;
      if (message.visible)
        this.updateNotifications(() => {
          this.notifications?.seen();
        });
    }
  }
  private releaseTimeline(topic: string): void {
    if (topic.startsWith(conversationPrefix))
      this.timeline?.release(topic.slice(conversationPrefix.length));
  }
  shownTopics(): Set<string> {
    return new Set([...this.clients.values()].flatMap((c) => (c.visible ? [...c.shown] : [])));
  }
  private send(client: HubClient, message: ServerMessage): void {
    if (client.bufferedAmount > 8 * 1024 * 1024) {
      client.close();
      this.remove(client);
      return;
    }
    client.send(JSON.stringify(message));
  }
  publish(message: ServerMessage): void {
    for (const [client, c] of this.clients)
      if (c.topics.has(message.topic)) this.send(client, message);
  }
  private replay(client: HubClient, topic: string, subscription: Subscription): void {
    const conversation = topic.startsWith("conversation:");
    if (!conversation && !topic.startsWith("issue:")) return;
    const id = topic.slice(topic.indexOf(":") + 1);
    const row = conversation
      ? (this.database.prepare("SELECT last_seq FROM conversations WHERE id=?").get(id) as
          | { last_seq: number }
          | undefined)
      : (this.database
          .prepare(
            "SELECT MAX(seq) AS last_seq FROM issue_events WHERE issue_id=? HAVING COUNT(*)>0",
          )
          .get(id) as { last_seq: number } | undefined);
    if (!row) return;
    const records = this.database
      .prepare(
        conversation
          ? "SELECT seq,type,payload,sdk_uuid,created_at FROM conversation_events WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT 1001"
          : "SELECT seq,type,payload,created_at FROM issue_events WHERE issue_id=? AND seq>? ORDER BY seq LIMIT 1001",
      )
      .all(id, subscription.after) as EventRow[];
    if (records.length > 1000) {
      this.send(client, {
        topic,
        seq: row.last_seq,
        type: "resync",
        payload: { last_seq: row.last_seq },
      });
      subscription.after = row.last_seq;
      return;
    }
    for (const record of records) {
      const payload = conversation
        ? {
            conversation_id: id,
            ...record,
            sdk_uuid: record.sdk_uuid ?? null,
            payload: JSON.parse(record.payload) as Record<string, unknown>,
          }
        : {
            issue_id: id,
            ...record,
            payload: JSON.parse(record.payload) as Record<string, unknown>,
          };
      this.send(client, { topic, seq: record.seq, type: "event", payload } as ServerMessage);
      subscription.after = record.seq;
    }
  }
  inbox(conversationIds: string[] = [], issueIds: string[] = [], projectIds: string[] = []): void {
    this.publish({
      topic: "inbox",
      seq: ++this.seq,
      type: "changed",
      payload: { conversation_ids: conversationIds, issue_ids: issueIds, project_ids: projectIds },
    });
    this.updateNotifications(() => {
      if (projectIds.length === 0) {
        if (this.clients.size > 0) {
          this.notifications?.refresh();
          this.snapshotPending = false;
        }
      } else {
        for (const id of projectIds) this.notifications?.refresh(id);
      }
    });
  }
  settingsChanged(): void {
    const message: ServerMessage = {
      topic: "app",
      seq: ++this.seq,
      type: "settings_changed",
      payload: {},
    };
    for (const client of this.clients.keys()) this.send(client, message);
  }
  ping(): void {
    const message: ServerMessage = { topic: "app", seq: ++this.seq, type: "ping", payload: {} };
    for (const client of this.clients.keys()) this.send(client, message);
  }
  connection(connected: boolean): void {
    this.runnerConnected = connected;
    if (connected) {
      for (const [client, c] of this.clients)
        for (const [topic, subscription] of c.topics) this.replay(client, topic, subscription);
      this.inbox();
    }
    this.publish({ topic: "app", seq: ++this.seq, type: "runner", payload: { connected } });
  }
  conversationParts(
    id: string,
    parts: Extract<RunnerNotice, { kind: "conversation_parts" }>["parts"],
  ) {
    const row = this.database
      .prepare("SELECT last_seq, project_id, issue_id FROM conversations WHERE id=?")
      .get(id) as Pick<ConversationRow, "last_seq" | "project_id" | "issue_id"> | undefined;
    if (row)
      this.publish({
        topic: `conversation:${id}`,
        seq: row.last_seq,
        type: "changed",
        payload: { parts },
      });
    return row;
  }
  notice(notice: RunnerNotice): void {
    if (notice.kind === "conversation") {
      const topic = `conversation:${notice.conversation_id}`;
      for (const [client, c] of this.clients) {
        const sub = c.topics.get(topic);
        if (sub) this.replay(client, topic, sub);
      }
      const row = this.database
        .prepare("SELECT run_state, stop_reason, resets_at FROM conversations WHERE id=?")
        .get(notice.conversation_id) as
        | Pick<ConversationRow, "run_state" | "stop_reason" | "resets_at">
        | undefined;
      if (row) this.publish({ topic, seq: notice.seq, type: "state", payload: row });
      this.inbox([notice.conversation_id], notice.issue_id ? [notice.issue_id] : [], [
        notice.project_id,
      ]);
    } else if (notice.kind === "delta") {
      const row = this.database
        .prepare("SELECT last_seq FROM conversations WHERE id=?")
        .get(notice.conversation_id) as { last_seq: number } | undefined;
      if (row)
        this.publish({
          topic: `conversation:${notice.conversation_id}`,
          seq: row.last_seq,
          type: "delta",
          payload: { text: notice.text },
        });
    } else if (notice.kind === "conversation_parts") {
      const row = this.conversationParts(notice.conversation_id, notice.parts);
      if (row)
        this.inbox([notice.conversation_id], row.issue_id ? [row.issue_id] : [], [row.project_id]);
    } else if (notice.kind === "issue") {
      const topic = `issue:${notice.issue_id}`;
      for (const [client, c] of this.clients) {
        const sub = c.topics.get(topic);
        if (sub) this.replay(client, topic, sub);
      }
      this.publish({ topic, seq: notice.seq, type: "changed", payload: {} });
      this.inbox([], [notice.issue_id], [notice.project_id]);
    } else if (notice.kind === "project") this.inbox([], [], [notice.project_id]);
    else {
      const { kind: _, ...payload } = notice;
      this.publish({ topic: "app", seq: ++this.seq, type: "notice", payload });
    }
  }
}
