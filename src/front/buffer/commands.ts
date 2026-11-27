import type { ActionRegistry, KeymapEntry } from "./keymap/registry";
import { normalizeKeys, parseKeys } from "./keymap/notation";
export type CommandDef = { name: string; label: string; run(args: string[]): void | Promise<void> };
export class CommandRegistry {
  private commands = new Map<string, CommandDef>();
  register(command: CommandDef): () => void {
    this.commands.set(command.name, command);
    return () => {
      this.commands.delete(command.name);
    };
  }
  get(name: string): CommandDef | undefined {
    return this.commands.get(name);
  }
  all(): CommandDef[] {
    return [...this.commands.values()];
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
      if (env.actions.get(target) && (context !== "terminal" || target === "terminal.normal"))
        to = { action: target };
      else if (context === "normal" && parseKeys(target)) to = { keys: normalizeKeys(target) };
      else {
        env.notify(`動作がありません: ${target}`, "error");
        return;
      }
      if (/^[a-zA-Z_][\w-]*(?:\.[a-zA-Z_][\w-]*)+$/.test(target) && !env.actions.get(target)) {
        env.notify(`動作がありません: ${target}`, "error");
        return;
      }
    }
    await env.save({ keys: normalizeKeys(keys), context, to });
    return;
  }
  const command = env.commands.get(name);
  if (command) {
    await command.run(args);
    return;
  }
  env.notify(`コマンド :${name} はありません。:h で一覧を見られます`, "error");
}
