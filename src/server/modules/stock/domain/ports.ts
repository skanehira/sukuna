import type { Result } from "neverthrow";
import type { AddStockInput, StockItem, StockState, Thread } from "../../../../shared/stock";
import type { FileContentResponse } from "../../../../shared/files";
export type StockError = {
  code: "invalid_input" | "not_found" | "conflict" | "internal" | "runner_unavailable";
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
  close(id: string, at: number, token: string): Result<boolean, StockError>;
}
export type StockDependencies = {
  repository: StockRepositoryPort;
  readFile(id: string, path: string): Promise<Result<FileContentResponse, StockError>>;
  release(id: string): Promise<Result<{ token: string; complete(): Promise<void> }, StockError>>;
  changed(id: string, parts: ("stock" | "threads")[]): void;
  id(): string;
  now(): number;
};
