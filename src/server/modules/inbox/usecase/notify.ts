import type { InboxRow } from "../../../../shared/inbox/schema";
import type { InboxDependencies, InboxProject } from "../domain/ports";
import { assignedConversation } from "../domain/conversation";
import { notificationBasis } from "../domain/notification-basis";
import {
  isWaiting,
  startsNotification,
  type NotificationRecord,
  type NotificationRepository,
  type NotificationWithdrawal,
} from "../domain/notification";
import type { NotificationPush, ShowNotification } from "../domain/push-port";
import { refreshRow } from "./refresh-row";

type Section = InboxRow["section"];

export function createNotifications(deps: {
  inbox: InboxDependencies;
  repository: NotificationRepository;
  shown(): ReadonlySet<string>;
  publish(notice: ShowNotification): void;
  notificationPush?: NotificationPush;
  now(): number;
  id(): string;
}) {
  const placements = new Map<string, Map<string, Section>>();

  function* rows(project: InboxProject, flowPaused: boolean) {
    const conversations = new Map(project.conversations.map((c) => [c.id, c]));
    for (const target of [
      ...project.conversations.filter((c) => c.kind === "chat" || c.kind === "thread"),
      ...project.issues,
    ]) {
      const row = refreshRow(project, target, deps.inbox, flowPaused);
      if (!row) continue;
      const issue = "state" in target ? target : undefined;
      const conversation = issue ? undefined : conversations.get(row.id);
      const thread = conversation?.kind === "thread";
      const parentId = thread ? conversation.parentConversationId : null;
      if (thread && (parentId === null || conversations.get(parentId)?.closedAt !== null)) continue;
      yield {
        row,
        conversation,
        thread,
        parentId,
        basis: isWaiting(row.section)
          ? notificationBasis(
              row,
              target,
              issue ? (assignedConversation(issue, project) ?? undefined) : undefined,
            )
          : null,
      };
    }
  }

  function refresh(projectId?: string): void {
    const snapshot = deps.inbox.repository.load(projectId);
    if (snapshot.isErr()) return;
    const { projects, flowPaused } = snapshot.value;
    const seen = deps.shown();
    const now = deps.now();
    const candidates: {
      record: NotificationRecord;
      since: number | null;
      tag: string;
      url: string;
    }[] = [];
    const updated = new Map<string, Map<string, Section>>();
    const waiting = new Set<string>();
    const markers = new Map<string, Record<string, string>>();

    for (const project of projects) {
      const previous = placements.get(project.id);
      const saved = deps.repository.markers(project.id);
      const next = new Map<string, Section>();
      const nextMarkers: Record<string, string> = {};
      updated.set(project.id, next);
      for (const { row, conversation, thread, parentId, basis } of rows(project, flowPaused)) {
        next.set(row.key, row.section);
        if (!isWaiting(row.section)) continue;
        const viewed =
          seen.has(row.key) || (parentId !== null && seen.has("conversation:" + parentId));
        if (!viewed) waiting.add(row.key);
        if (!basis) continue;
        nextMarkers[row.key] = basis.marker;

        const last = previous?.get(row.key);
        const lastMarker = saved[row.key];
        if (!startsNotification(last, row, last === undefined && lastMarker === basis.marker))
          continue;
        const subject = conversation ? conversation.title || "(題名なし)" : row.title;
        const title = (thread ? "スレッド: " : "") + subject + " (" + project.name + ")";
        const encoded = encodeURIComponent(row.id);
        const url =
          parentId === null
            ? (row.kind === "issue" ? "/issues/" : "/conversations/") + encoded
            : "/conversations/" + encodeURIComponent(parentId) + "?thread=" + encoded;
        candidates.push({
          record: {
            id: deps.id(),
            targetKind: row.kind,
            targetId: row.id,
            reason: row.reason,
            title,
            body: row.notice,
            createdAt: now,
            dismissedAt: viewed ? now : null,
          },
          since: last === undefined && lastMarker === undefined ? basis.at : null,
          tag: row.key,
          url,
        });
      }
      if (
        Object.keys(saved).length !== Object.keys(nextMarkers).length ||
        Object.entries(nextMarkers).some(([key, value]) => saved[key] !== value)
      )
        markers.set(project.id, nextMarkers);
    }
    const dismissals = deps.repository
      .undismissed(projectId)
      .filter(({ kind, id }) => !waiting.has(kind + ":" + id));

    const notices: ShowNotification[] = [];
    if (dismissals.length || candidates.length || markers.size)
      deps.repository.transaction(() => {
        for (const target of dismissals) deps.repository.dismiss(target, now);
        for (const { record, since, tag, url } of candidates) {
          const sequence = deps.repository.insertOnce(record, since);
          if (sequence !== null && record.dismissedAt === null)
            notices.push({
              type: "show",
              id: record.id,
              tag,
              sequence,
              title: record.title,
              body: record.body,
              url,
            });
        }
        for (const [id, entries] of markers) deps.repository.saveMarkers(id, entries);
      });

    if (projectId === undefined) placements.clear();
    else placements.delete(projectId);
    updated.forEach((value, id) => placements.set(id, value));
    notices.forEach((notice) => deps.publish(notice));
  }

  const dismissConversationFamily = (id: string, at: number) =>
    deps.repository.dismissConversationFamily(id, at);
  return {
    refresh,
    async withdraw(target: NotificationWithdrawal) {
      for (const [targetId, ids] of deps.repository.withdrawalGroups(target)) {
        await deps.notificationPush?.({ type: "dismiss", tag: "conversation:" + targetId, ids });
        deps.repository.dismissIds(ids, deps.now());
      }
    },
    restoreProject(id: string) {
      const snapshot = deps.inbox.repository.load(id);
      if (snapshot.isErr() || !snapshot.value.projects[0])
        throw new Error("再登録したプロジェクトの通知状態を取得できませんでした。");
      const markers: Record<string, string> = {};
      for (const { row, basis } of rows(snapshot.value.projects[0], snapshot.value.flowPaused))
        if (basis) markers[row.key] = basis.marker;
      deps.repository.saveMarkers(id, markers);
    },
    seen() {
      const topics = deps.shown();
      if (topics.size === 0) return;
      const at = deps.now();
      deps.repository.transaction(() => {
        for (const topic of topics) {
          if (topic.startsWith("conversation:"))
            dismissConversationFamily(topic.slice("conversation:".length), at);
          else if (topic.startsWith("issue:"))
            deps.repository.dismiss({ kind: "issue", id: topic.slice("issue:".length) }, at);
        }
      });
    },
    dismissProject: (id: string, at: number) => deps.repository.dismissProject(id, at),
    dismissConversationFamily,
  };
}
