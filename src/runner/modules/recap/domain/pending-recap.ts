import type { RecapDelta } from "./turn-summary";

export type PendingRecap = {
  endSeq: number;
  turnHash: string;
  token: string;
  summary: RecapDelta;
  replacement?: { before: string | null; after: string };
};

export interface PendingRecaps {
  read(id: string): PendingRecap | undefined;
  write(id: string, pending: PendingRecap): void;
  remove(id: string): void;
}
