import { releaseReservationKey, RELEASE_RESERVATION_PREFIX } from "../../../../shared/ipc";
import { Result } from "neverthrow";
import type Database from "better-sqlite3";
import { eventSchema, type ConversationEvent, type StoredEvent } from "../../../../shared/events";
import { nextRunState } from "../domain/run-state";
import { timelineInputCommentSchema } from "../../../../shared/progress/schema";
import type {
  Conversation,
  ConversationStore,
  QueuedInstruction,
  SendResult,
} from "../domain/conversation-store";
const selectConversation = `SELECT id, project_id AS projectId, kind, issue_id AS issueId, parent_conversation_id AS parentConversationId, COALESCE(title, '') AS title, session_id AS sessionId, cwd, worktree_id AS worktreeId, run_state AS runState, stop_reason AS stopReason, resets_at AS resetsAt, last_seq AS lastSeq, last_activity_at AS lastActivityAt, closed_at AS closedAt FROM conversations`;
export class SqliteConversationStore implements ConversationStore {
  private sqlite: Database.Database;
  constructor(sqlite: Database.Database) {
    this.sqlite = sqlite;
  }
  transaction<T>(operation: () => T): T {
    return this.sqlite.transaction(operation).immediate();
  }
  reserveRelease(id: string, token: string, milliseconds: number): void {
    this.sqlite
      .prepare(
        "INSERT INTO settings (key,value) VALUES (?, json_object('token', ?, 'expiresAt', unixepoch('subsec') * 1000 + ?)) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(releaseReservationKey(id), token, milliseconds);
  }
  clearRelease(id: string, token: string): Result<void, { message: string }> {
    return Result.fromThrowable(
      () => {
        this.sqlite
          .prepare("DELETE FROM settings WHERE key=? AND json_extract(value, '$.token')=?")
          .run(releaseReservationKey(id), token);
      },
      () => ({ message: "実行の予約を解除できませんでした。" }),
    )();
  }
  clearReleaseReservations(): void {
    this.sqlite
      .prepare("DELETE FROM settings WHERE key GLOB ?")
      .run(`${RELEASE_RESERVATION_PREFIX}*`);
  }
  get(id: string): Conversation | null {
    return (
      (this.sqlite.prepare(`${selectConversation} WHERE id = ?`).get(id) as
        | Conversation
        | undefined) ?? null
    );
  }
  list(): Conversation[] {
    return this.sqlite.prepare(selectConversation).all() as Conversation[];
  }
  create(c: Conversation): void {
    this.sqlite
      .prepare(
        `INSERT INTO conversations (id, project_id, kind, issue_id, parent_conversation_id, title, session_id, cwd, worktree_id, run_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.id,
        c.projectId,
        c.kind,
        c.issueId,
        c.parentConversationId,
        c.title,
        c.sessionId,
        c.cwd,
        c.worktreeId,
        c.runState,
      );
  }
  session(id: string, sessionId: string): void {
    this.sqlite.prepare("UPDATE conversations SET session_id = ? WHERE id = ?").run(sessionId, id);
  }
  events(id: string): StoredEvent[] {
    const rows = this.sqlite
      .prepare(
        "SELECT seq, type, payload, sdk_uuid AS sdkUuid, created_at AS createdAt FROM conversation_events WHERE conversation_id = ? ORDER BY seq",
      )
      .all(id) as {
      seq: number;
      type: string;
      payload: string;
      sdkUuid: string | null;
      createdAt: number;
    }[];
    return rows.map((r) => ({
      ...eventSchema.parse({ type: r.type, payload: JSON.parse(r.payload), sdkUuid: r.sdkUuid }),
      conversationId: id,
      seq: r.seq,
      createdAt: r.createdAt,
    }));
  }
  append(id: string, input: ConversationEvent, now: number): StoredEvent | null {
    const event = eventSchema.parse(input);
    const c = this.get(id);
    if (!c) throw new Error("会話がありません。");
    if (
      event.sdkUuid &&
      this.sqlite
        .prepare("SELECT 1 FROM conversation_events WHERE conversation_id = ? AND sdk_uuid = ?")
        .get(id, event.sdkUuid)
    )
      return null;
    const seq = c.lastSeq + 1;
    this.sqlite
      .prepare(
        "INSERT INTO conversation_events (conversation_id, seq, type, payload, sdk_uuid, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, seq, event.type, JSON.stringify(event.payload), event.sdkUuid ?? null, now);
    const stopReason =
      event.type === "stopped"
        ? event.payload.reason
        : event.type === "user_message" || event.type === "resumed"
          ? null
          : c.stopReason;
    const resetsAt =
      event.type === "stopped"
        ? (event.payload.resets_at ?? null)
        : event.type === "user_message" || event.type === "resumed"
          ? null
          : c.resetsAt;
    this.sqlite
      .prepare(
        "UPDATE conversations SET last_seq = ?, run_state = ?, stop_reason = ?, resets_at = ?, last_activity_at = ? WHERE id = ?",
      )
      .run(seq, nextRunState(c.runState, event), stopReason, resetsAt, now, id);
    if (event.type === "question")
      for (const [index, q] of event.payload.questions.entries())
        this.sqlite
          .prepare(
            "INSERT INTO questions (id, conversation_id, seq, kind, text, answered) VALUES (?, ?, ?, 'choice', ?, 0)",
          )
          .run(`${id}:${seq}:${index}`, id, seq, q.question);
    return { ...event, conversationId: id, seq, createdAt: now };
  }
  queue(id: string): QueuedInstruction[] {
    const rows = this.sqlite
      .prepare(
        "SELECT id, conversation_id AS conversationId, text, images, position, client_id AS clientId, created_at AS createdAt, timeline_comments AS timelineComments FROM queued_instructions WHERE conversation_id = ? ORDER BY position, rowid",
      )
      .all(id) as (Omit<QueuedInstruction, "images" | "timelineComments"> & {
      images: string;
      timelineComments: string | null;
    })[];
    return rows.map(({ timelineComments, ...r }) => ({
      ...r,
      images: JSON.parse(r.images) as string[],
      ...(timelineComments === null
        ? {}
        : {
            timelineComments: timelineInputCommentSchema
              .array()
              .parse(JSON.parse(timelineComments)),
          }),
    }));
  }
  enqueue(q: QueuedInstruction): void {
    this.sqlite
      .prepare(
        "INSERT INTO queued_instructions (id, conversation_id, text, images, position, client_id, created_at, timeline_comments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        q.id,
        q.conversationId,
        q.text,
        JSON.stringify(q.images),
        q.position,
        q.clientId,
        q.createdAt,
        q.timelineComments === undefined
          ? null
          : JSON.stringify(timelineInputCommentSchema.array().parse(q.timelineComments)),
      );
  }
  dequeue(id: string): void {
    this.sqlite.prepare("DELETE FROM queued_instructions WHERE conversation_id = ?").run(id);
  }
  duplicate(id: string, clientId: string, since: number): SendResult | null {
    const queued = this.queue(id).find((q) => q.clientId === clientId && q.createdAt >= since);
    if (queued) return { result: "queued", queuedId: queued.id };
    for (const e of this.events(id)) {
      if (e.createdAt < since || e.type !== "user_message") continue;
      const receipt = e.payload.client_receipts?.find(
        (r) => r.client_id === clientId && r.received_at >= since,
      );
      if (receipt)
        return receipt.result === "queued"
          ? { result: "queued", queuedId: receipt.queued_id }
          : { result: "delivered", seq: e.seq };
    }
    return null;
  }
  finishAnswers(id: string, questionSeq: number): void {
    this.sqlite
      .prepare("DELETE FROM pending_answers WHERE conversation_id = ? AND question_seq = ?")
      .run(id, questionSeq);
    this.sqlite
      .prepare("UPDATE questions SET answered = 1 WHERE conversation_id = ? AND seq = ?")
      .run(id, questionSeq);
  }
  clearStaleQuestions(id: string): void {
    this.sqlite.prepare("DELETE FROM pending_answers WHERE conversation_id = ?").run(id);
    this.sqlite
      .prepare(
        "UPDATE questions SET answered = 1 WHERE conversation_id = ? AND kind = 'choice' AND answered = 0",
      )
      .run(id);
  }
  saveRateLimit(value: unknown): void {
    this.sqlite
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('usage.rate_limit', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(value));
  }
  rateLimit(): unknown {
    const row = this.sqlite
      .prepare("SELECT value FROM settings WHERE key = 'usage.rate_limit'")
      .get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
}
