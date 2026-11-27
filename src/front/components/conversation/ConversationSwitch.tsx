import { useRef } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部システムとの同期: メニューのキー操作を登録し、表示を閉じたら解除する
import { useEffect } from "react";
import useSWR from "swr";
import { Buffer, type BufferHandle } from "../../buffer/Buffer";
import type { BufferController } from "../../buffer/controller";
import { Frame } from "../../buffer/Frame";
import { switchLines } from "../../lib/conversation/lines";
import type { ConversationApi } from "../../lib/conversation/types";

export function registerConversationSwitch(controller: BufferController): () => void {
  return controller.actions.register({
    name: "conversation.switch",
    label: "会話を始める・切り替える",
    group: "開く・戻る",
    where: "どこでも",
    run: () => controller.openRight({ view: "conversation-switch", target: "" }),
  });
}

export function ConversationSwitch({
  api,
  controller,
  currentProject,
}: {
  api: ConversationApi;
  controller: BufferController;
  currentProject?: string;
}) {
  const { data, error } = useSWR(["conversation-projects", api], () => api.projects(), {
    shouldRetryOnError: false,
  });
  const handle = useRef<BufferHandle | null>(null);
  useEffect(() => {
    const lines = data
      ? switchLines(data, currentProject)
      : [
          {
            kind: "note" as const,
            text: error ? "会話の一覧を取得できませんでした" : "読み込み中",
          },
        ];
    handle.current?.replaceAll(lines, { ready: data !== undefined });
    const removers =
      data?.flatMap((project) =>
        [false, ...(project.id === currentProject ? [true] : [])].map((worktree) =>
          controller.actions.register({
            name: `conversation.${worktree ? "worktree" : "start"}.${project.id}`,
            label: "会話を始める",
            group: "会話",
            where: "会話を始める・切り替える",
            views: ["conversation-switch"],
            run: async () => {
              const { conversation } = await api.start(project.id, worktree);
              controller.closeRight();
              await controller.navigate(`/conversations/${encodeURIComponent(conversation.id)}`);
              controller.notify(
                worktree
                  ? `worktree ${conversation.worktree?.name ?? ""} を作り、その中で会話を始めました`
                  : `${project.name} で会話を始めました (プロジェクトのディレクトリ)`,
              );
            },
          }),
        ),
      ) ?? [];
    return () => removers.forEach((remove) => remove());
  }, [data, error, currentProject, api, controller]);
  return (
    <Frame title="会話を始める・切り替える" side="right">
      <Buffer
        ready={false}
        side="right"
        viewName="conversation-switch"
        lines={[]}
        onReady={(value) => {
          handle.current = value;
        }}
      />
    </Frame>
  );
}
