import { createContext } from "react";
import {
  ActionRegistry,
  type ActionContext,
  type KeymapEntry,
  type KeymapPort,
} from "./keymap/registry";
import { defaultKeymap } from "./keymap/defaults";
import { resolveKeymap } from "./keymap/resolve";
import { CommandRegistry, CommandRetry, executeCommand } from "./commands";
import { PositionStore, type Jump, type SavedPosition } from "./position-store";
import { RightWindow, type RightView } from "./right-window";
import { JumpHistory } from "./jump-history";
import type { Hint } from "./hints";
import type { LineInfo } from "./line";
import { menuAt } from "./menu";
import type { ClipboardPort } from "./clipboard";

export function windowId(side: string): string {
  return side === "list" || side === "table" ? "main" : side;
}

export type PromptSpec = {
  label: string;
  target: string;
  verb: string;
  initialText?: string;
  allowEmpty?: boolean;
  candidates?: string[];
  commands?: { name: string; description: string }[];
  unsent?: string;
  change?(text: string): void;
  quote?: string[];
  images?: number;
  submit(text: string): void | boolean | Promise<void | boolean>;
  close(text: string): void;
  interrupt?(text: string): void | boolean | Promise<void | boolean>;
  paste?(images: File[]): void;
};
export type WindowHandle = {
  focus(): void;
  lines(): LineInfo[];
  position(): SavedPosition;
  place(position: SavedPosition): void;
  view: string;
  name: string;
  posKey: string;
  temporary?: boolean;
  url: string;
  scrollCursor(): void;
};
export type Mode =
  | "NORMAL"
  | "INSERT"
  | "REPLACE"
  | "VISUAL"
  | "VISUAL LINE"
  | "VISUAL BLOCK"
  | "COMMAND"
  | "TERMINAL";
