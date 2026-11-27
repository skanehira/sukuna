import { resolve } from "node:path";
import { decisionFilePath } from "../../../../shared/recap/decision-file-store";
import type { DecisionFileStore } from "../../../../shared/recap/ports";
import type { RunOptions } from "../../conversation/usecase/run-options";
import type { AppTool } from "../../conversation/domain/agent-port";
import type { RecapRepository } from "../domain/repository";

export function registerRecapInstructions(
  options: RunOptions,
  repository: Pick<RecapRepository, "projectPath">,
) {
  options.registerInstructions((conversation) => {
    const project = repository.projectPath(conversation.projectId);
    if (!project) return "";
    const path = resolve(project, decisionFilePath(conversation.id));
    return `この会話で決まったことの一覧は ${path} にある。前に決めたことを尋ねられたら、このファイルを読んで答える。目次はツール recap_read で読める。`;
  });
  options.registerAdditionalDirectories((conversation) => {
    const project = repository.projectPath(conversation.projectId);
    return project && resolve(project) !== resolve(conversation.cwd) ? [project] : [];
  });
}

export function recapRead(
  repository: Pick<RecapRepository, "get" | "chapters">,
  files: DecisionFileStore,
): AppTool {
  return {
    name: "recap_read",
    description: "この会話の目次と決まったことの一覧を読む。",
    input: {},
    alwaysLoad: true,
    async handler(_input, { conversationId }) {
      const conversation = repository.get(conversationId);
      if (!conversation) return { text: "会話が見つかりません。", isError: true };
      const file = files.read(conversation.path, conversationId);
      if (file.isErr()) return { text: file.error.message, isError: true };
      const chapters = repository.chapters(conversationId);
      const rows = chapters.map(({ position, title, startSeq }, index) => {
        const next = chapters[index + 1];
        return `${position}. ${title} (seq ${startSeq}〜${next ? next.startSeq - 1 : ""})`;
      });
      return {
        text: ["# 目次", ...rows, "", "# 決まったことの一覧", file.value.content].join("\n"),
        isError: false,
      };
    },
  };
}
