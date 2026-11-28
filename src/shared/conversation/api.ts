import { z } from "zod";
import { answersSchema, type Answers, type RunState, type StopReason } from "../events";
import { timelineInputCommentSchema } from "../progress/schema";
import { queueDraftContent, timelineAnchorSchema, validTimelineAnchors } from "../progress/draft";

export const draftReceiptSchema = z
  .strictObject({
    text: z.string(),
    images: z.array(z.string()),
    timeline_anchors: z.array(timelineAnchorSchema).optional(),
    updatedAt: z.number().int().nonnegative(),
    updatedBy: z.string(),
  })
  .refine(validTimelineAnchors);
export const restoreConversationDraftSchema = z
  .strictObject({
    expected: draftReceiptSchema.nullable(),
    replacement: draftReceiptSchema,
  })
  .refine(
    ({ expected, replacement }) => expected === null || replacement.updatedAt > expected.updatedAt,
  );
export type RestoreConversationDraft = z.infer<typeof restoreConversationDraftSchema>;

export const sendConversationMessageSchema = z
  .object({
    text: z.string().max(100000),
    images: z.array(z.string()).max(20),
    mode: z.enum(["send", "interrupt"]),
    clientMessageId: z.string().min(1),
    timeline_comments: z.array(timelineInputCommentSchema).optional(),
    timeline_anchors: z.array(timelineAnchorSchema).optional(),
    preserveDraft: z.literal(true).optional(),
    stockIds: z.array(z.string().min(1)).min(1).optional(),
    restoreDraft: restoreConversationDraftSchema.optional(),
  })
  .refine(validTimelineAnchors)
  .refine(
    ({ restoreDraft, preserveDraft, mode }) =>
      !restoreDraft || (preserveDraft === true && mode === "send"),
  );

export const conversationContentSchema = z.object({
  text: z.string().max(100000),
  images: z.array(z.string().min(1)).max(20),
});
export const startPublicConversationSchema = z.object({
  projectId: z.string().min(1),
  workspace: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("project") }),
    z.object({ kind: z.literal("new_worktree"), name: z.string().optional() }),
    z.object({ kind: z.literal("worktree"), worktreeId: z.string().min(1) }),
  ]),
});
export type ConversationWorkspaceChoice = z.infer<
  typeof startPublicConversationSchema
>["workspace"];
export const switchPublicWorkspaceSchema = z.object({ worktreeId: z.string().min(1).nullable() });
export const editableConversationContentSchema = conversationContentSchema.extend({
  timeline_anchors: z.array(timelineAnchorSchema).optional(),
});
export const saveConversationDraftSchema = editableConversationContentSchema
  .extend({
    clientId: z.string().min(1),
    editedAt: z.number().int().nonnegative(),
    expectedDraft: draftReceiptSchema.optional(),
  })
  .refine(validTimelineAnchors);
export const saveConversationAnswersSchema = z.object({
  questionSeq: z.number().int().positive(),
  answers: answersSchema,
});
export const sendConversationAnswersSchema = z.object({ confirmUnanswered: z.boolean() });
export const permissionDecisionSchema = z.object({ decision: z.enum(["allow", "deny"]) });
export const eventPageSchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(2000).default(2000),
});
export type ConversationContent = z.infer<typeof editableConversationContentSchema>;
export type ConversationMessage = z.infer<typeof sendConversationMessageSchema>;
export type ConversationDraft = z.infer<typeof draftReceiptSchema>;
export type ConversationDraftRequest = z.infer<typeof saveConversationDraftSchema>;

export function draftReceipt({
  text,
  images,
  timeline_anchors,
  clientId,
  editedAt,
}: ConversationDraftRequest): ConversationDraft {
  return {
    text,
    images,
    ...(timeline_anchors === undefined ? {} : { timeline_anchors }),
    updatedAt: editedAt,
    updatedBy: clientId,
  };
}

export function sameDraftReceipt(
  left: ConversationDraft | null,
  right: ConversationDraft | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.updatedAt === right.updatedAt &&
    left.updatedBy === right.updatedBy &&
    left.text === right.text &&
    left.images.length === right.images.length &&
    left.images.every((id, index) => id === right.images[index]) &&
    JSON.stringify(left.timeline_anchors) === JSON.stringify(right.timeline_anchors)
  );
}
export type PendingAnswers = { questionSeq: number; answers: Answers };
export type PublicConversation = {
  id: string;
  projectId: string;
  projectName: string;
  kind: string;
  issueId: string | null;
  parentConversationId: string | null;
  title: string;
  cwd: string;
  worktree: { id: string; name: string; branch: string } | null;
  runState: RunState;
  stopReason: StopReason | null;
  resetsAt: number | null;
  lastSeq: number;
  lastReadSeq: number;
  lastPosition: number | null;
  closedAt: number | null;
};

export type ConversationSnapshot = {
  conversation: PublicConversation;
  draft: ConversationDraft | null;
  queue: ConversationQueueItem[];
  pendingAnswers: PendingAnswers | null;
  pendingPermission: { requestId: string; seq: number; toolName: string; summary: string } | null;
  commands: { name: string; description: string }[];
};
export type ConversationEventsPage = {
  events: (import("../events").ConversationEvent & {
    seq: number;
    createdAt: number;
    missingImages?: number;
  })[];
  lastSeq: number;
  hasMore: boolean;
};

export const queueDeliveryContextSchema = z.object({
  stockIds: z.array(z.string()).optional(),
  original: z
    .object({
      text: z.string(),
      images: z.array(z.string()),
      timeline_anchors: z.array(timelineAnchorSchema).optional(),
    })
    .refine(validTimelineAnchors)
    .optional(),
  receipts: z
    .array(
      z.object({
        clientId: z.string(),
        queuedId: z.string(),
        createdAt: z.number().int(),
      }),
    )
    .optional(),
  legacyTexts: z.array(z.string()).optional(),
  queuedIds: z.array(z.string()).optional(),
  originalRanges: z
    .array(
      z.object({
        from: z.number().int().nonnegative(),
        to: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});
export type QueueDeliveryContext = z.infer<typeof queueDeliveryContextSchema>;

export function queuedStockIds(item: {
  deliveryContext?: QueueDeliveryContext;
  stockItemId?: string | null;
}): readonly string[] {
  return item.deliveryContext?.stockIds ?? (item.stockItemId ? [item.stockItemId] : []);
}

export function queuedDraftContent(item: ConversationQueueItem): ConversationContent | null {
  const draft = item.deliveryContext
    ? item.deliveryContext.original
    : item.stockItemId
      ? undefined
      : queueDraftContent(item);
  return draft && (draft.text || draft.images.length) ? draft : null;
}

export type ConversationQueueItem = ConversationContent & {
  id: string;
  position: number;
  stockItemId: string | null;
  deliveryContext?: QueueDeliveryContext;
  clientId: string | null;
  createdAt: number;
  timeline_comments?: import("../progress/schema").TimelineInputComment[];
};
