import { queuedStockIds, queueDeliveryContextSchema } from "../../../../shared/conversation/api";
import type { ConversationDraft } from "../../../../shared/conversation/api";
import { readDraft, writeDraft } from "../../../../shared/conversation/sqlite-draft";
import { statSync } from "node:fs";
import {
  ConversationWorkspaceChanged,
  ConversationWriteBusy,
  ProjectRunBlocked,
  ProjectRunBusy,
  releaseCleanupFailure,
} from "../domain/conversation-store";
import { createWorktreeActivity } from "../../../../shared/workspace/sqlite-worktree-activity";
import type { WorktreeActivityReservation } from "../../../../shared/workspace/worktree-activity";
import { reserveProjectActivity } from "../../../../shared/project/sqlite-project-run-activity";
import {
  releaseReservationKey,
  retiredUsageTimerKey,
  RELEASE_RESERVATION_PREFIX,
  type WorkspaceSwitchAttempt,
} from "../../../../shared/ipc";
import { readPublicConversation } from "../../../../shared/conversation/sqlite-public-conversation";
import {
  readWorkspaceSwitchReceipt,
  writeWorkspaceSwitchReceipt,
} from "../../../../shared/conversation/sqlite-workspace-switch-receipts";
import { err, ok, Result } from "neverthrow";
import type Database from "better-sqlite3";
import { eventSchema, type ConversationEvent, type StoredEvent } from "../../../../shared/events";
import { nextRunState } from "../domain/run-state";
import { timelineAnchorSchema } from "../../../../shared/progress/draft";
import { timelineInputCommentSchema } from "../../../../shared/progress/schema";
import type {
  AcceptedInstruction,
  Conversation,
  ConversationStore,
  ConversationWorkspace,
  QueuedInstruction,
  ProjectRunReservation,
  ReleaseCleanupFailure,
  SendResult,
} from "../domain/conversation-store";
const acceptedInputPrefix = "runner-accepted-input:";
const selectConversation = `SELECT id, project_id AS projectId, kind, issue_id AS issueId, parent_conversation_id AS parentConversationId, COALESCE(title, '') AS title, session_id AS sessionId, cwd, worktree_id AS worktreeId, run_state AS runState, stop_reason AS stopReason, resets_at AS resetsAt, last_seq AS lastSeq, last_activity_at AS lastActivityAt, closed_at AS closedAt FROM conversations`;
export class SqliteConversationStore implements ConversationStore {
  private sqlite: Database.Database;
  private reservation: WorktreeActivityReservation | null = null;
  constructor(sqlite: Database.Database) {
    this.sqlite = sqlite;
  }
  transaction<T>(operation: () => T): T {
    try {
      return this.withReservations([], () => this.sqlite.transaction(operation).immediate());
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        (error.code === "SQLITE_BUSY" || error.code.startsWith("SQLITE_BUSY_"))
      )
        throw new ConversationWriteBusy(error);
      throw error;
    }
  }
  withWorktreeReservation<T>(operation: (reservation: WorktreeActivityReservation) => T): T {
    return this.withReservations([], () => operation(this.reservation!));
  }
  private withReservations<T>(ids: string[], operation: () => T): T {
    if (this.reservation) {
      this.reservation.acquire(ids);
      return operation();
    }
    return createWorktreeActivity(this.sqlite.name).run((reservation) => {
      this.reservation = reservation;
      try {
        reservation.acquire(ids);
        return operation();
      } finally {
        this.reservation = null;
      }
    });
  }
  private workspace(conversation: Conversation) {
    const { projectId, cwd, worktreeId } = conversation;
    const rows = this.sqlite
      .prepare(
        "SELECT id, project_id AS projectId, path, removed_at AS removedAt FROM worktrees WHERE (project_id = ? AND path = ?) OR id = ?",
      )
      .all(projectId, cwd, worktreeId) as {
      id: string;
      projectId: string;
      path: string;
      removedAt: number | null;
    }[];
    const project = this.sqlite.prepare("SELECT path FROM projects WHERE id = ?").get(projectId) as
      | { path: string }
      | undefined;
    const identified = rows.find((row) => row.id === worktreeId);
    const atPath = rows.filter((row) => row.projectId === projectId && row.path === cwd);
    const live = atPath.filter((row) => row.removedAt === null);
    const targets = [
      ...(identified ? [identified] : []),
      ...(cwd === project?.path ? [] : live.length ? live : atPath),
    ];
    return {
      ids: targets.map((row) => row.id),
      worktreeId: targets[0]?.id ?? null,
      valid:
        (!worktreeId || !!identified) &&
        targets.every(
          (row) => row.removedAt === null && row.path === cwd && row.projectId === projectId,
        ),
      tracked: targets.length > 0,
    };
  }
  private withValidWorkspace<T>(
    current: () => Conversation | null,
    operation: (worktreeId: string | null) => T,
  ): T {
    return this.withReservations([], () => {
      const held = new Set<string>();
      for (;;) {
        const conversation = current();
        if (!conversation) return operation(null);
        const workspace = this.workspace(conversation);
        const missing = workspace.ids.filter((id) => !held.has(id));
        if (missing.length) {
          this.reservation!.acquire(missing);
          for (const id of missing) held.add(id);
          continue;
        }
        if (
          !workspace.valid ||
          (workspace.tracked &&
            !statSync(conversation.cwd, { throwIfNoEntry: false })?.isDirectory())
        )
          throw new ConversationWorkspaceChanged();
        return operation(workspace.worktreeId);
      }
    });
  }
  reserveProjectRun(projectId: string): ProjectRunReservation {
    const lease = reserveProjectActivity(this.sqlite.name, projectId, "run");
    if (lease.isErr()) {
      if (lease.error.code === "conflict") throw new ProjectRunBusy();
      throw new Error(lease.error.message);
    }
    try {
      const project = this.sqlite
        .prepare("SELECT removed_at AS removedAt FROM projects WHERE id = ?")
        .get(projectId) as { removedAt: number | null } | undefined;
      if (project && project.removedAt !== null) throw new ProjectRunBlocked();
      return { projectId, release: () => lease.value.release() };
    } catch (error) {
      lease.value.release();
      throw error;
    }
  }
  withWorkspace<T>(id: string, operation: (worktreeId: string | null) => T): T {
    return this.withValidWorkspace(() => this.get(id), operation);
  }
  withWorkspaceSwitch<T>(
    id: string,
    targetWorktreeId: string | null,
    operation: (fromWorktreeIds: string[]) => T,
  ): T {
    const current = this.get(id);
    const fromWorktreeIds = current ? this.workspace(current).ids : [];
    const ids =
      targetWorktreeId === null ? fromWorktreeIds : [...fromWorktreeIds, targetWorktreeId];
    return this.withReservations(ids, () => operation(fromWorktreeIds));
  }
  switchWorkspace(
    expected: Conversation,
    target: ConversationWorkspace,
    fromWorktreeIds: string[],
    canUpdate: () => boolean,
  ): boolean {
    const current = this.get(expected.id);
    if (
      !current ||
      current.projectId !== expected.projectId ||
      current.kind !== expected.kind ||
      current.cwd !== expected.cwd ||
      current.worktreeId !== expected.worktreeId ||
      current.runState !== expected.runState ||
      this.workspace(current).ids.some((id) => !fromWorktreeIds.includes(id))
    )
      return false;
    const project = this.sqlite
      .prepare("SELECT path FROM projects WHERE id=? AND removed_at IS NULL")
      .get(current.projectId) as { path: string } | undefined;
    if (!project) return false;
    if (target.worktreeId === null) {
      if (target.cwd !== project.path) return false;
    } else {
      const destination = this.workspace({ ...current, ...target });
      if (
        !destination.valid ||
        !destination.tracked ||
        !statSync(target.cwd, { throwIfNoEntry: false })?.isDirectory()
      )
        return false;
    }
    if (!canUpdate()) return false;
    return (
      this.sqlite
        .prepare(
          "UPDATE conversations SET cwd=?,worktree_id=? WHERE id=? AND cwd=? AND worktree_id IS ?",
        )
        .run(target.cwd, target.worktreeId, current.id, expected.cwd, expected.worktreeId)
        .changes === 1
    );
  }
  workspaceSwitchSettled(attempt: WorkspaceSwitchAttempt, now: number): boolean {
    return readWorkspaceSwitchReceipt(this.sqlite, attempt, now) !== null;
  }
  recordWorkspaceSwitch(attempt: WorkspaceSwitchAttempt, id: string, now: number): void {
    const conversation = readPublicConversation(this.sqlite, id);
    if (!conversation) throw new Error("会話の作業場所を読み取れませんでした。");
    writeWorkspaceSwitchReceipt(this.sqlite, attempt, { conversationId: id, conversation }, now);
  }
  reserveRelease(id: string, token: string, milliseconds: number): void {
    this.sqlite
      .prepare(
        "INSERT INTO settings (key,value) VALUES (?, json_object('token', ?, 'expiresAt', unixepoch('subsec') * 1000 + ?)) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(releaseReservationKey(id), token, milliseconds);
  }
  clearReleaseInTransaction(id: string, token: string): Result<void, ReleaseCleanupFailure> {
    if (!this.sqlite.inTransaction) return err(releaseCleanupFailure);
    const key = releaseReservationKey(id);
    try {
      this.sqlite
        .prepare("DELETE FROM settings WHERE key=? AND json_extract(value, '$.token')=?")
        .run(key, token);
      return ok(undefined);
    } catch {
      if (!this.sqlite.inTransaction) return err(releaseCleanupFailure);
      const active = this.sqlite
        .prepare(`SELECT 1 FROM settings
          WHERE key=? AND json_extract(value, '$.token')=?
            AND json_extract(value, '$.expiresAt') > unixepoch('subsec') * 1000`)
        .get(key, token);
      return err({ ...releaseCleanupFailure, unusable: !active });
    }
  }
  isUsageTimerRetired(id: string, lastSeq: number): boolean {
    return Boolean(
      this.sqlite
        .prepare("SELECT 1 FROM settings WHERE key=? AND json_extract(value, '$')=?")
        .get(retiredUsageTimerKey(id), lastSeq),
    );
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
  projectOptions(id: string): ReturnType<ConversationStore["projectOptions"]> {
    return (
      (this.sqlite
        .prepare("SELECT model,permission_mode AS permissionMode FROM projects WHERE id=?")
        .get(id) as ReturnType<ConversationStore["projectOptions"]> | undefined) ?? {
        model: null,
        permissionMode: "bypassPermissions",
      }
    );
  }
  list(): Conversation[] {
    return this.sqlite.prepare(selectConversation).all() as Conversation[];
  }
  create(c: Conversation): void {
    this.withValidWorkspace(
      () => c,
      () => {
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
      },
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
  latestStopSeq(id: string): number | null {
    const stop = this.sqlite
      .prepare(
        "SELECT seq FROM conversation_events WHERE conversation_id = ? AND type = 'stopped' ORDER BY seq DESC LIMIT 1",
      )
      .get(id) as { seq: number } | undefined;
    return stop?.seq ?? null;
  }
  append(id: string, input: ConversationEvent, now: number): StoredEvent | null {
    return this.withWorkspace(id, () => {
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
      if (event.type === "user_message" && event.payload.origin !== "flow")
        this.sqlite
          .prepare(
            "UPDATE conversations SET title=? WHERE id=? AND kind='chat' AND (title IS NULL OR title='新しい会話') AND NOT EXISTS (SELECT 1 FROM conversation_events WHERE conversation_id=? AND type='user_message' AND seq<?)",
          )
          .run(event.payload.text.split("\n")[0]!.slice(0, 40), id, id, seq);
      if (event.type === "question")
        for (const [index, q] of event.payload.questions.entries())
          this.sqlite
            .prepare(
              "INSERT INTO questions (id, conversation_id, seq, kind, text, answered) VALUES (?, ?, ?, 'choice', ?, 0)",
            )
            .run(`${id}:${seq}:${index}`, id, seq, q.question);
      return { ...event, conversationId: id, seq, createdAt: now };
    });
  }
  stageAccepted(instruction: AcceptedInstruction): void {
    this.sqlite
      .prepare("INSERT INTO settings (key,value) VALUES (?,?)")
      .run(acceptedInputPrefix + instruction.id, JSON.stringify(instruction));
  }
  removeAccepted(id: string, deliveredSeq?: number): boolean {
    if (deliveredSeq !== undefined) {
      const row = this.sqlite
        .prepare("SELECT value FROM settings WHERE key=?")
        .get(acceptedInputPrefix + id) as { value: string } | undefined;
      if (row) {
        const instruction = JSON.parse(row.value) as AcceptedInstruction;
        this.recordStockDelivery(
          instruction.conversationId,
          queuedStockIds(instruction),
          deliveredSeq,
        );
      }
    }
    return (
      this.sqlite.prepare("DELETE FROM settings WHERE key=?").run(acceptedInputPrefix + id)
        .changes === 1
    );
  }
  recoverAccepted(id?: string): boolean {
    return this.transaction(() => {
      const rows = (
        id === undefined
          ? this.sqlite
              .prepare("SELECT value FROM settings WHERE key GLOB ?")
              .all(acceptedInputPrefix + "*")
          : this.sqlite
              .prepare("SELECT value FROM settings WHERE key=?")
              .all(acceptedInputPrefix + id)
      ) as { value: string }[];
      let restored = false;
      for (const { value } of rows) {
        const instruction = JSON.parse(value) as AcceptedInstruction;
        if (this.get(instruction.conversationId)) {
          const last = this.queue(instruction.conversationId).at(-1)?.position ?? 0;
          this.enqueue({ ...instruction, position: last + 1 });
          restored = true;
        }
        this.removeAccepted(instruction.id);
      }
      return restored;
    });
  }
  draft(id: string): ConversationDraft | null {
    return readDraft(this.sqlite, id);
  }
  writeDraft(id: string, draft: ConversationDraft): void {
    writeDraft(this.sqlite, id, draft);
  }
  queue(id: string): QueuedInstruction[] {
    const rows = this.sqlite
      .prepare(
        "SELECT id, conversation_id AS conversationId, text, images, position, client_id AS clientId, created_at AS createdAt, timeline_comments AS timelineComments, timeline_anchors AS timelineAnchors, stock_item_id AS stockItemId, delivery_context AS deliveryContext FROM queued_instructions WHERE conversation_id = ? ORDER BY position, rowid",
      )
      .all(id) as (Omit<
      QueuedInstruction,
      "images" | "timelineComments" | "timelineAnchors" | "stockItemId" | "deliveryContext"
    > & {
      images: string;
      timelineComments: string | null;
      timelineAnchors: string | null;
      stockItemId: string | null;
      deliveryContext: string | null;
    })[];
    return rows.map(
      ({ timelineComments, timelineAnchors, stockItemId, deliveryContext, ...r }) => ({
        ...r,
        ...(timelineAnchors === null
          ? {}
          : { timelineAnchors: timelineAnchorSchema.array().parse(JSON.parse(timelineAnchors)) }),
        ...(stockItemId === null ? {} : { stockItemId }),
        ...(deliveryContext === null
          ? {}
          : {
              deliveryContext: queueDeliveryContextSchema.parse(JSON.parse(deliveryContext)),
            }),
        images: JSON.parse(r.images) as string[],
        ...(timelineComments === null
          ? {}
          : {
              timelineComments: timelineInputCommentSchema
                .array()
                .parse(JSON.parse(timelineComments)),
            }),
      }),
    );
  }
  enqueue(q: QueuedInstruction): void {
    this.sqlite
      .prepare(
        "INSERT INTO queued_instructions (id, conversation_id, text, images, position, client_id, created_at, timeline_comments, stock_item_id, timeline_anchors, delivery_context) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        q.stockItemId ?? null,
        q.timelineAnchors ? JSON.stringify(q.timelineAnchors) : null,
        q.deliveryContext ? JSON.stringify(q.deliveryContext) : null,
      );
  }
  recordStockDelivery(id: string, stocks: readonly string[], seq: number): void {
    if (!stocks.length) return;
    const sent = this.sqlite.prepare(
      "UPDATE stock_items SET sent_seq=? WHERE id=? AND conversation_id=? AND state='sent' AND sent_seq IS NULL",
    );
    for (const stock of stocks) sent.run(seq, stock, id);
  }
  dequeue(id: string, deliveredSeq?: number): void {
    if (deliveredSeq !== undefined)
      this.recordStockDelivery(
        id,
        this.queue(id).flatMap((item) => [...queuedStockIds(item)]),
        deliveredSeq,
      );
    this.sqlite.prepare("DELETE FROM queued_instructions WHERE conversation_id = ?").run(id);
  }
  duplicate(id: string, clientId: string, since: number): SendResult | null {
    for (const queued of this.queue(id)) {
      if (queued.clientId === clientId && queued.createdAt >= since)
        return { result: "queued", queuedId: queued.id };
      const previous = queued.deliveryContext?.receipts?.find(
        (receipt) => receipt.clientId === clientId && receipt.createdAt >= since,
      );
      if (previous) return { result: "queued", queuedId: previous.queuedId };
    }
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
  isUnanswered(id: string, questionSeq: number): boolean {
    return (
      this.sqlite
        .prepare(
          "SELECT 1 FROM questions WHERE conversation_id=? AND seq=? AND kind='choice' AND answered=0 LIMIT 1",
        )
        .get(id, questionSeq) !== undefined
    );
  }
  finishAnswers(id: string, questionSeq: number): void {
    this.sqlite
      .prepare("DELETE FROM pending_answers WHERE conversation_id = ? AND question_seq = ?")
      .run(id, questionSeq);
    this.sqlite
      .prepare("UPDATE questions SET answered = 1 WHERE conversation_id = ? AND seq = ?")
      .run(id, questionSeq);
  }
  clearQuestionsBefore(id: string, startSeq: number): void {
    this.sqlite
      .prepare("DELETE FROM pending_answers WHERE conversation_id = ? AND question_seq < ?")
      .run(id, startSeq);
    this.sqlite
      .prepare(
        "UPDATE questions SET answered = 1 WHERE conversation_id = ? AND seq < ? AND kind = 'choice' AND answered = 0",
      )
      .run(id, startSeq);
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
