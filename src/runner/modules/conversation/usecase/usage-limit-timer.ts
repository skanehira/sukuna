import type { Clock } from "../domain/clock";

type Timer = {
  at: number;
  resume: (current: () => boolean) => number | void | Promise<number | void>;
  recheckAfter?: () => number | null;
  cancel?: () => void;
  attempt?: object;
};

export class UsageLimitTimer {
  private timers = new Map<string, Timer>();
  private suspended = new Set<string>();
  private clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  schedule(
    id: string,
    resetsAt: number | null,
    resume: Timer["resume"],
    recheckAfter?: Timer["recheckAfter"],
  ): void {
    this.cancel(id);
    const timer: Timer = {
      at: resetsAt === null ? this.clock.now() + 15 * 60 * 1000 : resetsAt + 60_000,
      resume,
      recheckAfter,
    };
    this.timers.set(id, timer);
    if (!this.suspended.has(id)) this.arm(id, timer);
  }

  private arm(id: string, timer: Timer): void {
    const attempt = {};
    timer.attempt = attempt;
    const current = () => this.timers.get(id) === timer && timer.attempt === attempt;
    timer.cancel = this.clock.setTimeout(
      async () => {
        if (!current()) return;
        let next: number | null = null;
        try {
          next = timer.recheckAfter?.() ?? null;
          if (next === null) next = (await timer.resume(current)) ?? null;
        } finally {
          if (current()) {
            if (next === null) this.timers.delete(id);
            else {
              timer.at = this.clock.now() + next;
              this.arm(id, timer);
            }
          }
        }
      },
      Math.max(0, timer.at - this.clock.now()),
    );
  }

  suspend(id: string): void {
    this.suspended.add(id);
    const timer = this.timers.get(id);
    if (!timer) return;
    timer.cancel?.();
    timer.cancel = undefined;
    timer.attempt = undefined;
  }

  finishSuspension(id: string, restore: boolean): void {
    if (!this.suspended.delete(id)) return;
    if (!restore) {
      this.cancel(id);
      return;
    }
    const timer = this.timers.get(id);
    if (timer) this.arm(id, timer);
  }

  cancel(id: string): void {
    this.timers.get(id)?.cancel?.();
    this.timers.delete(id);
  }

  clear(): void {
    for (const timer of this.timers.values()) timer.cancel?.();
    this.timers.clear();
    this.suspended.clear();
  }
}