export type BufferSnapshot = {
  version: number;
  active: string;
  mode: Mode;
  prefix: string;
  number: string;
  command: string | null;
  commandPrefix?: ":" | "/";
  prompt: PromptSpec | null;
  promptId: number;
  confirmation: { text: string; run: () => void | Promise<void>; context: ActionContext } | null;
  notice: { message: string; kind: "error" | "info" } | null;
};
export type ControllerOptions = {
  positions?: PositionStore;
  keymap?: KeymapPort;
  url?: string;
  navigate?(url: string): void | Promise<void>;
  back?(): boolean;
  prompt?(): PromptSpec | undefined;
  clipboard?: ClipboardPort;
  notify?(message: string, kind: "error" | "info"): void;
};
export class BufferController {
  readonly actions = new ActionRegistry();
  readonly commands = new CommandRegistry();
  readonly positions: PositionStore;
  readonly right: RightWindow;
  readonly jumps: JumpHistory;
  readonly options: ControllerOptions;
  rightClosed = false;
  private state: BufferSnapshot;
  private listeners = new Set<() => void>();
  private windows = new Map<string, WindowHandle>();
  private configured: KeymapEntry[] = [];
  private bindings = defaultKeymap;
  private pending = new Set<string>();
  private status = new Map<string, string>();
  private hints = new Map<string, Hint[]>();
  private promptUpdate: ((text: string) => void) | null = null;
  private promptFocus: (() => void) | null = null;
  private commandRevision = 0;
  private commandRetry: { input: string; run: () => Promise<void> } | null = null;
  private searchSubmit: ((query: string) => void | Promise<void>) | null = null;
  private origin = "main";
  private promptOrigin = "main";
  private promptDraft = "";
  private restoreJump: Jump | null = null;
  constructor(options: ControllerOptions = {}) {
    this.options = { ...options };
    this.positions = options.positions ?? new PositionStore();
    this.right = new RightWindow(this.positions.right());
    this.jumps = new JumpHistory(this.positions);
    const active = this.positions.active();
    this.state = {
      version: 0,
      active: active === "right" && !this.right.current ? "main" : active,
      mode: "NORMAL",
      prefix: "",
      number: "",
      command: null,
      prompt: null,
      promptId: 0,
      confirmation: null,
      notice: null,
    };
    const builtins: [string, string, string, () => void][] = [
      ["open", "開く・実行する", "開く・戻る", () => this.open()],
      ["back", "戻る", "開く・戻る", () => this.back()],
      ["view.prev", "前の表示", "開く・戻る", () => this.previousRight()],
      [
        "jump.back",
        "ジャンプを戻る",
        "開く・戻る",
        () => {
          void this.jumpBack();
        },
      ],
      ["right.close", "右を閉じる", "ウィンドウ", () => this.closeRight()],
      ["cmdline", "コマンド", "そのほか", () => this.openCommand()],
      ["tree.focus", "ツリー", "開く・戻る", () => this.focus("tree")],
      [
        "prompt.open",
        "入力欄を開く",
        "会話",
        () => {
          const spec = this.options.prompt?.();
          if (spec) this.openPrompt(spec);
        },
      ],
      ["win.left", "左へ", "ウィンドウ", () => this.move(-1)],
      ["win.right", "右へ", "ウィンドウ", () => this.move(1)],
      ["win.down", "入力欄へ", "ウィンドウ", () => this.focus("prompt")],
      ["win.up", "会話へ", "ウィンドウ", () => this.focus("main")],
      ["terminal.normal", "Normal モードへ戻る", "そのほか", () => this.update({ mode: "NORMAL" })],
    ];
    for (const [name, label, group, run] of builtins)
      this.actions.register({
        name,
        label,
        group: group as "開く・戻る" | "ウィンドウ" | "会話" | "そのほか",
        where: "共通",
        fromPrompt: name.startsWith("win.") || name === "cmdline",
        run,
      });
    this.actions.subscribe(() => this.update({}));
  }
  snapshot = (): BufferSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  update(patch: Partial<BufferSnapshot>): void {
    this.state = { ...this.state, ...patch, version: this.state.version + 1 };
    this.listeners.forEach((listener) => listener());
  }
  entries(): KeymapEntry[] {
    return this.bindings;
  }
  start(): () => void {
    const port = this.options.keymap;
    let active = true;
    let generation = 0;
    const reload = async () => {
      const request = ++generation;
      try {
        const config = await port!.load();
        if (active && request === generation) {
          this.configured = config.entries;
          this.bindings = resolveKeymap(defaultKeymap, this.configured);
          this.update({ prefix: "" });
        }
      } catch (error) {
        if (active)
          this.notify(
            error instanceof Error ? error.message : "キーの設定を読み込めませんでした",
            "error",
          );
      }
    };
    const unsubscribe = port?.subscribe(() => {
      void reload();
    });
    if (port) void reload();
    return () => {
      active = false;
      unsubscribe?.();
      this.positions.flush();
    };
  }
  notify = (message: string, kind: "error" | "info" = "info"): void => {
    this.options.notify?.(message, kind);
    this.update({ notice: { message, kind } });
  };
  registerWindow(side: string, handle: WindowHandle): () => void {
    this.windows.set(side, handle);
    if (!handle.temporary) {
      const stored = this.positions.position(handle.posKey);
      if (stored) handle.place(stored);
      if (this.restoreJump?.window === side && this.restoreJump.url === handle.url) {
        this.placeJump(this.restoreJump);
        this.restoreJump = null;
      }
    }
    if (this.state.active === side) this.focus(side);
    this.update({});
    return () => {
      if (!handle.temporary) {
        this.positions.setPosition(handle.posKey, handle.position());
        this.positions.flush();
      }
      if (this.windows.get(side) === handle) this.windows.delete(side);
    };
  }
  registerPromptFocus(focus: () => void): () => void {
    this.promptFocus = focus;
    return () => {
      if (this.promptFocus === focus) this.promptFocus = null;
    };
  }
  focus(side: string): void {
    if (side === "prompt") {
      if (!this.state.prompt) return;
      this.promptFocus?.();
    } else {
      const target = this.windows.get(side);
      if (!target) return;
      target.focus();
    }
    this.positions.setActive(side);
    this.update({ active: side });
  }
  move(direction: number): void {
    const order = ["tree", "main", "right"].filter((side) => this.windows.has(side));
    const index = Math.max(0, order.indexOf(this.state.active));
    this.focus(order[Math.max(0, Math.min(index + direction, order.length - 1))]);
  }
  windowName(): string {
    return this.state.active === "prompt"
      ? (this.state.prompt?.label ?? "入力欄")
      : (this.windows.get(this.state.active)?.name ?? this.state.active);
  }
  currentLine(side = this.state.active): LineInfo | undefined {
    const window = this.windows.get(side);
    return window?.lines()[window.position().line];
  }
  windowPosition(side: string): SavedPosition | undefined {
    return this.windows.get(side)?.position();
  }
  context(side = this.state.active): ActionContext {
    const window = this.windows.get(side);
    return { window: side, view: window?.view ?? "", line: window?.position().line ?? 0 };
  }
  async run(name: string, context = this.context()): Promise<void> {
    const action = this.actions.get(name);
    if (!action) return;
    if (action.views && !action.views.includes(context.view)) return;
    if (this.state.active === "prompt" && !action.fromPrompt && name !== "cmdline") return;
    if (action.confirm) {
      this.confirm(action.confirm, context, () => action.run(context));
      return;
    }
    await this.perform(() => action.run(context));
  }
  confirm(text: string, context: ActionContext, run: () => void | Promise<void>): void {
    this.update({ confirmation: { text, context, run } });
  }
  private async perform(run: () => void | Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.notify(error instanceof Error ? error.message : "操作に失敗しました", "error");
    }
  }
  answer(
    event: Pick<KeyboardEvent, "key" | "isComposing" | "ctrlKey" | "altKey" | "metaKey">,
  ): boolean {
    const confirmation = this.state.confirmation;
    if (!confirmation) return false;
    if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return true;
    this.update({ confirmation: null });
    this.focus(confirmation.context.window);
    if (
      event.key === "y" &&
      !event.isComposing &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      this.pending.add(confirmation.context.window);
      this.update({});
      void this.perform(confirmation.run).finally(() => {
        this.pending.delete(confirmation.context.window);
        this.update({});
      });
    } else this.notify("やめました");
    return true;
  }
  open(): void {
    const side = this.state.active;
    const handle = this.windows.get(side);
    if (!handle || this.pending.has(side)) return;
    const lines = handle.lines();
    const number = this.state.number;
    this.update({ number: "" });
    const chosen = number
      ? menuAt(lines, Number(number))
      : { line: lines[handle.position().line], index: handle.position().line };
    if (number && !chosen) {
      this.notify(`${number} 番の操作は、この画面にありません`);
      return;
    }
    if (!chosen?.line) return;
    if (number) handle.place({ line: chosen.index, column: 0, topLine: chosen.index });
    const { line } = chosen;
    if (line.action) {
      if (this.actions.get(line.action)?.confirm) {
        void this.run(line.action, this.context(side));
        return;
      }
      this.pending.add(side);
      this.update({});
      void this.run(line.action, this.context(side)).finally(() => {
        this.pending.delete(side);
        this.update({});
      });
    } else if (line.target) {
      this.pushJump(side, handle.position().line);
      void this.navigate(line.target.url);
    }
  }
  busy(side: string): boolean {
    return this.pending.has(side);
  }
  numberHint(): Hint[] {
    const chosen = menuAt(
      this.windows.get(this.state.active)?.lines() ?? [],
      Number(this.state.number),
    );
    return [
      [
        `${this.state.number} Enter`,
        chosen
          ? `「${chosen.line.cols?.[1] ?? chosen.line.text.split(/ {2,}/)[0]}」を実行する`
          : "操作を実行する",
      ],
      ["Esc", "やめる"],
    ];
  }
  setHints(view: string, hints: Hint[]): void {
    this.hints.set(view, hints);
    this.update({});
  }
  currentHints(): Hint[] {
    if (this.state.confirmation)
      return [
        ["y", "実行する"],
        ["n", "やめる"],
      ];
    if (this.state.mode === "TERMINAL") return [["terminal.normal", "Normal へ"]];
    if (this.state.prompt && this.state.active === "prompt")
      return this.state.mode === "INSERT" || this.state.mode === "REPLACE"
        ? [["Esc", `Normal へ (${this.state.prompt.verb}のは Normal から)`]]
        : [
            ["Enter", this.state.prompt.verb],
            ["Esc", "閉じる (書きかけは残る)"],
          ];
    if (this.state.mode.startsWith("VISUAL"))
      return [
        ["stock.question", "選んだ箇所に質問"],
        ["stock.instruct", "選んだ箇所に指示"],
        ["y", "コピー"],
        ["Esc", "やめる"],
      ];
    if (this.state.number) return this.numberHint();
    const handle = this.windows.get(this.state.active);
    const lines = handle?.lines() ?? [];
    const line = lines[handle?.position().line ?? 0];
    if (line?.kind === "menu" && line.action?.startsWith("conversation.choice."))
      return [
        ["open", "この選択肢を選ぶ (もう一度で外す)"],
        ["番号 Enter", "番号で選ぶ"],
        ["prompt.open", "入力"],
      ];
    if (line?.kind === "menu") return [["open", "実行する"]];
    const hints = this.hints.get(handle?.view ?? "") ?? [];
    return lines.some((line) => line.kind === "menu")
      ? [...hints, ["番号 Enter", "操作を実行"]]
      : hints;
  }
  registerStatusItem(name: string, text: string): () => void {
    this.status.set(name, text);
    this.update({});
    return () => {
      this.status.delete(name);
      this.update({});
    };
  }
  statusItems(): string[] {
    return [...this.status.values()];
  }
  openSearch(submit: (query: string) => void | Promise<void>): void {
    this.openCommand();
    this.searchSubmit = submit;
    this.update({ commandPrefix: "/" });
  }
  openCommand(initial = ""): void {
    this.commandRevision++;
    this.commandRetry = null;
    this.searchSubmit = null;
    this.origin = this.state.active;
    this.update({ command: initial, mode: "COMMAND", prefix: "", commandPrefix: ":" });
  }
  closeCommand(): void {
    this.commandRevision++;
    this.commandRetry = null;
    this.searchSubmit = null;
    this.update({ command: null, mode: "NORMAL" });
    this.focus(this.origin);
  }
  async command(input: string): Promise<void> {
    const search = this.searchSubmit;
    if (search) {
      this.closeCommand();
      try {
        await search(input);
      } catch (error) {
        this.notify(error instanceof Error ? error.message : "検索できませんでした", "error");
      }
      return;
    }
    const retry = this.commandRetry?.input === input ? this.commandRetry.run : null;
    this.positions.addCommand(input);
    this.closeCommand();
    const revision = this.commandRevision;
    const right = this.right.openingRevision();
    const promptId = this.state.promptId;
    try {
      if (retry) {
        await retry();
        return;
      }
      await executeCommand(input, {
        actions: this.actions,
        commands: this.commands,
        notify: this.notify,
        quit: () => (this.right.current ? this.closeRight() : this.back()),
        jump: (line) =>
          this.windows.get(this.state.active)?.place({ line, column: 0, topLine: line }),
        save: async (entry) => {
          if (!this.options.keymap) {
            this.notify("キーの設定はまだ保存できません", "error");
            return;
          }
          if (
            entry.context === "terminal" &&
            entry.to !== null &&
            "action" in entry.to &&
            entry.to.action === "terminal.normal"
          ) {
            for (const previous of this.bindings.filter(
              (value) =>
                value.context === "terminal" &&
                value.keys !== entry.keys &&
                value.to !== null &&
                "action" in value.to &&
                value.to.action === "terminal.normal",
            )) {
              const removal: KeymapEntry = { keys: previous.keys, context: "terminal", to: null };
              await this.options.keymap.save(removal);
              this.configured = [...this.configured, removal];
            }
          }
          await this.options.keymap.save(entry);
          this.configured = [...this.configured, entry];
          this.bindings = resolveKeymap(defaultKeymap, this.configured);
          this.update({});
        },
      });
    } catch (error) {
      if (error instanceof CommandRetry) {
        if (
          this.commandRevision !== revision ||
          this.right.openingRevision() !== right ||
          this.state.promptId !== promptId
        )
          return;
        this.openCommand(input);
        this.commandRetry = { input, run: error.run };
      }
      this.notify(error instanceof Error ? error.message : "コマンドの実行に失敗しました", "error");
    }
  }
  registerPromptUpdate(update: (text: string) => void): () => void {
    this.promptUpdate = update;
    return () => {
      if (this.promptUpdate === update) this.promptUpdate = null;
    };
  }
  replacePromptText(text: string): void {
    this.promptDraft = text;
    this.promptUpdate?.(text);
  }
  patchPrompt(patch: Partial<PromptSpec>): void {
    if (this.state.prompt) this.update({ prompt: { ...this.state.prompt, ...patch } });
  }
  promptText(): string {
    return this.promptDraft;
  }
  setPromptDraft(text: string): void {
    this.promptDraft = text;
  }
  openPrompt(spec: PromptSpec): void {
    const origin = this.state.active === "prompt" ? this.promptOrigin : this.state.active;
    this.closePrompt();
    this.promptOrigin = origin;
    this.promptDraft = spec.initialText ?? "";
    this.update({
      prompt: spec,
      promptId: this.state.promptId + 1,
      mode: "INSERT",
      active: "prompt",
    });
    for (const handle of this.windows.values()) handle.scrollCursor();
  }
  closePrompt(text = this.promptDraft): void {
    const spec = this.state.prompt;
    if (!spec) return;
    this.update({ prompt: null, mode: "NORMAL" });
    spec.close(text);
    this.focus(this.promptOrigin);
  }
  async submitPrompt(text: string, interrupt = false): Promise<boolean> {
    const spec = this.state.prompt;
    const promptId = this.state.promptId;
    if (!spec) return false;
    if (!spec.allowEmpty && text.trim() === "") {
      this.notify("内容が空です。書いてから送ってください", "error");
      return false;
    }
    try {
      const close =
        interrupt && spec.interrupt ? await spec.interrupt(text) : await spec.submit(text);
      if (
        close === false ||
        !this.state.prompt ||
        this.state.promptId !== promptId ||
        this.promptDraft !== text
      )
        return true;
      this.update({ prompt: null, mode: "NORMAL" });
      this.focus(this.promptOrigin);
      return true;
    } catch (error) {
      this.notify(error instanceof Error ? error.message : "送れませんでした", "error");
      return false;
    }
  }
  openRight(view: RightView): void {
    this.rightClosed = false;
    this.right.open(view);
    this.positions.setRight(this.right.state());
    this.update({ active: "right" });
    this.focus("right");
  }
  closeRight(): void {
    this.rightClosed = true;
    this.right.close();
    this.positions.setRight(this.right.state());
    this.update({});
    this.focus("main");
  }
  private previousRight(): void {
    if (this.state.active !== "right") return;
    this.right.back();
    this.positions.setRight(this.right.state());
    this.update({});
    if (!this.right.current) {
      this.rightClosed = true;
      this.update({});
      this.focus("main");
    }
  }
  private back(): void {
    if (this.state.active === "right") {
      this.previousRight();
      return;
    }
    if (!this.options.back?.()) this.notify("これより前の画面はありません");
  }
  changeScreen(url: string): void {
    if (url !== this.options.url) {
      this.commandRevision++;
      this.commandRetry = null;
      this.closePrompt();
      if (this.state.confirmation) this.update({ confirmation: null });
    }
    this.options.url = url;
  }
  navigate(url: string): void | Promise<void> {
    this.changeScreen(url);
    return this.options.navigate?.(url);
  }
  pushJump(side: string, line: number): void {
    const handle = this.windows.get(side);
    const info = handle?.lines()[line];
    this.jumps.push({
      url: this.options.url ?? "/",
      window: side,
      line,
      ...(info?.id ? { id: info.id } : {}),
    });
  }
  private placeJump(jump: Jump): void {
    const handle = this.windows.get(jump.window);
    if (!handle || handle.temporary || handle.url !== jump.url) {
      this.restoreJump = jump;
      return;
    }
    const found = jump.id ? handle.lines().findIndex((line) => line.id === jump.id) : -1;
    handle.place({ line: found >= 0 ? found : jump.line, column: 0, topLine: jump.line });
    this.focus(jump.window);
  }
  async jumpBack(): Promise<void> {
    await this.jumps.back(this.options.url ?? "/", {
      open: async (url) => {
        await this.navigate(url);
      },
      place: (jump) => this.placeJump(jump),
    });
  }
}
export const BufferControllerContext = createContext<BufferController | null>(null);
