import type { ActionRegistry, KeymapEntry } from "./keymap/registry";
import { normalizeKeys, parseKeys } from "./keymap/notation";
export type CommandInfo = { name: string; label: string; where?: string };
export type CommandDef = CommandInfo & { run(args: string[], raw: string): void | Promise<void> };
export class CommandRetry extends Error {
  readonly run: () => Promise<void>;
  constructor(message: string, run: () => Promise<void>) {
    super(message);
    this.run = run;
  }
}
export class CommandRegistry {
  private commands = new Map<string, CommandDef>();
  private listeners = new Set<() => void>();
  private help = new Map<string, CommandInfo>();
  private current: CommandInfo[] = [];
  register(command: CommandDef): () => void {
    this.commands.set(command.name, command);
    this.emit();
    return () => {
      if (this.commands.get(command.name) === command) {
        this.commands.delete(command.name);
        this.emit();
      }
    };
  }
  declareHelp(commands: readonly CommandInfo[]): () => void {
    commands.forEach((command) => this.help.set(command.name, command));
    this.emit();
    return () => {
      commands.forEach((command) => {
        if (this.help.get(command.name) === command) this.help.delete(command.name);
      });
      this.emit();
    };
  }
  get(name: string): CommandDef | undefined {
    return this.commands.get(name);
  }
  all(): CommandInfo[] {
    return this.current;
  }
  snapshot = (): CommandInfo[] => this.current;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit(): void {
    this.current = [...new Map<string, CommandInfo>([...this.help, ...this.commands]).values()];
    this.listeners.forEach((listener) => listener());
  }
}
export type CommandEnvironment = {
  actions: ActionRegistry;
  commands: CommandRegistry;
  notify(message: string, kind?: "error" | "info"): void;
  save(entry: KeymapEntry): Promise<void>;
  quit(): void;
  jump?(line: number): void;
};
export async function executeCommand(input: string, env: CommandEnvironment): Promise<void> {
  const [name, ...args] = input.trim().replace(/^:/, "").split(/\s+/);
  if (/^\d+$/.test(name)) {
    env.jump?.(Math.max(0, Number(name) - 1));
    return;
  }
  if (name === "q") {
    env.quit();
    return;
  }
  if (["map", "unmap", "tmap", "tunmap"].includes(name)) {
    const [keys, target] = args;
    const remove = name === "unmap" || name === "tunmap";
    if (!keys || (!remove && !target)) {
      env.notify(`使い方: :${name} <キー>${remove ? "" : " <動作の名前か Vim のキー列>"}`, "error");
      return;
    }
    if (!parseKeys(keys)) {
      env.notify(`キーの書き方が読めません: ${keys}`, "error");
      return;
    }
    const context = name.startsWith("t") ? "terminal" : "normal";
    let to: KeymapEntry["to"] = null;
    if (!remove) {
      if (env.actions.describe(target) && (context !== "terminal" || target === "terminal.normal"))
        to = { action: target };
      else if (context === "normal" && parseKeys(target)) to = { keys: normalizeKeys(target) };
      else {
        env.notify(`動作がありません: ${target}`, "error");
        return;
      }
      if (/^[a-zA-Z_][\w-]*(?:\.[a-zA-Z_][\w-]*)+$/.test(target) && !env.actions.describe(target)) {
        env.notify(`動作がありません: ${target}`, "error");
        return;
      }
    }
    await env.save({ keys: normalizeKeys(keys), context, to });
    return;
  }
  const command = env.commands.get(name);
  if (command) {
    const raw = input
      .trimStart()
      .replace(/^:/, "")
      .slice(name.length + 1);
    await command.run(args, raw);
    return;
  }
  env.notify(`コマンド :${name} はありません。:h で一覧を見られます`, "error");
}
