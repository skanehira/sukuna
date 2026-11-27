import { useSyncExternalStore, type ReactNode } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部システムとの同期: 会話画面のキーと入力欄の操作を登録し、画面を離れると解除する
import { useEffect } from "react";
import { Buffer } from "../../buffer/Buffer";
import { Frame } from "../../buffer/Frame";
import type { ConversationSession } from "../../lib/conversation/session";

const loading = [{ kind: "skeleton" as const, text: "読み込み中" }];
export function ConversationPage({
  session,
  activity,
  openAtTail = false,
  subscribe,
}: {
  session: ConversationSession;
  activity?: ReactNode;
  openAtTail?: boolean;
  subscribe?: (session: ConversationSession) => () => void;
}) {
  const { data } = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  useEffect(() => {
    const disconnect = session.connect();
    const unsubscribe = subscribe?.(session);
    return () => {
      unsubscribe?.();
      disconnect();
    };
  }, [session, subscribe]);
  return (
    <Frame title={data ? `会話: ${data.conversation.title}` : "会話"} side="main" active>
      <Buffer
        side="main"
        viewName="conversation"
        posKey={`/conversations/${session.id}:main`}
        lines={loading}
        followTail
        scrollPastEnd
        onReady={(handle) => session.bind(handle, openAtTail)}
      />
      {data?.conversation.runState === "working" && activity ? (
        <div
          className="shrink-0 border-t border-line px-4 py-2 text-[13px] text-doing"
          aria-label="作業中の状況"
        >
          {activity}
        </div>
      ) : null}
    </Frame>
  );
}
