import { readDraft, writeDraft } from "../../../../shared/conversation/sqlite-draft";
import type Database from "better-sqlite3";
import { readPublicConversation } from "../../../../shared/conversation/sqlite-public-conversation";
import {
  hasQuestionBefore,
  wasQuestionSuperseded,
} from "../../../../shared/conversation/sqlite-question";
import {
  readWorkspaceSwitchReceipt,
  writeWorkspaceSwitchReceipt,
} from "../../../../shared/conversation/sqlite-workspace-switch-receipts";
import { eventSchema } from "../../../../shared/events";
import { answersSchema } from "../../../../shared/events";
import {
  queueDeliveryContextSchema,
  type PendingAnswers,
} from "../../../../shared/conversation/api";
import type { ConversationRepository } from "../domain/ports";
import type { QueueItem } from "../domain/message-port";
import { commentsFromAnchors, timelineAnchorSchema } from "../../../../shared/progress/draft";
import { timelineInputCommentSchema } from "../../../../shared/progress/schema";
export function createConversationRepository(sqlite: Database.Database): ConversationRepository {
  const queue = (id: string): QueueItem[] =>
    (
      sqlite
        .prepare(
          "SELECT id,text,images,position,stock_item_id AS stockItemId,client_id AS clientId,created_at AS createdAt,timeline_comments AS comments,timeline_anchors AS anchors,delivery_context AS deliveryContext FROM queued_instructions WHERE conversation_id=? ORDER BY position,rowid",
        )
        .all(id) as (Omit<QueueItem, "images" | "deliveryContext"> & {
        images: string;
        comments: string | null;
        anchors: string | null;
        deliveryContext: string | null;
      })[]
    ).map(({ images, comments, anchors, deliveryContext, ...row }) => ({
      ...row,
      images: JSON.parse(images) as string[],
      ...(deliveryContext === null
        ? {}
        : {
            deliveryContext: queueDeliveryContextSchema.parse(JSON.parse(deliveryContext)),
          }),
      ...(anchors === null
        ? {}
        : { timeline_anchors: timelineAnchorSchema.array().parse(JSON.parse(anchors)) }),
      ...(comments === null
        ? {}
        : { timeline_comments: timelineInputCommentSchema.array().parse(JSON.parse(comments)) }),
    }));
  const events: ConversationRepository["events"] = (id, after = 0, limit = 2001) =>
    (
      sqlite
        .prepare(
          "SELECT seq,type,payload,sdk_uuid AS sdkUuid,created_at AS createdAt FROM conversation_events WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?",
        )
        .all(id, after, limit) as {
        seq: number;
        type: string;
        payload: string;
        sdkUuid: string | null;
        createdAt: number;
      }[]
    ).map((row) => ({
      ...eventSchema.parse({
        type: row.type,
        payload: JSON.parse(row.payload),
        sdkUuid: row.sdkUuid,
      }),
      conversationId: id,
      seq: row.seq,
      createdAt: row.createdAt,
    }));
  return {
    transaction: (operation) => sqlite.transaction(operation).immediate(),
    project: (id) =>
      (sqlite.prepare("SELECT id,path FROM projects WHERE id=? AND removed_at IS NULL").get(id) as
        | { id: string; path: string }
        | undefined) ?? null,
    conversation: (id) => readPublicConversation(sqlite, id),
    workspaceSwitchReceipt: (attempt, now) => readWorkspaceSwitchReceipt(sqlite, attempt, now),
    cancelWorkspaceSwitch: (id, attempt, now) =>
      writeWorkspaceSwitchReceipt(sqlite, attempt, { conversationId: id, conversation: null }, now),
    draft: (id) => readDraft(sqlite, id),
    writeDraft: (id, draft) => writeDraft(sqlite, id, draft),
    queue,
    editQueue: (id, itemId, input, context) => {
      const anchors = input.timeline_anchors;
      const images = JSON.stringify(input.images);
      const delivery = context ? JSON.stringify(context) : null;
      const result =
        anchors === undefined
          ? sqlite
              .prepare(
                "UPDATE queued_instructions SET text=?,images=?,timeline_anchors=CASE WHEN text=? THEN timeline_anchors ELSE NULL END,delivery_context=COALESCE(?,delivery_context) WHERE conversation_id=? AND id=?",
              )
              .run(input.text, images, input.text, delivery, id, itemId)
          : sqlite
              .prepare(
                "UPDATE queued_instructions SET text=?,images=?,timeline_anchors=?,timeline_comments=?,delivery_context=COALESCE(?,delivery_context) WHERE conversation_id=? AND id=?",
              )
              .run(
                input.text,
                images,
                JSON.stringify(anchors),
                JSON.stringify(commentsFromAnchors(input.text, anchors)),
                delivery,
                id,
                itemId,
              );
      return result.changes ? (queue(id).find((item) => item.id === itemId) ?? null) : null;
    },
    removeQueue: (id, itemId) => {
      const item = queue(id).find((entry) => entry.id === itemId);
      if (!item) return null;
      sqlite
        .prepare("DELETE FROM queued_instructions WHERE conversation_id=? AND id=?")
        .run(id, itemId);
      return item;
    },
    returnStock: (id) => {
      sqlite
        .prepare(
          "UPDATE stock_items SET state='stocked',sent_at=NULL,sent_seq=NULL WHERE id=? AND state='sent' AND sent_seq IS NULL",
        )
        .run(id);
    },
    events,
    unansweredQuestion: (id) => {
      const row = sqlite
        .prepare(
          "SELECT MAX(seq) AS seq FROM questions WHERE conversation_id=? AND kind='choice' AND answered=0",
        )
        .get(id) as { seq: number | null };
      if (row.seq === null || wasQuestionSuperseded(sqlite, id, row.seq)) return null;
      const event = events(id, row.seq - 1, 1)[0];
      return event?.type === "question" ? event : null;
    },
    hasQuestionBefore: (id, beforeSeq) => hasQuestionBefore(sqlite, id, beforeSeq),
    pendingAnswers: (id) => {
      const row = sqlite
        .prepare(
          "SELECT question_seq AS questionSeq,answers FROM pending_answers WHERE conversation_id=? ORDER BY question_seq DESC LIMIT 1",
        )
        .get(id) as { questionSeq: number; answers: string } | undefined;
      if (!row || wasQuestionSuperseded(sqlite, id, row.questionSeq)) return null;
      return {
        questionSeq: row.questionSeq,
        answers: answersSchema.parse(JSON.parse(row.answers)),
      };
    },
    saveAnswers: (id, pending: PendingAnswers, now) => {
      sqlite
        .prepare(
          "INSERT INTO pending_answers (conversation_id,question_seq,answers,updated_at) VALUES (?,?,?,?) ON CONFLICT(conversation_id,question_seq) DO UPDATE SET answers=excluded.answers,updated_at=excluded.updated_at",
        )
        .run(id, pending.questionSeq, JSON.stringify(pending.answers), now);
    },
    reopen: (id) => {
      const row = sqlite
        .prepare(
          "SELECT parent_conversation_id AS parent FROM conversations WHERE id=? AND kind='thread'",
        )
        .get(id) as { parent: string | null } | undefined;
      const changed: string[] = [];
      for (const target of [id, ...(row?.parent ? [row.parent] : [])])
        if (
          sqlite
            .prepare("UPDATE conversations SET closed_at=NULL WHERE id=? AND closed_at IS NOT NULL")
            .run(target).changes
        )
          changed.push(target);
      return changed;
    },
  };
}
