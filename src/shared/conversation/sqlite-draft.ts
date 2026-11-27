import type Database from "better-sqlite3";
import type { ConversationDraft } from "./api";
import { timelineAnchorSchema } from "../progress/draft";

export function readDraft(sqlite: Database.Database, id: string): ConversationDraft | null {
  const row = sqlite
    .prepare(
      "SELECT text,images,timeline_anchors AS anchors,updated_at AS updatedAt,updated_by AS updatedBy FROM drafts WHERE conversation_id=?",
    )
    .get(id) as
    | (Omit<ConversationDraft, "images"> & { images: string; anchors: string | null })
    | undefined;
  if (!row) return null;
  const { images, anchors, ...draft } = row;
  return {
    ...draft,
    images: JSON.parse(images) as string[],
    ...(anchors === null
      ? {}
      : { timeline_anchors: timelineAnchorSchema.array().parse(JSON.parse(anchors)) }),
  };
}

export function writeDraft(sqlite: Database.Database, id: string, draft: ConversationDraft): void {
  sqlite
    .prepare(
      "INSERT INTO drafts (conversation_id,text,images,updated_at,updated_by,timeline_anchors) VALUES (?,?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET text=excluded.text,images=excluded.images,updated_at=excluded.updated_at,updated_by=excluded.updated_by,timeline_anchors=excluded.timeline_anchors",
    )
    .run(
      id,
      draft.text,
      JSON.stringify(draft.images),
      draft.updatedAt,
      draft.updatedBy,
      draft.timeline_anchors ? JSON.stringify(draft.timeline_anchors) : null,
    );
}
