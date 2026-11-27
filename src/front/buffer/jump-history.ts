import type { Jump, PositionStore } from "./position-store";
export class JumpHistory {
  private store: PositionStore;
  constructor(store: PositionStore) {
    this.store = store;
  }
  push(jump: Jump): void {
    this.store.setJumps([...this.store.jumps(), jump]);
  }
  pop(): Jump | null {
    const jumps = this.store.jumps();
    const jump = jumps.pop() ?? null;
    this.store.setJumps(jumps);
    return jump;
  }
  async back(
    url: string,
    port: { open(url: string): Promise<void>; place(jump: Jump): void },
  ): Promise<void> {
    const jump = this.pop();
    if (jump === null) return;
    if (jump.url !== url) await port.open(jump.url);
    port.place(jump);
  }
}
