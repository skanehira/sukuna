import type { CommandInfo } from "../../buffer/commands";
import type { ActionInfo } from "../../buffer/keymap/registry";
import { conversationActions } from "../conversation/keymap";

export function recapAction(
  name: string,
  label: string,
  views: string[],
  where = "会話",
): ActionInfo & { views: string[] } {
  return { name, label, group: "状況を思い出す", where, views };
}

const openFrom = ["conversation", "recent", "toc", "decisions", "recap-search"];

export const recapActions = {
  recent: recapAction("recap.recent", "直近", openFrom),
  toc: recapAction("recap.toc", "目次", openFrom),
  decisions: recapAction("recap.decisions", "決まったこと", openFrom),
  search: recapAction(
    "recap.search",
    "目次と決まったことを検索する",
    ["toc", "decisions"],
    "目次・決まったこと",
  ),
};

const editable = ["toc", "decisions"];
const editingPlace = "目次・決定";
export const recapItemActions = {
  edit: recapAction(conversationActions.editItem.name, "直す", editable, editingPlace),
  delete: recapAction(conversationActions.deleteItem.name, "消す", editable, editingPlace),
  undo: recapAction(conversationActions.undoItem.name, "戻す", editable, editingPlace),
};

export const recapCommands = {
  toc: { name: "toc", label: "章の始まりを移す", where: "会話" },
} satisfies Record<string, CommandInfo>;
