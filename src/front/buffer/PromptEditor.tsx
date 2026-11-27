import { useRef, useState } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部ライブラリのライフサイクル連携: 編集可能な CodeMirror を生成し、入力欄を閉じたら破棄する
import { useEffect } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { keymap } from "@codemirror/view";
import { getCM, vim, Vim } from "@replit/codemirror-vim";
import type { BufferController, PromptSpec } from "./controller";
import { applyVim, vimMode } from "./keymap/apply-vim";
import { eventKey } from "./keymap/notation";
export function PromptEditor({
  controller,
  spec,
  active,
}: {
  controller: BufferController;
  spec: PromptSpec;
  active: boolean;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState("INSERT");
  const [candidate, setCandidate] = useState<string | null>(null);
  const initial = useRef(spec);
  const [query, setQuery] = useState(() => controller.promptText());
  const commands = spec.commands?.filter((command) => command.name.startsWith(query.trimEnd()));
  const candidates = commands?.map((command) => command.name) ?? spec.candidates ?? [];
  const [completing, setCompleting] = useState(() => /^\/\S*$/.test(controller.promptText()));
  useEffect(() => {
    if (!host.current) return;
    const spec = initial.current;
    const text = controller.promptText();
    let cycling = false;
    let changingCompletion = false;
    let index = -1;
    let submitting = false;
    let externalChange = false;
    let completionCandidates: string[] = [];
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        selection: { anchor: text.length },
        extensions: [
          vim(),
          drawSelection(),
          keymap.of(defaultKeymap),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": spec.label }),
          EditorView.theme({
            "&": { maxHeight: "10rem", fontSize: "15px" },
            ".cm-scroller": { overflow: "auto", fontFamily: "inherit", lineHeight: "24px" },
            ".cm-content": { padding: "8px 12px" },
            "&.cm-focused": { outline: "none" },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const text = update.state.doc.toString();
              controller.setPromptDraft(text);
              setQuery(text);
              if (!externalChange) spec.change?.(text);
              setCompleting(changingCompletion || /^\/\S*$/.test(text));
              if (!changingCompletion) {
                cycling = false;
                index = -1;
                setCandidate(null);
              }
            }
          }),
        ],
      }),
    });
    const removeUpdate = controller.registerPromptUpdate((text) => {
      if (view.state.doc.toString() === text) return;
      externalChange = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      externalChange = false;
    });
    const cm = getCM(view)!;
    const syncMode = () => {
      const next = vimMode(view);
      setMode(next);
      controller.update({ mode: next });
    };
    cm.on("vim-mode-change", syncMode);
    const receive = (event: KeyboardEvent) => {
      if (event.isComposing || controller.snapshot().confirmation) return;
      const token = eventKey(event);
      const state = cm.state.vim;
      let consumed = false;
      if (token === "<Esc>") {
        consumed = true;
        if (state?.insertMode || state?.visualMode) Vim.handleKey(cm, "<Esc>", "user");
        else {
          controller.closePrompt(view.state.doc.toString());
        }
      } else if (token === "<CR>" || token === "<A-CR>") {
        consumed = true;
        if (state?.insertMode && token === "<CR>")
          view.dispatch({
            changes: {
              from: view.state.selection.main.from,
              to: view.state.selection.main.to,
              insert: "\n",
            },
            selection: { anchor: view.state.selection.main.from + 1 },
            scrollIntoView: true,
          });
        else if (
          !state?.insertMode &&
          !state?.visualMode &&
          !submitting &&
          (token !== "<A-CR>" || spec.interrupt)
        ) {
          submitting = true;
          void controller.submitPrompt(view.state.doc.toString(), token === "<A-CR>").then(() => {
            submitting = false;
          });
        }
      } else if (token === "<Tab>") {
        consumed = true;
        const text = view.state.doc.toString();
        if (!cycling)
          completionCandidates =
            spec.commands
              ?.filter((command) => command.name.startsWith(text))
              .map((command) => command.name) ??
            spec.candidates ??
            [];
        if ((cycling || /^\/\S*$/.test(text)) && completionCandidates.length) {
          index = (index + 1) % completionCandidates.length;
          const candidate = `${completionCandidates[index]} `;
          changingCompletion = true;
          view.dispatch({
            changes: { from: 0, to: text.length, insert: candidate },
            selection: { anchor: candidate.length },
          });
          changingCompletion = false;
          cycling = true;
          setCandidate(completionCandidates[index]);
        }
      } else if (token === ":" && !state?.insertMode) {
        consumed = true;
        controller.openCommand();
      }
      if (consumed) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const paste = (event: ClipboardEvent) => {
      const images = [...(event.clipboardData?.files ?? [])].filter((file) =>
        file.type.startsWith("image/"),
      );
      if (images.length && spec.paste) {
        event.preventDefault();
        spec.paste(images);
      }
    };
    view.dom.addEventListener("keydown", receive, true);
    view.dom.addEventListener("paste", paste, true);
    const removeKeys = applyVim(view, controller, "prompt", "prompt", true);
    const focus = () => controller.focus("prompt");
    view.dom.addEventListener("focusin", focus);
    const removeFocus = controller.registerPromptFocus(() => {
      view.focus();
      syncMode();
    });
    Vim.handleKey(cm, "a", "user");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    controller.focus("prompt");
    return () => {
      removeUpdate();
      removeFocus();
      removeKeys();
      cm.off("vim-mode-change", syncMode);
      view.dom.removeEventListener("keydown", receive, true);
      view.dom.removeEventListener("paste", paste, true);
      view.dom.removeEventListener("focusin", focus);
      view.destroy();
    };
  }, [controller]);
  return (
    <div
      className={`mx-2 mb-2 shrink-0 rounded-lg border ${active ? "border-accent" : "border-line"} bg-raised shadow-lg`}
      aria-label={spec.label}
    >
      <div className="flex items-center gap-3 px-3 pt-2 text-xs">
        <span className="font-bold">{spec.label}</span>
        <span className="text-muted">{spec.target}</span>
      </div>
      {spec.quote?.length ? (
        <div className="px-3 text-xs text-muted">
          {spec.quote.slice(0, 5).map((line, index) => (
            <div key={`${index}:${line}`}>
              <span className="mr-3 font-mono">{index + 1}</span>
              {line}
            </div>
          ))}
          {spec.quote.length > 5 ? <div>…ほか {spec.quote.length - 5} 行</div> : null}
        </div>
      ) : null}
      {completing && candidates.length ? (
        <div
          aria-label="スキルの候補"
          className="flex gap-3 overflow-hidden px-3 pt-2 font-mono text-[13px]"
        >
          {candidates.map((text, index) => (
            <span
              key={text}
              className={text === (candidate ?? candidates[0]) ? "text-accent" : "text-muted"}
            >
              {text}
              {commands ? ` ${commands[index].description.split("\n")[0]}` : ""}
            </span>
          ))}
          <span className="text-muted">Tab で選ぶ</span>
        </div>
      ) : null}
      {completing && spec.commands?.length === 0 ? (
        <div className="px-3 pt-2 text-[13px] text-muted">最初の指示を送ると候補が出ます</div>
      ) : null}
      <div ref={host} />
      {spec.unsent ? (
        <div className="px-3 pb-2 text-[13px] text-wait">未送信: {spec.unsent}</div>
      ) : null}
      <div className="px-3 pb-2 text-xs text-muted">
        {mode === "INSERT" || mode === "REPLACE"
          ? `Esc Normal へ (${spec.verb}のは Normal から)`
          : `Enter ${spec.verb}　${spec.interrupt ? "Alt+Enter AI を止めてすぐ送る　" : ""}Esc 閉じる (書きかけは残る)`}
        {spec.images ? (
          <span className="ml-4 text-accent">画像 {spec.images} 件 (送信時に一緒に送る)</span>
        ) : null}
      </div>
    </div>
  );
}
