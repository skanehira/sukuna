import { createHash } from "node:crypto";
import type { KeymapConfig } from "../../../../shared/settings/keymap-schema";

export function keymapRevision(keymap: KeymapConfig): string {
  return `"${createHash("sha256")
    .update(JSON.stringify([keymap.version, keymap.entries]))
    .digest("hex")}"`;
}
