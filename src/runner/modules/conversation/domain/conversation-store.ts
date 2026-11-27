import type { WorktreeActivityReservation } from "../../../../shared/workspace/worktree-activity";
import type { Result } from "neverthrow";
import type {
  ConversationEvent,
  RunState,
  StopReason,
  StoredEvent,
} from "../../../../shared/events";
import type { TimelineInputComment } from "../../../../shared/progress/schema";
export type ConversationKind = "chat" | "triage" | "design" | "impl" | "thread";
export type Conversation = {
  id: string;
  projectId: string;
  kind: ConversationKind;
  issueId: string | null;
  parentConversationId: string | null;
  title: string;
  sessionId: string | null;
  cwd: string;
  worktreeId: string | null;
  runState: RunState;
  stopReason: StopReason | null;
  resetsAt: number | null;
  lastSeq: number;
  lastActivityAt: number | null;
  closedAt: number | null;
};
export type QueuedInstruction = {
  id: string;
  conversationId: string;
  text: string;
  images: string[];
  timelineComments?: TimelineInputComment[];
  position: number;
  clientId: string | null;
  createdAt: number;
  stockItemId?: string;
};
export type SendResult =
  | { result: "delivered"; seq: number }
  | { result: "queued"; queuedId: string };
export interface ConversationStore {
  transaction<T>(operation: () => T): T;
  withWorktreeReservation<T>(operation: (reservation: WorktreeActivityReservation) => T): T;
  withWorkspace<T>(id: string, operation: (worktreeId: string | null) => T): T;
  get(id: string): Conversation | null;
  projectOptions(id: string): {
    model: "opus" | "sonnet" | "haiku" | null;
    permissionMode: "bypassPermissions" | "acceptEdits" | "default";
  };
  list(): Conversation[];
  create(conversation: Conversation): void;
  session(id: string, sessionId: string): void;
  events(id: string): StoredEvent[];
  latestStopSeq(id: string): number | null;
  append(id: string, event: ConversationEvent, now: number): StoredEvent | null;
  queue(id: string): QueuedInstruction[];
  enqueue(instruction: QueuedInstruction): void;
  dequeue(id: string, deliveredSeq: number): void;
  duplicate(id: string, clientId: string, since: number): SendResult | null;
  isUnanswered(id: string, questionSeq: number): boolean;
  finishAnswers(id: string, questionSeq: number): void;
  clearQuestionsBefore(id: string, startSeq: number): void;
  saveRateLimit(value: unknown): void;
  reserveRelease(id: string, token: string, milliseconds: number): void;
  clearRelease(id: string, token: string): Result<void, { message: string }>;
  clearReleaseReservations(): void;
}

export class ConversationWorkspaceChanged extends Error {
  constructor() {
    super("作業場所が変わりました。worktree の一覧を読み直してから、もう一度操作してください");
  }
}
