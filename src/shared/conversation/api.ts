import { z } from "zod";
import { answersSchema, type Answers, type RunState, type StopReason } from "../events";
import { timelineInputCommentSchema } from "../progress/schema";

export const sendConversationMessageSchema = z.object({
  text: z.string().max(100000),
  images: z.array(z.string()).max(20),
  mode: z.enum(["send", "interrupt"]),
  clientMessageId: z.string().min(1),
  timeline_comments: z.array(timelineInputCommentSchema).optional(),
});

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
export const saveConversationDraftSchema = conversationContentSchema.extend({
  clientId: z.string().min(1),
  editedAt: z.number().int().nonnegative(),
});
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
export type ConversationContent = z.infer<typeof conversationContentSchema>;
export type ConversationDraft = ConversationContent & { updatedAt: number; updatedBy: string };
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

export type ConversationQueueItem = ConversationContent & {
  id: string;
  position: number;
  stockItemId: string | null;
  clientId: string | null;
  createdAt: number;
  timeline_comments?: import("../progress/schema").TimelineInputComment[];
};
