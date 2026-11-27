import type { Draft, DraftContent, DraftRequest } from "./types";

export class DraftSync {
  private value: DraftContent;
  private editedAt: number;
  private savedAt: number;
  constructor(private clientId: string, draft: Draft | null) {
    this.value = { text: draft?.text ?? "", images: draft?.images ?? [] };
    this.editedAt = draft?.updatedAt ?? 0;
    this.savedAt = this.editedAt;
  }
  content(): DraftContent { return this.value; }
  dirty(): boolean { return this.editedAt > this.savedAt; }
  edit(content: DraftContent, now: number): void {
    this.value = content;
    this.editedAt = Math.max(now, this.editedAt + 1);
  }
  request(): DraftRequest { return { ...this.value, clientId: this.clientId, editedAt: this.editedAt }; }
  receive(draft: Draft | null): { replaced: boolean; notice: string | null } {
    if (draft?.updatedBy === this.clientId || (draft?.updatedAt ?? 0) === this.savedAt)
      return { replaced: false, notice: null };
    if (this.dirty()) return { replaced: false, notice: "別の端末で書き換えられました" };
    this.adopt(draft);
    return { replaced: true, notice: "別の端末で書いた内容に置き換わりました" };
  }
  saved(request: DraftRequest, draft: Draft | null): boolean {
    this.savedAt = Math.max(this.savedAt, request.editedAt);
    if (this.editedAt !== request.editedAt) return false;
    this.adopt(draft);
    return true;
  }
  private adopt(draft: Draft | null): void {
    this.value = { text: draft?.text ?? "", images: draft?.images ?? [] };
    this.editedAt = draft?.updatedAt ?? 0;
    this.savedAt = this.editedAt;
  }
}
