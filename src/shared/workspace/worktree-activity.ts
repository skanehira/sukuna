import type { Result } from "neverthrow";
export interface WorktreeActivityReservation {
  acquire(ids: string[]): void;
}
export interface WorktreeActivityLease extends WorktreeActivityReservation {
  release(): void;
}
export type WorktreeActivityError = { code: "conflict" | "internal"; message: string };
export interface WorktreeActivity {
  acquire(ids: string[]): Result<WorktreeActivityLease, WorktreeActivityError>;
  run<T>(action: (reservation: WorktreeActivityReservation) => T): T;
}
export class WorktreeActivityBusy extends Error {
  constructor() {
    super("worktree を削除しています。完了してから、もう一度操作してください");
  }
}
