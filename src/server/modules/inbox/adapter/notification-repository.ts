import type Database from "better-sqlite3";
import {
  closeWithdrawalKeyPrefix,
  type NotificationRepository,
  type NotificationTarget,
} from "../domain/notification";

const withoutPendingClose = `AND id NOT IN (
  SELECT pending.value FROM settings, json_each(settings.value, '$.notificationIds') AS pending
  WHERE settings.key GLOB '${closeWithdrawalKeyPrefix}*' AND pending.type = 'text'
)`;

export function createNotificationRepository(sqlite: Database.Database): NotificationRepository {
  const insert = sqlite.prepare(
    "INSERT INTO notifications (id, target_kind, target_id, reason, title, body, created_at, dismissed_at) " +
      "SELECT @id, @targetKind, @targetId, @reason, @title, @body, @createdAt, @dismissedAt " +
      "WHERE @since IS NULL OR NOT EXISTS (" +
      "SELECT 1 FROM notifications WHERE target_kind = @targetKind AND target_id = @targetId AND created_at >= @since)",
  );
  const nextSequence = sqlite.prepare(`
    INSERT INTO settings (key, value) VALUES ('inbox_notification_sequence', '1')
    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
    RETURNING CAST(value AS INTEGER) AS sequence
  `);
  const dismiss = sqlite.prepare(
    `UPDATE notifications SET dismissed_at = ? WHERE dismissed_at IS NULL AND target_kind = ? AND target_id = ? ${withoutPendingClose}`,
  );
  const family = sqlite.prepare(
    "UPDATE notifications SET dismissed_at = @at WHERE dismissed_at IS NULL AND target_kind = 'conversation' AND " +
      `(target_id = @id OR target_id IN (SELECT id FROM conversations WHERE parent_conversation_id = @id AND kind = 'thread')) ${withoutPendingClose}`,
  );
  const project = sqlite.prepare(
    "UPDATE notifications SET dismissed_at = @at WHERE dismissed_at IS NULL AND (" +
      "(target_kind = 'conversation' AND target_id IN (SELECT id FROM conversations WHERE project_id = @id)) OR " +
      "(target_kind = 'issue' AND target_id IN (SELECT id FROM issues WHERE project_id = @id)))",
  );
  const undismissed = sqlite.prepare(
    "SELECT target_kind AS kind, target_id AS id FROM notifications WHERE dismissed_at IS NULL AND (" +
      "@projectId IS NULL OR " +
      "(target_kind = 'conversation' AND target_id IN (SELECT id FROM conversations WHERE project_id = @projectId)) OR " +
      "(target_kind = 'issue' AND target_id IN (SELECT id FROM issues WHERE project_id = @projectId)))",
  );
  const withdrawal = sqlite.prepare(`
    SELECT id, target_id AS targetId FROM notifications
    WHERE dismissed_at IS NULL AND target_kind = 'conversation'
      AND CASE @kind
        WHEN 'notifications' THEN id IN (SELECT value FROM json_each(@ids))
        ELSE target_id IN (SELECT value FROM json_each(@ids))
      END
    ORDER BY target_id, id
  `);
  const dismissIds = sqlite.prepare(`
    UPDATE notifications SET dismissed_at = ?
    WHERE dismissed_at IS NULL AND id IN (SELECT value FROM json_each(?))
  `);
  const readMarkers = sqlite.prepare("SELECT value FROM settings WHERE key = ?");
  const writeMarkers = sqlite.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const clearMarkers = sqlite.prepare("DELETE FROM settings WHERE key = ?");
  const key = (projectId: string) => "inbox_notification_markers:" + projectId;
  return {
    transaction: (work) => sqlite.transaction(work).immediate(),
    insertOnce(record, since) {
      if (insert.run({ ...record, since }).changes === 0) return null;
      return (nextSequence.get() as { sequence: number }).sequence;
    },
    undismissed: (projectId) =>
      undismissed.all({ projectId: projectId ?? null }) as NotificationTarget[],
    markers(projectId) {
      const stored = readMarkers.get(key(projectId)) as { value: string } | undefined;
      return stored ? (JSON.parse(stored.value) as Record<string, string>) : {};
    },
    saveMarkers(projectId, markers) {
      if (Object.keys(markers).length === 0) clearMarkers.run(key(projectId));
      else writeMarkers.run(key(projectId), JSON.stringify(markers));
    },
    dismiss: ({ kind, id }, at) => {
      dismiss.run(at, kind, id);
    },
    dismissConversationFamily: (id, at) => {
      family.run({ id, at });
    },
    dismissProject: (id, at) => {
      project.run({ id, at });
    },
    withdrawalGroups({ kind, ids }) {
      const rows = withdrawal.all({ kind, ids: JSON.stringify(ids) }) as {
        id: string;
        targetId: string;
      }[];
      const groups = new Map<string, string[]>();
      for (const { id, targetId } of rows) {
        const group = groups.get(targetId);
        if (group) group.push(id);
        else groups.set(targetId, [id]);
      }
      return groups;
    },
    dismissIds: (ids, at) => {
      dismissIds.run(at, JSON.stringify(ids));
    },
  };
}
