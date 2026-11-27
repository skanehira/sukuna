import type { ActionRegistry, HelpGroup, KeymapEntry } from "./keymap/registry";
import { displayKeys } from "./keymap/notation";
import { vimKeys } from "./keymap/vim-builtins";
import type { LineInfo } from "./line";
import type { CommandRegistry } from "./commands";
export const helpGroups: HelpGroup[] = [
  "開く・戻る",
  "ウィンドウ",
  "会話",
  "質問と指示",
  "状況を思い出す",
  "そのほか",
];
export function helpLines(
  entries: KeymapEntry[],
  actions: ActionRegistry,
  commands: CommandRegistry,
): LineInfo[] {
  const lines: LineInfo[] = [
    { kind: "note", text: "Ctrl を使うキーは macOS のブラウザを前提にしています。" },
  ];
  for (const group of helpGroups) {
    lines.push({ kind: "heading", text: group });
    for (const action of actions.all().filter((value) => value.group === group)) {
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
      lines.push({ kind: "pair", text: cols.join("  "), cols });
    }
  }
  lines.push({ kind: "heading", text: "コマンド" });
  for (const command of commands.all())
    lines.push({ kind: "text", text: `:${command.name}  ${command.label}` });
  lines.push(
    { kind: "heading", text: "移動と選択 (Vim と同じ)" },
    { kind: "text", text: vimKeys.map(displayKeys).join("、") },
  );
  return lines;
}
