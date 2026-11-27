import { getCM, Vim } from "@replit/codemirror-vim";
import type { EditorView } from "@codemirror/view";
import type { BufferController, Mode } from "../controller";
import { copyText } from "../clipboard";
import { eventKey, parseKeys } from "./notation";
import type { ActionContext, KeymapEntry } from "./registry";

export function vimMode(view: EditorView): Mode {
  const state = getCM(view)?.state.vim;
  if (state?.insertMode) return state.mode === "replace" ? "REPLACE" : "INSERT";
  if (state?.visualMode)
    return state.visualBlock ? "VISUAL BLOCK" : state.visualLine ? "VISUAL LINE" : "VISUAL";
  return "NORMAL";
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
  const mode = () => {
    controller.update({ mode: vimMode(view) });
  };
  cm.on("vim-mode-change", mode);
  const copied = (key: string) => {
    controller.update({ mode: vimMode(view) });
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
      const action = controller.actions.get(entry.to.action);
      return (
        action !== undefined &&
        (!prompt || action.fromPrompt || action.name === "cmdline") &&
        (!action.views || action.views.includes(viewName))
      );
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
      const count = cm.state.vim?.inputState.keyBuffer.join("") ?? "";
      if (/^\d+$/.test(count) && exact.to && "action" in exact.to && exact.to.action === "open") {
        Vim.handleKey(cm, "<Esc>", "user");
        controller.update({ number: count });
      }
      prefix = "";
      controller.update({ prefix: "" });
      invoke(exact, { ...controller.context(side), view: viewName, text: cm.getSelection() });
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
    view.dom.removeEventListener("keydown", receive, true);
    cm.off("vim-mode-change", mode);
    cm.off("vim-keypress", copied);
  };
}
