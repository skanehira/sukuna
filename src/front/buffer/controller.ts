import { includesConflict, proposeKeymapChange } from "../lib/keymap-commands";
import type { ChangeDesc } from "@codemirror/state";
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
import type { LineInfo, OpenTarget } from "./line";
import { menuAt } from "./menu";
import { findSeqLine } from "./seq-index";
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
  allowChange?(text: string, edits: ChangeDesc): boolean;
  change?(text: string, edits?: ChangeDesc): void;
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
  selectionLines?(): [number, number] | undefined;
  place(position: SavedPosition): void;
  view: string;
  name: string;
  posKey: string;
  restorePosition?: boolean;
  historyKey?: string;
  url: string;
  entry?: string;
  opening?: number;
  temporary?: boolean;
  identity?: object;
  ready?(): boolean;
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
  confirmation: { text: string; context: ActionContext; choicesInText?: boolean } | null;
  notice: { message: string; kind: "error" | "info" } | null;
};
export type ControllerOptions = {
  positions?: PositionStore;
  keymap?: KeymapPort;
  url?: string;
  entry?: string;
  restoringPosition?: boolean;
  navigate?(url: string, entry?: string): void | Promise<void>;
  openTarget?(this: void, target: OpenTarget, context: ActionContext): boolean;
  back?(): boolean;
  prompt?(): PromptSpec | undefined;
  clipboard?: ClipboardPort;
  notify?(message: string, kind: "error" | "info"): void;
};
type WindowRegistration = { handle: WindowHandle; initialized: boolean };
type PendingJump = { opening: number; jump: Jump; target?: object; interaction: number };

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
  private windows = new Map<string, WindowRegistration>();
  private configured: KeymapEntry[] = [];
  private bindings = defaultKeymap;
  private keymapVersion = 0;
  private keymapWrite = Promise.resolve();
  private confirmed: (() => void | Promise<void>) | undefined;
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
  private rightUnavailable = false;
  private promptDraft = "";
  private opening = 0;
  private interaction = 0;
  private restoration: PendingJump | null = null;
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
          const line = this.currentLine();
          if (line?.editLabel && line.action) return this.run(line.action);
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
    this.actions.subscribe(() => {
      this.rebuildKeymap();
      this.update({});
    });
  }
  snapshot = (): BufferSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  update(patch: Partial<BufferSnapshot>): void {
    const before = this.state.command === null ? this.state.active : "command";
    this.state = { ...this.state, ...patch, version: this.state.version + 1 };
    const after = this.state.command === null ? this.state.active : "command";
    if (before !== after) this.recordInteraction();
    this.listeners.forEach((listener) => listener());
  }
  recordInteraction = (): void => {
    this.interaction += 1;
  };
  interactionRevision(): number {
    return this.interaction;
  }
  entries(): KeymapEntry[] {
    return this.bindings;
  }
  bindingSnapshot = (): KeymapEntry[] => this.bindings;
  private adoptKeymap(entries: KeymapEntry[]): void {
    if (entries === this.configured) return;
    this.configured = entries;
    this.rebuildKeymap();
    this.update({ prefix: "" });
  }
  private rebuildKeymap(): void {
    this.bindings = resolveKeymap(defaultKeymap, this.configured, (name) =>
      this.actions.describe(name),
    );
  }
  start(): () => void {
    const port = this.options.keymap;
    let active = true;
    let generation = 0;
    const reload = async () => {
      const request = ++generation;
      const version = this.keymapVersion;
      try {
        const config = await port!.load();
        if (active && request === generation && version === this.keymapVersion)
          this.adoptKeymap(config.entries);
      } catch (error) {
        if (active && request === generation && version === this.keymapVersion)
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
  private window(side: string): WindowHandle | undefined {
    return this.windows.get(side)?.handle;
  }
  registerWindow(side: string, handle: WindowHandle, initialize?: () => void): () => void {
    const registration = { handle, initialized: false };
    this.windows.set(side, registration);
    if (side === "right") this.rightUnavailable = false;
    const stored =
      handle.temporary || handle.restorePosition === false
        ? null
        : this.positions.position(handle.posKey);
    initialize?.();
    if (stored) handle.place(stored);
    registration.initialized = true;
    this.restoreWindow(side);
    if (this.state.active === side) this.focus(side);
    this.update({});
    return () => {
      if (!handle.temporary) {
        this.positions.setPosition(handle.posKey, handle.position());
        this.positions.flush();
      }
      if (this.windows.get(side) === registration) this.windows.delete(side);
    };
  }
  windowChanged(side: string, handle: WindowHandle): void {
    if (this.window(side) === handle) this.restoreWindow(side);
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
      const target = this.window(side);
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
      : (this.window(this.state.active)?.name ?? this.state.active);
  }
  currentLine(side = this.state.active): LineInfo | undefined {
    const window = this.window(side);
    return window?.lines()[window.position().line];
  }
  windowPosition(side: string): SavedPosition | undefined {
    return this.window(side)?.position();
  }
  currentColumn(side = this.state.active): number {
    return this.window(side)?.position().column ?? 0;
  }
  place(side: string, line: number, column: number): void {
    this.window(side)?.place({ line, column, topLine: line });
  }
  context(side = this.state.active): ActionContext {
    const window = this.window(side);
    const range = window?.selectionLines?.();
    return {
      window: side,
      view: window?.view ?? "",
      line: window?.position().line ?? 0,
      ...(range && window ? { selectedLines: window.lines().slice(range[0], range[1] + 1) } : {}),
    };
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
  private async perform(run: () => void | Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.notify(error instanceof Error ? error.message : "操作に失敗しました", "error");
    }
  }
  confirm(
    text: string,
    context: ActionContext,
    run: () => void | Promise<void>,
    choicesInText?: boolean,
  ): () => void {
    const confirmation = { text, context, choicesInText };
    this.origin = context.window;
    this.confirmed = run;
    this.update({ confirmation });
    return () => {
      if (this.state.confirmation === confirmation) this.dismissConfirmation();
    };
  }
  private dismissConfirmation(): void {
    if (!this.state.confirmation) return;
    this.confirmed = undefined;
    this.update({ confirmation: null });
  }
  answer(
    event: Pick<KeyboardEvent, "key" | "isComposing" | "ctrlKey" | "altKey" | "metaKey">,
  ): boolean {
    const confirmation = this.state.confirmation;
    const run = this.confirmed;
    if (!confirmation || !run) return false;
    if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return true;
    this.dismissConfirmation();
    this.restoreInputFocus(confirmation.context.window);
    if (
      event.key === "y" &&
      !event.isComposing &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      this.pending.add(confirmation.context.window);
      this.update({});
      void this.perform(run).finally(() => {
        this.pending.delete(confirmation.context.window);
        this.update({});
      });
    } else this.notify("やめました");
    return true;
  }
  open(): void {
    const side = this.state.active;
    const handle = this.window(side);
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
    const source = this.context(side);
    if (number) handle.place({ line: chosen.index, column: 0, topLine: chosen.index });
    const { line } = chosen;
    if (line.open) {
      this.pending.add(side);
      this.update({});
      void Promise.resolve()
        .then(line.open)
        .catch((error: unknown) => {
          this.notify(error instanceof Error ? error.message : "開けませんでした", "error");
        })
        .finally(() => {
          this.pending.delete(side);
          this.update({});
        });
    } else if (line.action) {
      const context = this.context(side);
      if (number)
        context.selectedLines = source.selectedLines ?? lines.slice(source.line, source.line + 1);
      if (this.actions.get(line.action)?.confirm) {
        void this.run(line.action, context);
        return;
      }
      this.pending.add(side);
      this.update({});
      void this.run(line.action, context).finally(() => {
        this.pending.delete(side);
        this.update({});
      });
    } else if (line.target) {
      if (this.options.openTarget?.(line.target, this.context(side))) return;
      this.pushJump(side, handle.position().line);
      void this.navigate(line.target.url);
    }
  }
  busy(side: string): boolean {
    return this.pending.has(side);
  }
  numberHint(): Hint[] {
    const chosen = menuAt(this.window(this.state.active)?.lines() ?? [], Number(this.state.number));
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
    const handle = this.window(this.state.active);
    const lines = handle?.lines() ?? [];
    const line = lines[handle?.position().line ?? 0];
    if (line?.kind === "menu" && line.action?.startsWith("conversation.choice."))
      return [
        ["open", "この選択肢を選ぶ (もう一度で外す)"],
        ["番号 Enter", "番号で選ぶ"],
        ["prompt.open", "入力"],
      ];
    if (line?.kind === "menu") return [["open", "実行する"]];
    const hints: Hint[] = line?.editLabel
      ? [
          ["prompt.open", `${line.editLabel}を書く`],
          ["back", "戻る"],
        ]
      : (this.hints.get(handle?.view ?? "") ?? []);
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
    return [...new Set(this.status.values())];
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
    this.restoreInputFocus(this.origin);
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
        jump: (line) => this.window(this.state.active)?.place({ line, column: 0, topLine: line }),
        save: (entry) => this.proposeKeymap(entry, this.context(this.origin)),
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
  private proposeKeymap(
    entry: KeymapEntry,
    context: ActionContext,
    accepted: KeymapEntry[] = [],
  ): Promise<void> {
    return this.enqueueKeymapWrite(async () => {
      const port = this.options.keymap;
      if (!port) throw new Error("キーの設定はまだ保存できません");
      for (;;) {
        const latest = port.replace ? await port.loadLatest?.() : undefined;
        const current =
          latest?.entries ?? (port.replace ? (await port.load()).entries : this.configured);
        this.adoptKeymap(current);
        const change = proposeKeymapChange(this.bindings, entry, this.actions);
        if (
          change.confirmation &&
          change.conflicts.some((item) => !includesConflict(accepted, item))
        ) {
          this.confirm(
            change.confirmation,
            context,
            () => this.proposeKeymap(entry, context, change.conflicts),
            true,
          );
          return;
        }
        const entries = [...current, ...change.additions];
        if (port.replace) {
          const saved =
            latest?.revision === undefined
              ? await port.replace(entries)
              : await port.replace(entries, latest.revision);
          if (saved === null) continue;
          this.adoptKeymap(saved.entries);
        } else {
          for (const addition of change.additions) await port.save(addition);
          this.adoptKeymap(entries);
        }
        this.keymapVersion++;
        this.notify("キーの割り当てを保存しました");
        return;
      }
    });
  }
  resetKeymap(): Promise<void> {
    return this.enqueueKeymapWrite(async () => {
      const port = this.options.keymap;
      if (!port?.replace) throw new Error("キーの割り当てを既定に戻せませんでした");
      const saved = await port.replace([]);
      if (!saved) throw new Error("キーの割り当てを既定に戻せませんでした");
      this.keymapVersion++;
      this.adoptKeymap(saved.entries);
      this.notify("キーの割り当てを既定に戻しました");
    });
  }
  private enqueueKeymapWrite(save: () => Promise<void>): Promise<void> {
    const write = this.keymapWrite.then(save);
    this.keymapWrite = write.catch(() => {});
    return write;
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
    for (const { handle } of this.windows.values()) handle.scrollCursor();
  }
  closePrompt(text = this.promptDraft): void {
    const spec = this.state.prompt;
    if (!spec) return;
    this.update({ prompt: null, mode: "NORMAL" });
    spec.close(text);
    this.restoreInputFocus(this.promptOrigin);
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
      this.restoreInputFocus(this.promptOrigin);
      return true;
    } catch (error) {
      this.notify(error instanceof Error ? error.message : "送れませんでした", "error");
      return false;
    }
  }
  openRight(view: RightView): void {
    this.cancelWindowRestoration("right");
    this.rightClosed = false;
    this.right.open(view);
    this.positions.setRight(this.right.state());
    this.update({ active: "right" });
    this.focus("right");
  }
  closeRight(): void {
    this.cancelWindowRestoration("right");
    this.rightClosed = true;
    this.right.close();
    this.positions.setRight(this.right.state());
    this.update({});
    this.focusMain();
  }
  focusMainFromRight(): void {
    this.rightUnavailable = true;
    this.cancelWindowRestoration("right");
    if (this.state.active === "right") this.focusMain();
  }
  private restoreInputFocus(origin: string): void {
    if (origin !== "right" || !this.rightUnavailable) {
      this.focus(origin);
      return;
    }
    const active = this.state.active;
    if (active !== "right" && this.window(active)) this.focus(active);
    else this.focusMain();
  }
  private focusMain(): void {
    if (this.state.command === null && this.window("main")) this.focus("main");
    else {
      this.positions.setActive("main");
      this.update({ active: "main" });
    }
  }
  private previousRight(): void {
    if (this.state.active !== "right") return;
    this.cancelWindowRestoration("right");
    this.right.back();
    this.positions.setRight(this.right.state());
    this.update({});
    if (!this.right.current) {
      this.rightClosed = true;
      this.update({});
      this.focusMain();
    }
  }
  private back(): void {
    if (this.state.active === "right") {
      this.previousRight();
      return;
    }
    if (!this.options.back?.()) this.notify("これより前の画面はありません");
  }
  screenOpening(): number {
    return this.opening;
  }
  changeScreen(
    url: string,
    entry?: string,
    restoringPosition = false,
    jump: Jump | null = null,
  ): void {
    if (url !== this.options.url || entry !== this.options.entry) {
      this.commandRevision++;
      this.commandRetry = null;
      this.closePrompt();
      this.dismissConfirmation();
    }
    this.opening += 1;
    this.options.url = url;
    this.options.entry = entry;
    this.options.restoringPosition = restoringPosition;
    this.restoration = jump ? this.pendingJump(jump) : null;
  }
  navigate(url: string, entry?: string, restoringPosition = false): void | Promise<void> {
    this.changeScreen(url, entry, restoringPosition);
    return entry === undefined ? this.options.navigate?.(url) : this.options.navigate?.(url, entry);
  }
  pushJump(side: string, line: number): void {
    const handle = this.window(side);
    if (handle?.temporary) return;
    const info = handle?.lines()[line];
    this.jumps.push({
      url: this.options.url ?? "/",
      ...(this.options.entry === undefined ? {} : { entry: this.options.entry }),
      window: side,
      line,
      ...(handle?.historyKey === undefined ? {} : { windowKey: handle.historyKey }),
      ...(info?.id ? { id: info.id } : {}),
      ...(info?.seq === undefined ? {} : { seq: info.seq }),
      ...(info?.seqLine === undefined ? {} : { seqLine: info.seqLine }),
    });
  }
  private pendingJump(jump: Jump): PendingJump {
    const handle = jump.window === "main" ? undefined : this.window(jump.window);
    return {
      opening: this.opening,
      jump,
      target: handle?.identity ?? handle,
      interaction: this.interaction,
    };
  }
  private cancelWindowRestoration(side: string): void {
    if (this.restoration?.jump.window === side) this.restoration = null;
  }
  private restoreWindow(side: string): void {
    const pending = this.restoration;
    const registration = this.windows.get(side);
    if (!pending || !registration) return;
    const { handle, initialized } = registration;
    const { jump, opening, target } = pending;
    if (
      opening !== this.opening ||
      !initialized ||
      handle.temporary ||
      handle.ready?.() === false ||
      (handle.opening !== undefined && handle.opening !== opening) ||
      jump.window !== side ||
      (jump.windowKey !== undefined && jump.windowKey !== handle.historyKey) ||
      (target !== undefined
        ? target !== (handle.identity ?? handle)
        : jump.url !== handle.url || jump.entry !== handle.entry)
    )
      return;
    this.restoration = null;
    const lines = handle.lines();
    const byId = jump.id ? lines.findIndex((line) => line.id === jump.id) : -1;
    const bySeq =
      byId < 0 && jump.seq !== undefined ? findSeqLine(lines, jump.seq, jump.seqLine) : null;
    if (pending.interaction === this.interaction) this.focus(side);
    handle.place({ line: byId >= 0 ? byId : (bySeq ?? jump.line), column: 0, topLine: jump.line });
  }
  async jumpBack(): Promise<void> {
    let opening = this.opening;
    let pending: PendingJump | null = null;
    await this.jumps.back(
      this.options.url ?? "/",
      {
        open: (url, jump) => {
          this.changeScreen(url, jump.entry, true, jump);
          opening = this.opening;
          pending = this.restoration;
          return jump.entry === undefined
            ? this.options.navigate?.(url)
            : this.options.navigate?.(url, jump.entry);
        },
        place: (jump) => {
          if (this.opening !== opening || (pending !== null && this.restoration !== pending))
            return;
          if (pending === null) this.restoration = this.pendingJump(jump);
          this.restoreWindow(jump.window);
        },
      },
      this.options.entry,
    );
  }
}
export const BufferControllerContext = createContext<BufferController | null>(null);
export const ScreenOpeningContext = createContext<number | undefined>(undefined);
