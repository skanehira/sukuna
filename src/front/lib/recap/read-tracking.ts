export type TabStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type Opening = { lastReadSeq: number; lastPosition: number | null };
const key = (id: string) => `sukuna:recap:${id}`;
export function rememberOpening(
  storage: TabStorage,
  id: string,
  lastReadSeq: number,
  lastPosition: number | null,
): Opening {
  const saved = storage.getItem(key(id));
  if (saved) {
    try {
      const value = JSON.parse(saved) as Opening;
      if (
        Number.isSafeInteger(value.lastReadSeq) &&
        value.lastReadSeq >= 0 &&
        (value.lastPosition === null ||
          (Number.isSafeInteger(value.lastPosition) && value.lastPosition >= 0))
      )
        return value;
    } catch {}
  }
  const value = { lastReadSeq, lastPosition };
  storage.setItem(key(id), JSON.stringify(value));
  return value;
}
export function forgetOpening(storage: TabStorage, id: string): void {
  storage.removeItem(key(id));
}
export type ReadBody = { readSeq?: number; position?: number };
export class ReadTracking {
  private latest = 0;
  private readThrough = 0;
  private saved = 0;
  private sendingRead = 0;
  private left = false;
  private visible = true;
  private position: number | null = null;
  private readTimer: (() => void) | null = null;
  private cursorTimer: (() => void) | null = null;
  private send: (body: ReadBody, keepalive: boolean) => Promise<void>;
  private schedule: (fn: () => void, ms: number) => () => void;
  constructor(
    send: (body: ReadBody, keepalive: boolean) => Promise<void>,
    schedule: (fn: () => void, ms: number) => () => void,
  ) {
    this.send = send;
    this.schedule = schedule;
  }
  open(seq: number): void {
    this.left = false;
    this.latest = Math.max(this.latest, seq);
    if (this.visible) this.readThrough = this.latest;
    this.flushRead();
  }
  received(seq: number): void {
    this.latest = Math.max(this.latest, seq);
    if (!this.visible || this.left) return;
    this.readThrough = this.latest;
    if (!this.readTimer && this.readThrough > this.saved)
      this.readTimer = this.schedule(() => {
        this.readTimer = null;
        this.flushRead();
      }, 1000);
  }
  visibility(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      this.left = false;
      this.received(this.latest);
    } else {
      this.readTimer?.();
      this.readTimer = null;
    }
  }
  cursor(seq: number | null): void {
    this.position = seq;
    this.cursorTimer?.();
    this.cursorTimer = null;
    if (seq === null) return;
    this.cursorTimer = this.schedule(() => {
      this.cursorTimer = null;
      this.save({ position: seq }, false);
    }, 2000);
  }
  stopTimers(): void {
    this.readTimer?.();
    this.readTimer = null;
    this.cursorTimer?.();
    this.cursorTimer = null;
  }
  leave(): void {
    if (this.left) return;
    this.left = true;
    this.stopTimers();
    const readSeq = this.readThrough;
    const position = this.position;
    this.position = null;
    const body: ReadBody = {
      ...(readSeq > this.saved ? { readSeq } : {}),
      ...(position !== null ? { position } : {}),
    };
    if (body.readSeq !== undefined || body.position !== undefined)
      this.save(body, true, () => {
        this.saved = Math.max(this.saved, readSeq);
      });
  }
  private flushRead(): void {
    if (!this.visible || this.readThrough <= Math.max(this.saved, this.sendingRead)) return;
    const seq = this.readThrough;
    this.sendingRead = seq;
    void this.send({ readSeq: seq }, false)
      .then(() => {
        this.saved = Math.max(this.saved, seq);
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.sendingRead === seq) this.sendingRead = 0;
      });
  }
  private save(body: ReadBody, keepalive: boolean, success?: () => void): void {
    void this.send(body, keepalive)
      .then(success)
      .catch(() => undefined);
  }
}
