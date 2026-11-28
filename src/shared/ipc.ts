import { stockSendSchema } from "./stock";
import { designCommitSchema } from "./api/design";
import { z } from "zod";
import { recapStateSchema } from "./recap/api";
import { answersSchema, originSchema, runStateSchema } from "./events";
import { timelineInputCommentSchema } from "./progress/schema";
import { timelineAnchorSchema, validTimelineAnchors } from "./progress/draft";
import { restoreConversationDraftSchema, type PublicConversation } from "./conversation/api";

export const RUNNER_IPC_TIMEOUT_MS = 10_000;
export const RUNNER_IPC_DEADLINE_HEADER = "x-sukuna-ipc-deadline";

export const unavailableRunnerError = {
  code: "runner_unavailable",
  message: "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
} as const;

export function runnerCallerCancelled(request: Request, now: () => number) {
  const deadline = Number(request.headers.get(RUNNER_IPC_DEADLINE_HEADER) ?? NaN);
  return () => request.signal.aborted || (Number.isSafeInteger(deadline) && now() >= deadline);
}

export const designRejectionDraftSchema = z.strictObject({
  text: z.string(),
  images: z.array(z.string()),
  timeline_anchors: z.array(timelineAnchorSchema).optional(),
  updatedAt: z.number().int(),
  updatedBy: z.string(),
});
export type DesignRejectionDraft = z.infer<typeof designRejectionDraftSchema>;

export const startConversationSchema = z.object({
  project_id: z.string().min(1),
  kind: z.enum(["chat", "triage", "design", "impl", "thread"]),
  cwd: z.string().min(1),
  title: z.string(),
  message: z.string().optional(),
  worktree_id: z.string().nullable().optional(),
  issue_id: z.string().nullable().optional(),
  parent_conversation_id: z.string().nullable().optional(),
});
export const sendMessageSchema = z
  .object({
    receipt_metadata: z.boolean().optional(),
    restore_draft: restoreConversationDraftSchema.optional(),
    stock_ids: z.array(z.string().min(1)).min(1).optional(),
    text: z.string(),
    images: z.array(z.string()),
    interrupt: z.boolean(),
    client_id: z.string().min(1),
    origin: originSchema,
    timeline_comments: z.array(timelineInputCommentSchema).optional(),
    timeline_anchors: z.array(timelineAnchorSchema).optional(),
  })
  .refine(validTimelineAnchors)
  .refine(
    ({ restore_draft, origin, interrupt }) =>
      !restore_draft || (origin === "developer" && !interrupt),
  );
export const forkConversationSchema = z.object({ title: z.string(), kind: z.literal("thread") });
export const answerSchema = z.object({
  request_id: z.string(),
  question_seq: z.number().int().positive().optional(),
  answers: answersSchema,
});
export const checkedAnswerSchema = answerSchema.required({ question_seq: true });
export const permissionSchema = z.object({
  behavior: z.enum(["allow", "deny"]),
  message: z.string().optional(),
});
export const WORKSPACE_SWITCH_RECEIPT_TTL_MS = 60_000;
export const workspaceSwitchAttemptSchema = z.object({
  id: z.uuid(),
  expires_at: z.number().int().positive(),
});
export type WorkspaceSwitchAttempt = z.infer<typeof workspaceSwitchAttemptSchema>;
export type WorkspaceSwitchReceipt = {
  conversationId: string;
  conversation: PublicConversation | null;
};
export const workspaceSchema = z.object({
  cwd: z.string().min(1),
  worktree_id: z.string().min(1).nullable().optional(),
  attempt: workspaceSwitchAttemptSchema.optional(),
});
export const projectStopResponseSchema = z.object({
  stopped_conversation_ids: z.array(z.string()),
});
export const flowNotifySchema = z.object({
  project_id: z.string().optional(),
  issue_id: z.string().optional(),
});
export const TERMINAL_CLEANUP_HEADER = "x-sukuna-terminal-cleanup";
export const terminalCleanupRequestSchema = z.strictObject({
  request_id: z.uuid(),
  worktree_id: z.string().min(1),
  directory_key: z.string().regex(/^\d+:\d+$/),
  path: z.string().min(1),
  expires_at: z.number().int().nonnegative(),
});
export type TerminalCleanupRequest = z.infer<typeof terminalCleanupRequestSchema>;
export const terminalCleanupReplySchema = terminalCleanupRequestSchema
  .pick({ request_id: true, worktree_id: true, directory_key: true })
  .extend({ step: z.enum(["claim", "closed", "defer"]) });

export const runnerNoticeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("conversation"),
    conversation_id: z.string(),
    seq: z.number().int().nonnegative(),
    run_state: runStateSchema,
    project_id: z.string(),
    issue_id: z.string().nullable(),
  }),
  z.object({ kind: z.literal("delta"), conversation_id: z.string(), text: z.string() }),
  z.object({
    kind: z.literal("conversation_parts"),
    conversation_id: z.string(),
    parts: z.array(z.enum(["queue", "answers", "draft", "recap", "stock", "threads"])),
  }),
  z.object({
    kind: z.literal("issue"),
    issue_id: z.string(),
    project_id: z.string(),
    seq: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal("project"), project_id: z.string() }),
  terminalCleanupRequestSchema.extend({ kind: z.literal("worktree_terminal_close") }),
  z.object({
    kind: z.literal("notice"),
    level: z.enum(["info", "error"]),
    message: z.string(),
    conversation_id: z.string().optional(),
    issue_id: z.string().optional(),
  }),
]);
export type RunnerNotice = z.infer<typeof runnerNoticeSchema>;

export const STOCK_SEND_SETTLEMENT_TIMEOUT_MS = 20_000;
export const sendStockIpcSchema = stockSendSchema.extend({ attempt_id: z.uuid().optional() });
export type StockSendIpcInput = z.infer<typeof sendStockIpcSchema>;
export const threadProposalIpcResponseSchema = z.strictObject({
  run_state: z.literal("working"),
  proposal_seq: z.number().int().positive().optional(),
});
export const reserveReleaseSchema = z.preprocess(
  (input) => (input === undefined ? {} : input),
  z.strictObject({ idle_only: z.boolean().optional(), only_idle: z.boolean().optional() }),
);
export const releaseReservationSchema = z.object({ token: z.string().min(1) });
export const completeReleaseSchema = z.object({ token: z.string().min(1) });
export const RELEASE_RESERVATION_PREFIX = "runner-release:";
export const releaseReservationKey = (id: string) => `${RELEASE_RESERVATION_PREFIX}${id}`;
export const retiredUsageTimerKey = (id: string) => `conversation-usage-retired:${id}`;

export const issuePatchIpcSchema = z.strictObject({
  parent_number: z.number().int().positive().nullable().optional(),
  depends_on: z.array(z.number().int().positive()).max(50).optional(),
  priority: z.enum(["high", "medium", "low"]).nullable().optional(),
  confirm_before_merge: z.boolean().optional(),
});
export const rebuildRecapResponseSchema = z.strictObject({ state: recapStateSchema });

export const allowMergeIpcSchema = z.strictObject({
  head_sha: z.string().regex(/^[a-f0-9]{40}$/i),
});
export const approveDesignIpcSchema = z.strictObject({ head_commit: designCommitSchema });
export const rejectDesignIpcSchema = z.strictObject({
  text: z.string().max(20_000),
  attachment: z.string().optional(),
  draft: designRejectionDraftSchema.optional(),
});
