import type { RunnerNotice } from "../../../../shared/ipc";
import type { Clock } from "../domain/clock";

export class ChangeFeed {
  private listeners = new Set<(notice: RunnerNotice) => void>();
  private terminalListeners = new Set<(notice: RunnerNotice) => void>();
  private deltas = new Map<string, { text: string; cancel: () => void }>();
  private clock: Pick<Clock, "setTimeout">;
  constructor(clock: Pick<Clock, "setTimeout">) {
    this.clock = clock;
  }
  subscribe(listener: (notice: RunnerNotice) => void, terminalCleanup = false): () => void {
    this.listeners.add(listener);
    if (terminalCleanup) this.terminalListeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      this.terminalListeners.delete(listener);
    };
  }
  get terminalCleanupAvailable(): boolean {
    return this.terminalListeners.size > 0;
  }
  publish(notice: RunnerNotice): void {
    const listeners =
      notice.kind === "worktree_terminal_close" ? this.terminalListeners : this.listeners;
    for (const listener of listeners) listener(notice);
  }
  delta(id: string, text: string): void {
    const pending = this.deltas.get(id);
    if (pending) {
      pending.text += text;
      return;
    }
    const batch = {
      text,
      cancel: this.clock.setTimeout(() => {
        this.deltas.delete(id);
        this.publish({ kind: "delta", conversation_id: id, text: batch.text });
      }, 100),
    };
    this.deltas.set(id, batch);
  }
  discardDelta(id: string): void {
    this.deltas.get(id)?.cancel();
    this.deltas.delete(id);
  }
  close(): void {
    for (const batch of this.deltas.values()) batch.cancel();
    this.deltas.clear();
    this.listeners.clear();
    this.terminalListeners.clear();
  }
}
