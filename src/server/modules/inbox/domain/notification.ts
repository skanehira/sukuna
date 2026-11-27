import type { InboxRow } from "../../../../shared/inbox/schema";

type Section = InboxRow["section"];
export type NotificationTarget = Pick<InboxRow, "kind" | "id">;

export function isWaiting(section: Section | undefined): boolean {
  return section === "decision" || section === "instruction";
}

export function startsNotification(
  previous: Section | undefined,
  row: Pick<InboxRow, "section" | "reason" | "kind" | "unread">,
  alreadyObserved = false,
): boolean {
  return (
    !alreadyObserved &&
    row.reason !== "stopped_by_user" &&
    row.reason !== "thread" &&
    (row.kind !== "conversation" || row.unread) &&
    isWaiting(row.section) &&
    (!isWaiting(previous) || (previous === "instruction" && row.section === "decision"))
  );
}

export type NotificationRecord = {
  id: string;
  targetKind: NotificationTarget["kind"];
  targetId: string;
  reason: InboxRow["reason"];
  title: string;
  body: string;
  createdAt: number;
  dismissedAt: number | null;
};

export interface NotificationRepository {
  transaction<T>(work: () => T): T;
  insertOnce(record: NotificationRecord, since: number | null): boolean;
  undismissed(projectId?: string): NotificationTarget[];
  markers(projectId: string): Record<string, string>;
  saveMarkers(projectId: string, markers: Record<string, string>): void;
  dismiss(target: NotificationTarget, at: number): void;
  dismissConversationFamily(id: string, at: number): void;
  dismissProject(id: string, at: number): void;
}
