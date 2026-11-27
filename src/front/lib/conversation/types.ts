import type { Answers, ConversationEvent, RunState, StopReason } from "../../../shared/events";
import type {
  ConversationContent,
  ConversationDraft,
  ConversationDraftRequest,
  ConversationMessage,
  ConversationQueueItem,
} from "../../../shared/conversation/api";
import type { StockSendInput } from "../../../shared/stock";

export type Event = ConversationEvent & { seq: number; createdAt: number; missingImages?: number };
export type DraftContent = ConversationContent;
export type Draft = ConversationDraft;
export type DraftRequest = ConversationDraftRequest;
export type QueueItem = ConversationQueueItem;
export type Conversation = {
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
export type Snapshot = {
  conversation: Conversation;
  draft: Draft | null;
  queue: QueueItem[];
  pendingAnswers: { questionSeq: number; answers: Answers } | null;
  pendingPermission: { requestId: string; seq: number; toolName: string; summary: string } | null;
  commands: { name: string; description: string }[];
};
export type Project = {
  id: string;
  name: string;
  conversations: { id: string; title: string }[];
  issues: { id: string; number: number; title: string; state: string }[];
};
export type EventsPage = { events: Event[]; lastSeq: number; hasMore: boolean };
export type MessageResult = { result: "delivered" | "queued"; queueItem: QueueItem | null };
export type ConversationApi = {
  get(this: void, id: string): Promise<Snapshot>;
  events(this: void, id: string, after: number): Promise<EventsPage>;
  projects(this: void): Promise<Project[]>;
  start(this: void, projectId: string, worktree: boolean): Promise<{ conversation: Conversation }>;
  send(this: void, id: string, body: ConversationMessage): Promise<MessageResult>;
  saveDraft(
    this: void,
    id: string,
    body: DraftRequest,
  ): Promise<{ draft: Draft | null; applied: boolean }>;
  saveAnswers(
    this: void,
    id: string,
    questionSeq: number,
    answers: Answers,
  ): Promise<{ pendingAnswers: Snapshot["pendingAnswers"] }>;
  sendAnswers(this: void, id: string, confirmUnanswered: boolean): Promise<unknown>;
  permission(
    this: void,
    id: string,
    requestId: string,
    decision: "allow" | "deny",
  ): Promise<unknown>;
  stop(this: void, id: string): Promise<unknown>;
  resume(this: void, id: string): Promise<unknown>;
  editQueue(this: void, id: string, itemId: string, content: DraftContent): Promise<unknown>;
  deleteQueue(this: void, id: string, itemId: string): Promise<void>;
  sendStock(this: void, id: string, input: StockSendInput): Promise<unknown>;
  upload(this: void, id: string, file: File): Promise<{ image: { id: string } }>;
};
