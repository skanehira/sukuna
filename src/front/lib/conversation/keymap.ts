import type { CommandInfo } from "../../buffer/commands";
import type { ActionInfo } from "../../buffer/keymap/registry";

type ScopedAction = ActionInfo & { views: string[] };

export function conversationAction(
  name: string,
  label: string,
  group: ActionInfo["group"] = "会話",
): ScopedAction {
  return { name, label, group, where: "会話", views: ["conversation"] };
}

export const conversationActions = {
  stop: conversationAction("agent.stop", "AI を止める"),
  resume: conversationAction("conversation.resume", "再開する"),
  sendQueue: conversationAction("conversation.queue.send", "届く前の指示を送る"),
  deleteItem: conversationAction("item.delete", "預けた指示を取り消す", "質問と指示"),
  editItem: conversationAction("item.edit", "預けた指示を直す", "質問と指示"),
  undoItem: conversationAction("item.undo", "預けた指示を戻す", "質問と指示"),
  sendAnswers: conversationAction("conversation.answers.send", "回答をまとめて送る"),
  confirmAnswers: conversationAction("conversation.answers.confirm", "回答を送る"),
  answered: conversationAction("conversation.answered", "送った回答"),
  expandDiff: conversationAction("diff.expand", "差分を開く"),
  collapseDiff: conversationAction("diff.collapse", "差分を畳む"),
};

const itemLabels: Record<string, string> = {
  [conversationActions.deleteItem.name]: "選んだ項目を消す",
  [conversationActions.editItem.name]: "選んだ項目を直す",
  [conversationActions.undoItem.name]: "消した項目を戻す",
};

export function conversationActionHelp(additionalItems: ScopedAction[]): ActionInfo[] {
  return Object.values(conversationActions).map((action) => {
    const additional = additionalItems.filter((item) => item.name === action.name);
    if (additional.length === 0) return action;
    const places = [action, ...additional];
    return {
      ...action,
      label: itemLabels[action.name] ?? action.label,
      where: places.map((place) => place.where).join("・"),
      views: places.flatMap((place) => place.views),
    };
  });
}

export const conversationCommands = {
  stop: { name: "stop", label: "AI を止める", where: "会話" },
  images: { name: "images", label: "画像を外す", where: "会話" },
} satisfies Record<string, CommandInfo>;
