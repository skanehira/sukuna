import type { Draft, DraftContent, DraftRequest } from "./types";

export class DraftSync {
  private value: DraftContent;
  private editedAt: number;
  private savedAt: number;
  private settled: Draft | null;
  private clientId: string;
  private revision = 0;
  private localRevision = 0;
  constructor(clientId: string, draft: Draft | null) {
    this.clientId = clientId;
    this.value = fromDraft(draft);
    this.settled = draft;
    this.editedAt = draft?.updatedAt ?? 0;
    this.savedAt = this.editedAt;
  }
  loadInitial(draft: Draft | null): void {
    this.adopt(draft);
  }
  content(): DraftContent {
    return this.value;
  }
  receipt(): Draft | null {
    return this.dirty() ? null : this.settled;
  }
  version(): number {
    return this.revision;
  }
  readVersion(): number {
    return this.localRevision;
  }
  dirty(): boolean {
    return this.editedAt > this.savedAt;
  }
  edit(content: DraftContent, now: number): void {
    this.revision++;
    this.localRevision++;
    this.value = content;
    this.editedAt = Math.max(now, this.editedAt + 1);
  }
  request(): DraftRequest {
    return { ...this.value, clientId: this.clientId, editedAt: this.editedAt };
  }
  receive(
    draft: Draft | null,
    readVersion = this.localRevision,
  ): { replaced: boolean; notice: string | null } {
    if (
      readVersion !== this.localRevision ||
      draft?.updatedBy === this.clientId ||
      (draft ? draft.updatedAt <= this.savedAt : this.savedAt === 0)
    )
      return { replaced: false, notice: null };
    if (this.dirty()) return { replaced: false, notice: "別の端末で書き換えられました" };
    this.adopt(draft);
    return { replaced: true, notice: "別の端末で書いた内容に置き換わりました" };
  }
  saved(request: DraftRequest, draft: Draft | null): boolean {
    this.localRevision++;
    this.savedAt = Math.max(this.savedAt, request.editedAt);
    if (this.editedAt !== request.editedAt) return false;
    this.adopt(draft);
    return true;
  }
  private adopt(draft: Draft | null): void {
    const next = fromDraft(draft);
    if (!sameDraftContent(this.value, next)) this.revision++;
    this.value = next;
    this.settled = draft;
    this.editedAt = draft?.updatedAt ?? 0;
    this.savedAt = this.editedAt;
  }
}

function fromDraft(draft: DraftContent | null): DraftContent {
  const anchors = draft?.timeline_anchors;
  return {
    text: draft?.text ?? "",
    images: draft?.images ?? [],
    ...(anchors === undefined ? {} : { timeline_anchors: anchors }),
  };
}

export function sameDraftContent(left: DraftContent, right: DraftContent | null): boolean {
  const next = fromDraft(right);
  return (
    left.text === next.text &&
    JSON.stringify(left.timeline_anchors) === JSON.stringify(next.timeline_anchors) &&
    left.images.length === next.images.length &&
    left.images.every((id, index) => id === next.images[index])
  );
}
