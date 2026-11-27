export type HelpGroup =
  | "開く・戻る"
  | "ウィンドウ"
  | "会話"
  | "質問と指示"
  | "状況を思い出す"
  | "そのほか";
export type ActionContext = { view: string; window: string; line: number; text?: string };
export type ActionDef = {
  name: string;
  label: string;
  group: HelpGroup;
  where: string;
  fromPrompt?: boolean;
  views?: string[];
  confirm?: string;
  run(ctx: ActionContext): void | Promise<void>;
};
export type KeymapEntry = {
  keys: string;
  context: "normal" | "visual" | "prompt" | "terminal";
  to: { action: string } | { keys: string } | null;
};
export type KeymapConfig = { version: 1; entries: KeymapEntry[] };
export type KeymapPort = {
  load(): Promise<KeymapConfig>;
  subscribe(changed: () => void): () => void;
  save(entry: KeymapEntry): Promise<void>;
};
export class ActionRegistry {
  private actions = new Map<string, ActionDef>();
  private listeners = new Set<() => void>();
  register(action: ActionDef): () => void {
    this.actions.set(action.name, action);
    this.emit();
    return () => {
      if (this.actions.get(action.name) === action) {
        this.actions.delete(action.name);
        this.emit();
      }
    };
  }
  get(name: string): ActionDef | undefined {
    return this.actions.get(name);
  }
  all(): ActionDef[] {
    return [...this.actions.values()];
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}
