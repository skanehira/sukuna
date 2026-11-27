import { useSyncExternalStore } from "react";
import { formatStageElapsed } from "../../shared/activity/stage";
import { formatElapsed } from "../../shared/inbox/elapsed";
import { compareInboxRows } from "../../shared/inbox/order";
import { sectionNames, type InboxResponse, type InboxRow } from "../../shared/inbox/schema";
import type { BufferController } from "../buffer/controller";
import { Frame } from "../buffer/Frame";
import type { ColumnDef, LineInfo } from "../buffer/line";
import { ListingBuffer } from "../components/listing-buffer";
import type { InboxStore } from "../lib/inbox-store";
import { Skeleton } from "../shell/loading";
import { WindowError } from "../shell/ShellBoundary";

const sectionLabels = { decision: "判断待ち", instruction: "指示待ち", working: "作業中" };
const columns: ColumnDef[] = [
  {
    name: "inbox",
    widths: [22, 22, 8, 5],
    heads: ["題名", "状況", "プロジェクト", "経過"],
    classes: ["", "text-muted text-[13px]", "text-muted text-[13px]", "text-muted text-[12px]"],
    align: ["left", "left", "left", "right"],
  },
];
export function activityStatus(row: Pick<InboxRow, "activity" | "status">, now: number) {
  const activity = row.activity;
  return activity
    ? `${activity.stageLabel} ${formatStageElapsed(activity.stageStartedAt, { now: () => now })} · ${activity.lastAction}`
    : row.status;
}
export function listingRow(
  key: string,
  title: string,
  status: string,
  lastActivityAt: number,
  unread: boolean,
  now: number,
  url: string,
  project?: string,
): LineInfo {
  const cols = [
    title,
    status,
    ...(project === undefined ? [] : [project]),
    formatElapsed(lastActivityAt, { now: () => now }),
  ];
  return {
    kind: "row",
    id: key,
    text: cols.join("  "),
    cols,
    colDef: project === undefined ? "project" : "inbox",
    target: { url },
    ...(unread ? { mark: "●", strong: true } : {}),
  };
}
function inboxLines(data: InboxResponse, now: number): LineInfo[] {
  return sectionNames.flatMap((name) => {
    const rows = (data.sections.find((section) => section.name === name)?.rows ?? []).toSorted(
      compareInboxRows,
    );
    return [
      { kind: "section" as const, text: `${sectionLabels[name]}  ${rows.length}` },
      ...(rows.length
        ? rows.map((row) =>
            listingRow(
              row.key,
              row.title,
              activityStatus(row, now),
              row.lastActivityAt,
              row.unread,
              now,
              `/${row.kind === "issue" ? "issues" : "conversations"}/${encodeURIComponent(row.id)}${name === "working" ? "?tail=1" : ""}`,
              row.project.name,
            ),
          )
        : [{ kind: "note" as const, text: `${sectionLabels[name]}はありません` }]),
    ];
  });
}
export function InboxPage({
  store,
  controller,
}: {
  store: InboxStore;
  controller: BufferController;
}) {
  const state = useSyncExternalStore(store.inbox.subscribe, store.inbox.snapshot);
  const projects = useSyncExternalStore(store.projects.subscribe, store.projects.snapshot);
  const noProjects = projects.data?.projects.length === 0;
  const lines: LineInfo[] = noProjects
    ? [{ kind: "note", text: "プロジェクトがありません。:set からプロジェクトを登録します。" }]
    : state.data
      ? inboxLines(state.data, state.now)
      : [];
  const failure = state.error ?? projects.error;
  const status = state.data
    ? sectionNames
        .map(
          (name) =>
            `${sectionLabels[name]} ${state.data!.sections.find((section) => section.name === name)?.rows.length ?? 0}`,
        )
        .join("|")
    : "";
  return (
    <Frame title="一覧" side="list" active columns={columns}>
      {state.loading && !state.data ? (
        <Skeleton side="main" />
      ) : (
        <ListingBuffer
          lines={lines}
          columns={columns}
          side="list"
          viewName="inbox"
          posKey="/:main:inbox"
          controller={controller}
          status={status}
        />
      )}
      {failure ? (
        <WindowError
          message={failure.message}
          onHome={() => {
            void controller.navigate("/");
          }}
          onReload={() => {
            void store.reload();
          }}
        />
      ) : null}
    </Frame>
  );
}
