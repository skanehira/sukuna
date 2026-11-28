import { useSyncExternalStore, type ReactNode } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部システムとの同期: 会話画面のキーと入力欄の操作を登録し、画面を離れると解除する
import { useEffect } from "react";
import { Buffer } from "../../buffer/Buffer";
import type { BufferMarks } from "../../buffer/marks";
import { Frame } from "../../buffer/Frame";
import type { ColumnDef, LineInfo } from "../../buffer/line";
import type { ConversationSession } from "../../lib/conversation/session";
import type { WorkMonitor } from "../../lib/conversation/work-monitor";

const empty: LineInfo[] = [];

const loading = [{ kind: "skeleton" as const, text: "読み込み中" }];
export function ConversationPage({
  session,
  activity,
  openAtTail = false,
  subscribe,
  recordSeq,
  recordLine,
  recordColumn,
  marks,
  positionKey,
  title,
  tabs,
  head = empty,
  footer = empty,
  columns,
  monitor,
}: {
  session: ConversationSession;
  activity?: ReactNode;
  openAtTail?: boolean;
  subscribe?: (session: ConversationSession, monitor?: WorkMonitor) => () => void;
  recordSeq?: number;
  recordLine?: number;
  recordColumn?: number;
  marks?: BufferMarks;
  positionKey?: string;
  title?: string;
  tabs?: ReactNode;
  head?: LineInfo[];
  footer?: LineInfo[];
  columns?: ColumnDef[];
  monitor?: WorkMonitor;
}) {
  const { data } = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  useEffect(() => {
    const disconnect = session.connect(monitor);
    const unsubscribe = subscribe?.(session, monitor);
    return () => {
      unsubscribe?.();
      disconnect();
    };
  }, [session, subscribe, monitor]);
  useEffect(() => {
    session.surround(head, footer);
  }, [session, head, footer]);
  return (
    <Frame title={title ?? (data ? `会話: ${data.conversation.title}` : "会話")} side="main" active>
      {tabs}
      <Buffer
        side="main"
        viewName="conversation"
        posKey={positionKey ?? `/conversations/${session.id}:main`}
        lines={loading}
        marks={marks}
        columns={columns}
        followTail
        scrollPastEnd
        restorePosition={
          recordSeq !== undefined ||
          (!openAtTail && (session.controller.options.restoringPosition === true || !session.recap))
        }
        onReady={(handle) => {
          session.surround(head, footer);
          session.bind(handle, openAtTail);
          if (recordSeq === undefined) return;
          let record = handle.findSeq(recordSeq, recordLine);
          if (record === null && recordLine !== undefined) {
            session.expandDiff(recordSeq, true);
            record = handle.findSeq(recordSeq, recordLine);
          }
          if (record !== null) handle.jumpTo(record, { remember: false, column: recordColumn });
        }}
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
