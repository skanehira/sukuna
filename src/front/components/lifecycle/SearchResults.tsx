import { useMemo } from "react";
import { Frame } from "../../buffer/Frame";
import type { LineInfo } from "../../buffer/line";
import type { ConversationApi } from "../../lib/conversation/types";
import type { LifecycleApi } from "../../lib/lifecycle/api";
import { lifecycleColumns, searchLines, singleLine } from "../../lib/lifecycle/rows";
import { LifecycleBuffer } from "./LifecycleBuffer";
import {
  inboxChanged,
  type LifecycleClock,
  useElapsedClock,
  useLifecycleData,
  type LifecycleFeed,
} from "./use-lifecycle";

export const searchTitle = "issue と会話を検索";
export const searchView = "search";

export function SearchResults({
  api,
  conversations,
  query,
  subscribe,
  clock,
}: {
  api: LifecycleApi;
  conversations: ConversationApi;
  query: string;
  subscribe: LifecycleFeed;
  clock: LifecycleClock;
}) {
  const { data, error } = useLifecycleData(
    query ? ["lifecycle-search", api, conversations, query] : null,
    async () => {
      const [results, projects] = await Promise.all([api.search(query), conversations.projects()]);
      return { ...results, projects };
    },
    subscribe,
    "inbox",
    inboxChanged,
  );
  const now = useElapsedClock(clock);
  const lines = useMemo((): LineInfo[] => {
    if (!query) return [{ kind: "note", text: "検索する語を入れてください" }];
    if (!data)
      return [
        {
          kind: error ? "note" : "skeleton",
          text:
            error instanceof Error
              ? singleLine(error.message)
              : error
                ? "検索できませんでした"
                : "読み込み中",
        },
      ];
    const heading =
      "「" +
      singleLine(query) +
      "」を含む issue と会話   " +
      data.results.length +
      " 件" +
      (data.truncated ? " (100 件まで)" : "");
    const rows = searchLines(data.results, data.projects, now);
    return [
      { kind: "heading", text: heading },
      ...rows,
      ...(rows.length
        ? []
        : [{ kind: "note" as const, text: "一致する issue と会話はありません" }]),
      ...(error
        ? [
            {
              kind: "note" as const,
              text: error instanceof Error ? singleLine(error.message) : "検索できませんでした",
            },
          ]
        : []),
    ];
  }, [data, error, now, query]);
  return (
    <Frame title={searchTitle} side="list" columns={lifecycleColumns}>
      <LifecycleBuffer
        side="list"
        viewName={searchView}
        lines={lines}
        columns={lifecycleColumns}
        temporary={!data}
      />
    </Frame>
  );
}
