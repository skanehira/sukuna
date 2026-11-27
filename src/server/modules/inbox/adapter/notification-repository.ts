import type Database from "better-sqlite3";
import type { NotificationRepository, NotificationTarget } from "../domain/notification";

export function createNotificationRepository(sqlite: Database.Database): NotificationRepository {
  const insert = sqlite.prepare(
    "INSERT INTO notifications (id, target_kind, target_id, reason, title, body, created_at, dismissed_at) " +
      "SELECT @id, @targetKind, @targetId, @reason, @title, @body, @createdAt, @dismissedAt " +
      "WHERE @since IS NULL OR NOT EXISTS (" +
      "SELECT 1 FROM notifications WHERE target_kind = @targetKind AND target_id = @targetId AND created_at >= @since)",
  );
  const dismiss = sqlite.prepare(
    "UPDATE notifications SET dismissed_at = ? WHERE dismissed_at IS NULL AND target_kind = ? AND target_id = ?",
  );
  const family = sqlite.prepare(
    "UPDATE notifications SET dismissed_at = @at WHERE dismissed_at IS NULL AND target_kind = 'conversation' AND " +
      "(target_id = @id OR target_id IN (SELECT id FROM conversations WHERE parent_conversation_id = @id AND kind = 'thread'))",
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
  const readMarkers = sqlite.prepare("SELECT value FROM settings WHERE key = ?");
  const writeMarkers = sqlite.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const clearMarkers = sqlite.prepare("DELETE FROM settings WHERE key = ?");
  const key = (projectId: string) => "inbox_notification_markers:" + projectId;
  return {
    transaction: (work) => sqlite.transaction(work).immediate(),
    insertOnce: (record, since) => insert.run({ ...record, since }).changes === 1,
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
  };
}
