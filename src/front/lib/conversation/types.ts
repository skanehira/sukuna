import type { Answers, ConversationEvent, RunState, StopReason } from "../../../shared/events";

export type Event = ConversationEvent & { seq: number; createdAt: number; missingImages?: number };
export type DraftContent = { text: string; images: string[] };
export type Draft = DraftContent & { updatedAt: number; updatedBy: string };
export type DraftRequest = DraftContent & { clientId: string; editedAt: number };
export type QueueItem = DraftContent & { id: string; position: number; stockItemId: string | null; clientId: string | null; createdAt: number };
export type Conversation = {
  id: string; projectId: string; projectName: string; kind: string; issueId: string | null;
  parentConversationId: string | null; title: string; cwd: string;
  worktree: { id: string; name: string; branch: string } | null;
  runState: RunState; stopReason: StopReason | null; resetsAt: number | null;
  lastSeq: number; lastReadSeq: number; lastPosition: number | null; closedAt: number | null;
};
export type Snapshot = {
  conversation: Conversation; draft: Draft | null; queue: QueueItem[];
  pendingAnswers: { questionSeq: number; answers: Answers } | null;
  pendingPermission: { requestId: string; seq: number; toolName: string; summary: string } | null;
  commands: { name: string; description: string }[];
};
export type Project = { id: string; name: string; conversations: { id: string; title: string }[]; issues: { id: string; number: number; title: string; state: string }[] };
export type EventsPage = { events: Event[]; lastSeq: number; hasMore: boolean };
export type MessageResult = { result: "delivered" | "queued"; queueItem: QueueItem | null };
export type ConversationApi = {
  get(id: string): Promise<Snapshot>;
  events(id: string, after: number): Promise<EventsPage>;
  projects(): Promise<Project[]>;
  start(projectId: string, worktree: boolean): Promise<{ conversation: Conversation }>;
  send(id: string, body: DraftContent & { mode: "send" | "interrupt"; clientMessageId: string }): Promise<MessageResult>;
  saveDraft(id: string, body: DraftRequest): Promise<{ draft: Draft | null; applied: boolean }>;
  saveAnswers(id: string, questionSeq: number, answers: Answers): Promise<{ pendingAnswers: Snapshot["pendingAnswers"] }>;
  sendAnswers(id: string, confirmUnanswered: boolean): Promise<unknown>;
  permission(id: string, requestId: string, decision: "allow" | "deny"): Promise<unknown>;
  stop(id: string): Promise<unknown>;
  resume(id: string): Promise<unknown>;
  editQueue(id: string, itemId: string, content: DraftContent): Promise<unknown>;
  deleteQueue(id: string, itemId: string): Promise<void>;
  sendStock(id: string, stockId: string): Promise<unknown>;
  upload(id: string, file: File): Promise<{ image: { id: string } }>;
};
