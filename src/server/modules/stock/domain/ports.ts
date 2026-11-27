import type { Result } from "neverthrow";
import type {
  AddStockInput,
  Quote,
  StockItem,
  StockState,
  Thread,
  StockSendInput,
  StockSendResponse,
} from "../../../../shared/stock";
import type { FileContentResponse } from "../../../../shared/files";
export type StockError = {
  code:
    | "invalid_input"
    | "not_found"
    | "conflict"
    | "internal"
    | "runner_unavailable"
    | "worktree_failed";
  message: string;
};
export type StockRecord = Omit<StockItem, "stale">;
export type StockConversation = {
  id: string;
  kind: string;
  parentConversationId: string | null;
  closedAt: number | null;
};
export interface StockRepositoryPort {
  conversation(id: string): Result<StockConversation | undefined, StockError>;
  list(id: string): Result<StockRecord[], StockError>;
  get(id: string): Result<StockRecord | undefined, StockError>;
  add(id: string, conversationId: string, input: AddStockInput): Result<StockRecord, StockError>;
  update(
    id: string,
    from: StockState,
    to: StockState,
    text?: string,
  ): Result<StockRecord | undefined, StockError>;
  threads(id: string): Result<Thread[], StockError>;
  finishTransaction<T>(operation: (store: ThreadFinishStore) => T): Result<T, StockError>;
  close(id: string, at: number, token: string): Result<boolean, StockError>;
}
export type ThreadFinishStore = {
  sourceQuestion(id: string): { conversationId: string; quote: Quote } | undefined;
  close(id: string, at: number, token: string): boolean;
  addInstruction(
    id: string,
    conversationId: string,
    threadId: string,
    text: string,
    quote: Quote,
  ): StockRecord;
  deleteDraft(id: string): void;
};
export type StockDependencies = {
  repository: StockRepositoryPort;
  readFile(id: string, path: string): Promise<Result<FileContentResponse, StockError>>;
  stockSendAttempt(): string;
  send(
    id: string,
    input: StockSendInput,
    attemptId: string,
  ): Promise<Result<StockSendResponse, StockError>>;
  settleSend(
    id: string,
    attemptId: string,
    interrupted: boolean,
  ): Promise<Result<{ recovered: StockSendResponse | null; reopened: boolean }, StockError>>;
  propose(id: string): Promise<Result<{ runState: "working"; proposalSeq?: number }, StockError>>;
  release(
    id: string,
    idleOnly?: boolean,
  ): Promise<Result<{ token: string; complete(): Promise<void> }, StockError>>;
  changed(id: string, parts: ("stock" | "threads")[]): void;
  id(): string;
  now(): number;
};
