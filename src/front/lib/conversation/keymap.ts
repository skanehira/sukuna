import type { CommandInfo } from "../../buffer/commands";
import type { ActionInfo } from "../../buffer/keymap/registry";

export function conversationAction(
  name: string,
  label: string,
  group: ActionInfo["group"] = "会話",
): ActionInfo {
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

export const conversationCommands = {
  stop: { name: "stop", label: "AI を止める", where: "会話" },
  images: { name: "images", label: "画像を外す", where: "会話" },
} satisfies Record<string, CommandInfo>;
