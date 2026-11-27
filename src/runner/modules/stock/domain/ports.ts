import type { StockMessageItem } from "./message-format";

export type OutgoingStock = StockMessageItem & {
  id: string;
  conversationId: string;
  kind: "question" | "instruction";
};

export type StockReceipt = { at: number; seq?: number; threadId?: string };

export interface OutgoingStockRepository {
  list(conversationId: string): OutgoingStock[];
  markSent(item: OutgoingStock, receipt: StockReceipt): boolean;
}
