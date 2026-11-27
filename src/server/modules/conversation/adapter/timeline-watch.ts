import { statSync } from "node:fs";
import type Database from "better-sqlite3";
import { hasTimelineConsultation } from "../usecase/timeline-comments";
import { timelineFilePath } from "./timeline-file";

type Observation = { count: number; sessionId: string | null; seq: number; version: string | null };
type Conversation = { session_id: string | null; last_seq: number };

export function createTimelineWatch(options: {
  database: Database.Database;
  configDir: string;
  changed(id: string, seq: number): void;
}) {
  const conversations = options.database.prepare(
    "SELECT session_id, last_seq FROM conversations WHERE id=?",
  );
  const progressEvents = options.database.prepare<
    [string, number, number],
    { type: string; payload: string }
  >(
    "SELECT type,payload FROM conversation_events WHERE conversation_id=? AND seq>? AND seq<=? AND (type='user_message' OR (type='tool_use' AND json_extract(payload, '$.name') IN ('timeline_tasks', 'mcp__timeline__timeline_tasks')))",
  );
  const active = new Map<string, Observation>();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const read = (id: string) => conversations.get(id) as Conversation | undefined;
  const versionOf = (sessionId: string | null) => {
    const path = sessionId === null ? null : timelineFilePath(options.configDir, sessionId);
    if (path === null) return null;
    try {
      const file = statSync(path, { bigint: true });
      return `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
    } catch (error) {
      return error instanceof Error && "code" in error ? String(error.code) : null;
    }
  };
  const observed = (conversation: Conversation | undefined) => ({
    sessionId: conversation?.session_id ?? null,
    seq: conversation?.last_seq ?? 0,
    version: versionOf(conversation?.session_id ?? null),
  });
  function clear(id: string): void {
    clearTimeout(pending.get(id));
    pending.delete(id);
  }
  function changed(id: string): void {
    if (pending.has(id)) return;
    pending.set(
      id,
      setTimeout(() => {
        pending.delete(id);
        if (!active.has(id)) return;
        const conversation = read(id);
        if (conversation) options.changed(id, conversation.last_seq);
      }, 300).unref(),
    );
  }
  function poll(): void {
    for (const [id, previous] of active) {
      const next = observed(read(id));
      const progressSaved =
        next.seq > previous.seq &&
        progressEvents
          .all(id, previous.seq, next.seq)
          .some(
            ({ type, payload }) =>
              type === "tool_use" || hasTimelineConsultation(JSON.parse(payload)),
          );
      const sessionChanged = next.sessionId !== previous.sessionId;
      if (
        progressSaved ||
        (!sessionChanged && next.version !== previous.version) ||
        (sessionChanged && (readable(previous.version) || readable(next.version)))
      )
        changed(id);
      Object.assign(previous, next);
    }
  }
  return {
    retain(id: string): void {
      const previous = active.get(id);
      if (previous) previous.count++;
      else active.set(id, { count: 1, ...observed(read(id)) });
      timer ??= setInterval(poll, 100).unref();
    },
    release(id: string): void {
      const previous = active.get(id);
      if (!previous || --previous.count > 0) return;
      active.delete(id);
      clear(id);
      if (!active.size) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    close(): void {
      clearInterval(timer);
      timer = undefined;
      for (const id of active.keys()) clear(id);
      active.clear();
    },
  };
}

function readable(version: string | null): boolean {
  return version?.includes(":") ?? false;
}
export type TimelineWatch = Pick<ReturnType<typeof createTimelineWatch>, "retain" | "release">;
