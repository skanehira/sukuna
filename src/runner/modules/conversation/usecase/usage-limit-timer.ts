import type { Clock } from "../domain/clock";
export class UsageLimitTimer {
  private timers = new Map<string, () => void>();
  private clock: Clock;
  constructor(clock: Clock) {
    this.clock = clock;
  }
  schedule(id: string, resetsAt: number | null, resume: () => void | Promise<void>): void {
    this.cancel(id);
    this.timers.set(
      id,
      this.clock.setTimeout(
        () => {
          this.timers.delete(id);
          return resume();
        },
        resetsAt === null ? 15 * 60 * 1000 : Math.max(0, resetsAt + 60000 - this.clock.now()),
      ),
    );
  }
  cancel(id: string): void {
    this.timers.get(id)?.();
    this.timers.delete(id);
  }
  clear(): void {
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
  }
}
