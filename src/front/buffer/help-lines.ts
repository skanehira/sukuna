import type { ActionInfo, ActionRegistry, HelpGroup, KeymapEntry } from "./keymap/registry";
import { displayKeys } from "./keymap/notation";
import { vimKeys } from "./keymap/vim-builtins";
import type { LineInfo } from "./line";
import type { CommandInfo, CommandRegistry } from "./commands";
export const helpGroups: HelpGroup[] = [
  "開く・戻る",
  "ウィンドウ",
  "会話",
  "質問と指示",
  "状況を思い出す",
  "そのほか",
];
const actionOrder = new Map(
  [
    "open",
    "back",
    "view.prev",
    "view.next",
    "jump.back",
    "home",
    "tree.focus",
    "conversation.switch",
    "conversation.list",
    "conversation.close",
    "files.open-path",
    "win.left",
    "win.right",
    "win.down",
    "win.up",
    "right.close",
    "prompt.open",
    "prompt.submit",
    "prompt.interrupt",
    "prompt.complete",
    "prompt.image.prev",
    "prompt.image.next",
    "prompt.image.delete",
    "prompt.image.open",
    "prompt.image.leave",
    "prompt.image.insert",
    "agent.stop",
    "diff.expand",
    "diff.collapse",
    "stock.question",
    "stock.instruct",
    "stock.list",
    "item.edit",
    "item.delete",
    "item.undo",
    "mark.next",
    "mark.prev",
    "stock.send.all",
    "stock.send.questions",
    "stock.send.instructions",
    "stock.publish",
    "thread.list",
    "recap.recent",
    "recap.toc",
    "recap.decisions",
    "recap.search",
    "cmdline",
    "issue.new",
    "timeline.open",
    "timeline.next",
    "timeline.prev",
    "files.tree",
    "files.folder-open",
    "files.folder-close",
    "files.grep",
    "files.markdown-toggle",
    "search.open",
    "worktree.list",
    "terminal.open",
    "terminal.normal",
  ].map((name, index) => [name, index]),
);

export function helpLines(
  entries: KeymapEntry[],
  actions: ActionRegistry | ActionInfo[],
  commands: CommandRegistry | CommandInfo[],
  column?: string,
): LineInfo[] {
  const lines: LineInfo[] = [
    { kind: "note", text: "Ctrl を使うキーは macOS のブラウザを前提にしています。" },
  ];
  const allActions = Array.isArray(actions) ? actions : actions.snapshot();
  for (const group of helpGroups) {
    lines.push({ kind: "heading", text: group });
    const groupActions = allActions
      .filter((value) => value.group === group)
      .sort(
        (a, b) => (actionOrder.get(a.name) ?? Infinity) - (actionOrder.get(b.name) ?? Infinity),
      );
    for (const action of groupActions) {
      const keys =
        [
          ...new Set(
            entries
              .filter(
                (entry) =>
                  entry.to !== null && "action" in entry.to && entry.to.action === action.name,
              )
              .map((entry) => displayKeys(entry.keys)),
          ),
        ].join("、") || "—";
      const cols = [keys, action.label, action.where];
      lines.push({
        kind: "pair",
        text: cols.join("  "),
        cols,
        ...(column
          ? {
              id: action.name,
              colDef: column,
              status: `名前: ${action.name}  (:map <キー> ${action.name} で割り当てる)`,
            }
          : {}),
      });
    }
  }
  lines.push({ kind: "heading", text: "コマンド" });
  const allCommands = Array.isArray(commands) ? commands : commands.all();
  for (const command of allCommands) {
    const cols = [`:${command.name}`, command.label, command.where ?? "共通"];
    lines.push(
      column
        ? { kind: "pair", id: `:${command.name}`, colDef: column, text: cols.join("  "), cols }
        : { kind: "text", text: `:${command.name}  ${command.label}` },
    );
  }
  if (column) {
    for (const [keys, label] of [
      [":q", "右を閉じる・前の画面へ戻る"],
      [":map <キー> <動作>", "Normal のキーを割り当てる"],
      [":unmap <キー>", "Normal の割り当てを外す"],
      [":tmap <キー> <動作>", "ターミナルのキーを割り当てる"],
      [":tunmap <キー>", "ターミナルの割り当てを外す"],
    ]) {
      const cols = [keys, label, "共通"];
      lines.push({ kind: "pair", id: keys, colDef: column, text: cols.join("  "), cols });
    }
  }
  lines.push({ kind: "heading", text: "移動と選択 (Vim と同じ)" });
  const labels: Record<KeymapEntry["context"], string> = {
    normal: "Normal",
    visual: "Visual",
    prompt: "入力欄",
    "prompt-images": "入力欄の画像の段",
    terminal: "ターミナル",
  };
  for (const entry of entries) {
    if (!entry.to || !("keys" in entry.to)) continue;
    const cols = [
      displayKeys(entry.keys),
      `Vim: ${displayKeys(entry.to.keys)}`,
      labels[entry.context],
    ];
    lines.push({
      kind: "pair",
      text: cols.join("  "),
      cols,
      ...(column ? { id: `vim:${entry.context}:${entry.keys}`, colDef: column } : {}),
    });
  }
  const globalMappings = entries.filter(({ context, to }) => {
    if (context !== "normal" || to === null) return false;
    return "keys" in to || allActions.some((action) => action.name === to.action && !action.views);
  });
  const available = vimKeys.filter(
    (keys) => !globalMappings.some((entry) => keys.startsWith(entry.keys)),
  );
  lines.push({ kind: "text", text: available.map(displayKeys).join("、") });
  return lines;
}
