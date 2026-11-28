import { z } from "zod";
import type { RightState } from "./right-window";
const anchor = {
  id: z.string().optional(),
  seq: z.number().int().nonnegative().optional(),
  seqLine: z.number().int().nonnegative().optional(),
};
const positionSchema = z.object({
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
  topLine: z.number().int().nonnegative(),
  ...anchor,
});
const rightView = z.object({
  view: z.string(),
  target: z.string(),
  parent: z.string().optional(),
  task: z.object({ id: z.string(), conversationId: z.string() }).optional(),
});
const jumpSchema = z.object({
  url: z.string(),
  entry: z.string().optional(),
  window: z.string(),
  windowKey: z.string().optional(),
  line: z.number().int().nonnegative(),
  ...anchor,
});
const schema = z.object({
  positions: z.array(z.tuple([z.string(), positionSchema])),
  right: z.object({ current: rightView.nullable(), stack: z.array(rightView) }),
  active: z.string(),
  commands: z.array(z.string()),
  jumps: z.array(jumpSchema),
});
export type SavedPosition = z.infer<typeof positionSchema>;
export type Jump = z.infer<typeof jumpSchema>;
export type StoragePort = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};
export type TimerPort = { schedule(fn: () => void, ms: number): () => void };
export class PositionStore {
  private data: z.infer<typeof schema> = {
    positions: [],
    right: { current: null, stack: [] },
    active: "main",
    commands: [],
    jumps: [],
  };
  private cancelTimer: (() => void) | null = null;
  private storage?: StoragePort;
  private timers?: TimerPort;
  constructor(storage?: StoragePort, timers?: TimerPort) {
    this.storage = storage;
    this.timers = timers;
    try {
      const raw = storage?.getItem("sukuna:positions:v1");
      if (raw) {
        const result = schema.safeParse(JSON.parse(raw));
        if (result.success) this.data = result.data;
      }
    } catch {
      this.data = {
        positions: [],
        right: { current: null, stack: [] },
        active: "main",
        commands: [],
        jumps: [],
      };
    }
  }
  position(key: string): SavedPosition | null {
    return this.data.positions.find(([name]) => name === key)?.[1] ?? null;
  }
  setPosition(key: string, value: SavedPosition): void {
    this.data.positions = [
      ...this.data.positions.filter(([name]) => name !== key),
      [key, value] as [string, SavedPosition],
    ].slice(-200);
    this.changed();
  }
  right(): RightState {
    return this.data.right;
  }
  setRight(right: RightState): void {
    this.data.right = right;
    this.changed();
  }
  active(): string {
    return this.data.active;
  }
  setActive(active: string): void {
    this.data.active = active;
    this.changed();
  }
  commands(): string[] {
    return [...this.data.commands];
  }
  addCommand(command: string): void {
    if (command.trim()) this.data.commands = [command, ...this.data.commands].slice(0, 50);
    this.changed();
  }
  jumps(): Jump[] {
    return [...this.data.jumps];
  }
  setJumps(jumps: Jump[]): void {
    this.data.jumps = jumps.slice(-50);
    this.changed();
  }
  private changed(): void {
    if (!this.timers) return;
    this.cancelTimer?.();
    this.cancelTimer = this.timers.schedule(() => this.flush(), 300);
  }
  flush = (): void => {
    this.cancelTimer?.();
    this.cancelTimer = null;
    try {
      this.storage?.setItem("sukuna:positions:v1", JSON.stringify(this.data));
    } catch {
      return;
    }
  };
}
