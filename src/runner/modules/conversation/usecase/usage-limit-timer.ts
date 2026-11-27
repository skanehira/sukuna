import type { Clock } from "../domain/clock";
export class UsageLimitTimer {
  private timers = new Map<string, { cancel?: () => void }>();
  private clock: Clock;
  constructor(clock: Clock) {
    this.clock = clock;
  }
  schedule(
    id: string,
    resetsAt: number | null,
    resume: (current: () => boolean) => number | void | Promise<number | void>,
    recheckAfter?: () => number | null,
  ): void {
    this.cancel(id);
    const timer: { cancel?: () => void } = {};
    const current = () => this.timers.get(id) === timer;
    const run = async () => {
      if (!current()) return;
      let next: number | null = null;
      try {
        next = recheckAfter?.() ?? null;
        if (next === null) next = (await resume(current)) ?? null;
      } finally {
        if (current()) {
          if (next === null) this.timers.delete(id);
          else timer.cancel = this.clock.setTimeout(run, next);
        }
      }
    };
    this.timers.set(id, timer);
    timer.cancel = this.clock.setTimeout(
      run,
      resetsAt === null ? 15 * 60 * 1000 : Math.max(0, resetsAt + 60000 - this.clock.now()),
    );
  }
  cancel(id: string): void {
    this.timers.get(id)?.cancel?.();
    this.timers.delete(id);
  }
  clear(): void {
    for (const timer of this.timers.values()) timer.cancel?.();
    this.timers.clear();
  }
}
