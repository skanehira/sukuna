import type { Result } from "neverthrow";
import type { WorkspaceSwitchAttempt, WorkspaceSwitchReceipt } from "../../../../shared/ipc";
import type {
  ConversationContent,
  QueueDeliveryContext,
  ConversationDraft,
  PublicConversation,
  PendingAnswers,
} from "../../../../shared/conversation/api";
import type { StoredEvent } from "../../../../shared/events";
import type { QueueItem, MessageDependencies } from "./message-port";
export type ConversationError = {
  code:
    | "not_found"
    | "invalid_input"
    | "conflict"
    | "unanswered_questions"
    | "answers_changed"
    | "internal"
    | "runner_unavailable"
    | "worktree_failed";
  message: string;
};
type ConversationWorktree = { id: string; path: string };
export interface ConversationWorktrees {
  find(projectId: string, id: string): Promise<Result<ConversationWorktree, ConversationError>>;
  create(
    projectId: string,
    name?: string,
  ): Promise<Result<ConversationWorktree & { notice: string | null }, ConversationError>>;
}
export interface ConversationRepository {
  transaction<T>(operation: () => T): T;
  project(id: string): { id: string; path: string } | null;
  conversation(id: string): PublicConversation | null;
  workspaceSwitchReceipt(
    attempt: WorkspaceSwitchAttempt,
    now: number,
  ): WorkspaceSwitchReceipt | null;
  cancelWorkspaceSwitch(id: string, attempt: WorkspaceSwitchAttempt, now: number): void;
  draft(id: string): ConversationDraft | null;
  writeDraft(id: string, draft: ConversationDraft): void;
  queue(id: string): QueueItem[];
  editQueue(
    id: string,
    itemId: string,
    input: ConversationContent,
    context?: QueueDeliveryContext,
  ): QueueItem | null;
  removeQueue(id: string, itemId: string): QueueItem | null;
  returnStock(id: string): void;
  events(id: string, after?: number, limit?: number): StoredEvent[];
  unansweredQuestion(id: string): Extract<StoredEvent, { type: "question" }> | null;
  hasQuestionBefore(id: string, beforeSeq: number): boolean;
  pendingAnswers(id: string): PendingAnswers | null;
  saveAnswers(id: string, pending: PendingAnswers, now: number): void;
  reopen(id: string): string[];
}
export type ImageStorage = {
  save(
    conversationId: string,
    imageId: string,
    mediaType: string,
    data: Uint8Array,
  ): Result<void, ConversationError>;
  read(
    conversationId: string,
    imageId: string,
  ): Result<{ mediaType: string; data: Uint8Array<ArrayBuffer> }, ConversationError>;
  exists(path: string): boolean;
};
export type ConversationDependencies = {
  repository: ConversationRepository;
  runner: MessageDependencies["runner"];
  images: ImageStorage;
  id(): string;
  workspaceSwitchAttempt(): WorkspaceSwitchAttempt;
  now(): number;
  changed(id: string, parts: ("draft" | "queue" | "answers" | "stock")[]): void;
  reopened(ids: string[]): void;
  notice?(id: string, message: string): void;
};
export const emptyDraft = (draft: ConversationDraft | null): ConversationDraft | null =>
  draft && (draft.text || draft.images.length) ? draft : null;
export const missingConversation: ConversationError = {
  code: "not_found",
  message: "会話が見つかりません。",
};
export const missingImage: ConversationError = {
  code: "not_found",
  message: "画像が見つかりません。",
};
