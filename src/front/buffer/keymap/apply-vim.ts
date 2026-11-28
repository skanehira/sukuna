import { getCM, Vim } from "@replit/codemirror-vim";
import type { EditorView } from "@codemirror/view";
import type { BufferController, Mode } from "../controller";
import { copyText } from "../clipboard";
import { eventKey, parseKeys } from "./notation";
import type { BufferSelection } from "../selection";
import type { ActionContext, KeymapEntry } from "./registry";

export function vimMode(view: EditorView): Mode {
  const state = getCM(view)?.state.vim;
  if (state?.insertMode) return state.mode === "replace" ? "REPLACE" : "INSERT";
  if (state?.visualMode)
    return state.visualBlock ? "VISUAL BLOCK" : state.visualLine ? "VISUAL LINE" : "VISUAL";
  return "NORMAL";
}
export function vimCount(view: EditorView): string {
  const count = getCM(view)?.state.vim?.inputState.keyBuffer.join("") ?? "";
  return /^[1-9]\d*$/.test(count) ? count : "";
}

function bufferSelection(view: EditorView): BufferSelection | undefined {
  const state = getCM(view)?.state.vim;
  if (!state?.visualMode) return;
  const mode = state.visualBlock ? "block" : state.visualLine ? "line" : "char";
  const { doc, selection } = view.state;
  const ranges = selection.ranges.flatMap(({ from, to }) => {
    const first = doc.lineAt(from);
    const last = doc.lineAt(to > from && mode === "line" ? to - 1 : to);
    const result = [];
    for (let number = first.number; number <= last.number; number++) {
      const line = doc.line(number);
      result.push({
        line: number - 1,
        from: Math.max(0, from - line.from),
        to: Math.min(line.length, to - line.from),
      });
    }
    return result;
  });
  if (mode !== "block") return { mode, ranges };
  const { anchor, head } = state.sel;
  const from = Math.min(anchor.ch, head.ch);
  const to = Math.max(anchor.ch, head.ch) + 1;
  return Number.isFinite(to) ? { mode, ranges, block: { from, to } } : { mode, ranges };
}

export function applyVim(
  view: EditorView,
  controller: BufferController,
  side: string,
  viewName: string,
  prompt = false,
): () => void {
  const cm = getCM(view);
  if (!cm) return () => {};
  let prefix = "";
  let attached = true;
  const syncMode = () => {
    if (controller.snapshot().active === side && view.hasFocus) {
      controller.update({ mode: vimMode(view) });
    }
  };
  const modeChanged = prompt
    ? syncMode
    : () => {
        queueMicrotask(() => {
          if (attached) syncMode();
        });
      };
  cm.on("vim-mode-change", modeChanged);
  const copied = (key: string) => {
    syncMode();
    if (key === "y" && controller.options.clipboard) {
      const register = Vim.getVimGlobalState_().registerController.getRegister('"');
      void copyText(register.toString(), controller.options.clipboard);
    }
  };
  cm.on("vim-keypress", copied);
  const invoke = (entry: KeymapEntry, context: ActionContext) => {
    if (!entry.to) return;
    const mode = getCM(view)?.state.vim?.visualMode ? "visual" : "normal";
    if ("keys" in entry.to) {
      const keys = entry.to.keys;
      Vim.noremap(entry.keys, keys, mode);
    } else {
      const name = entry.to.action;
      Vim.defineAction("sukunaDispatch", () => {
        if (context.selection && (name === "stock.question" || name === "stock.instruct"))
          Vim.handleKey(cm, "<Esc>", "mapping");
        void controller.run(name, context);
      });
      Vim.mapCommand(entry.keys, "action", "sukunaDispatch", {}, { context: mode });
    }
    try {
      Vim.handleKey(cm, entry.keys, "user");
    } finally {
      Vim.unmap(entry.keys, mode);
    }
  };
  const receive = (event: KeyboardEvent) => {
    if (controller.answer(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.isComposing || event.defaultPrevented) return;
    prefix = controller.snapshot().prefix;
    const token = eventKey(event);
    if (!token) return;
    if (event.ctrlKey && event.key === "[" && event.target !== view.contentDOM) {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.target?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      return;
    }
    if (event.target !== view.contentDOM && !(event.ctrlKey && event.key === "[")) return;
    const state = cm.state.vim;
    if (state?.insertMode || (state?.expectLiteralNext && !prefix)) return;
    const context = state?.visualMode ? "visual" : prompt ? "prompt" : "normal";
    const allowed = controller.entries().filter((entry) => {
      if (entry.context !== context || entry.to === null) return false;
      if ("keys" in entry.to) return true;
      return controller.canRun(entry.to.action, viewName, prompt);
    });
    const full = `${prefix}${token}`;
    const matches = allowed.filter((entry) => entry.keys.startsWith(full));
    const exact = matches.find((entry) => entry.keys === full);
    const consume = () => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    if (token === "<Esc>" && !exact) {
      consume();
      prefix = "";
      controller.update({ prefix: "", number: "", notice: null });
      Vim.handleKey(cm, "<Esc>", "user");
      return;
    }
    if (exact) {
      consume();
      if (exact.to && "action" in exact.to && exact.to.action === "open") {
        const count = vimCount(view);
        if (count) Vim.handleKey(cm, "<Esc>", "mapping");
        controller.update({ number: count });
      }
      prefix = "";
      controller.update({ prefix: "" });
      const selection = bufferSelection(view);
      invoke(exact, {
        ...controller.context(side),
        view: viewName,
        text: cm.getSelection(),
        selection,
      });
      return;
    }
    if (matches.length > 0 || full === "<Space>" || full === "<C-w>") {
      consume();
      prefix = full;
      controller.update({ prefix });
      return;
    }
    const previous = prefix;
    prefix = "";
    controller.update({ prefix: "" });
    if (previous.startsWith("<Space>") || previous.startsWith("<C-w>")) {
      consume();
      return;
    }
    if (previous) {
      for (const key of parseKeys(previous) ?? []) Vim.handleKey(cm, key, "user");
    }
    const count = `${cm.state.vim?.inputState.keyBuffer.join("") ?? ""}${token}`;
    controller.update({ number: /^[1-9]\d*$/.test(count) ? count : "" });
  };
  view.dom.addEventListener("keydown", receive, true);
  return () => {
    attached = false;
    view.dom.removeEventListener("keydown", receive, true);
    cm.off("vim-mode-change", modeChanged);
    cm.off("vim-keypress", copied);
  };
}
