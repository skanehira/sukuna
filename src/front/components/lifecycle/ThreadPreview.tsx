import { useMemo } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部システムとの同期: スレッドを表示している間だけ配信先へ閲覧中と伝える
import { useEffect } from "react";
import type { ServerMessage } from "../../../shared/ws";
import { Frame } from "../../buffer/Frame";
import type { LineInfo } from "../../buffer/line";
import { ConversationApiError } from "../../lib/conversation/api";
import { eventLines } from "../../lib/conversation/lines";
import type { ConversationApi, Event } from "../../lib/conversation/types";
import { singleLine } from "../../lib/lifecycle/rows";
import { LifecycleBuffer } from "./LifecycleBuffer";
import { useLifecycleData, type LifecycleFeed } from "./use-lifecycle";

export const threadView = "thread";

function threadChanged(message: ServerMessage) {
  return message.type === "event" || message.type === "state" || message.type === "changed";
}

async function loadThread(api: ConversationApi, id: string, parentId: string) {
  const { conversation } = await api.get(id);
  if (conversation.kind !== "thread" || conversation.parentConversationId !== parentId)
    throw new ConversationApiError(404, "not_found", "この会話のスレッドが見つかりません");
  const events: Event[] = [];
  let after = 0;
  while (true) {
    const page = await api.events(id, after);
    events.push(...page.events);
    if (!page.hasMore) break;
    const next = page.events.at(-1)?.seq ?? after;
    if (next <= after) throw new Error("スレッドの続きが読み込めませんでした");
    after = next;
  }
  const lines = events.flatMap((event) => eventLines(event, id, conversation.cwd, null, false));
  return { title: conversation.title, lines, lastSeq: events.at(-1)?.seq ?? 0 };
}

export function ThreadPreview({
  api,
  id,
  parentId,
  subscribe,
  showConversation,
}: {
  api: ConversationApi;
  id: string;
  parentId: string;
  subscribe: LifecycleFeed;
  showConversation: (id: string) => () => void;
}) {
  const { data, error } = useLifecycleData(
    ["thread-preview", api, id, parentId],
    () => loadThread(api, id, parentId),
    subscribe,
    "conversation:" + id,
    threadChanged,
    (thread) => thread.lastSeq,
  );
  const missing = error instanceof ConversationApiError && error.status === 404;
  const thread = missing ? undefined : data;
  const displayed = thread !== undefined;
  useEffect(() => {
    if (displayed) return showConversation(id);
  }, [displayed, id, showConversation]);
  const lines = useMemo((): LineInfo[] => {
    const failure = error
      ? {
          kind: "note" as const,
          text: error instanceof Error ? singleLine(error.message) : "スレッドを読めませんでした",
        }
      : undefined;
    if (!thread) return [failure ?? { kind: "skeleton", text: "読み込み中" }];
    const content: LineInfo[] = thread.lines.length
      ? thread.lines
      : [{ kind: "note", text: "このスレッドにまだ記録はありません" }];
    return failure ? [...content, failure] : content;
  }, [thread, error]);
  return (
    <Frame title={thread ? "スレッド: " + thread.title : "スレッド"} side="right">
      <LifecycleBuffer side="right" viewName={threadView} lines={lines} temporary={!displayed} />
    </Frame>
  );
}
