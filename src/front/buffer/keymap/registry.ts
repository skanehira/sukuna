import type { KeymapConfig, KeymapEntry } from "../../../shared/settings/keymap-schema";
export type { KeymapConfig, KeymapEntry } from "../../../shared/settings/keymap-schema";

export type HelpGroup =
  | "開く・戻る"
  | "ウィンドウ"
  | "会話"
  | "質問と指示"
  | "状況を思い出す"
  | "そのほか";
export type ActionContext = { view: string; window: string; line: number; text?: string };
export type ActionInfo = {
  name: string;
  label: string;
  group: HelpGroup;
  where: string;
  fromPrompt?: boolean;
  views?: string[];
};
export type ActionDef = ActionInfo & {
  confirm?: string;
  run(ctx: ActionContext): void | Promise<void>;
};
export type KeymapPort = {
  load(): Promise<KeymapConfig>;
  subscribe(changed: () => void): () => void;
} & (
  | {
      replace(entries: KeymapEntry[], revision?: string): Promise<KeymapConfig | null>;
      loadLatest?(): Promise<KeymapConfig & { revision?: string }>;
      save?: never;
    }
  | { save(entry: KeymapEntry): Promise<void>; replace?: never }
);
export class ActionRegistry {
  private actions = new Map<string, ActionDef>();
  private help = new Map<string, ActionInfo>();
  private current: ActionInfo[] = [];
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
  declareHelp(actions: readonly ActionInfo[]): () => void {
    actions.forEach((action) => this.help.set(action.name, action));
    this.emit();
    return () => {
      actions.forEach((action) => {
        if (this.help.get(action.name) === action) this.help.delete(action.name);
      });
      this.emit();
    };
  }
  describe(name: string): ActionInfo | undefined {
    return this.actions.get(name) ?? this.help.get(name);
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
  snapshot = (): ActionInfo[] => this.current;
  private emit(): void {
    this.current = [...new Map<string, ActionInfo>([...this.help, ...this.actions]).values()];
    this.listeners.forEach((listener) => listener());
  }
}
