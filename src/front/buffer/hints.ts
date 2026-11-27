import type { ActionRegistry, KeymapEntry } from "./keymap/registry";
import { displayKeys } from "./keymap/notation";
export type Hint = [string, string];
export function resolveHints(
  hints: Hint[],
  entries: KeymapEntry[],
  registry: ActionRegistry,
  context: KeymapEntry["context"] = "normal",
): Hint[] {
  return hints.flatMap(([name, description]): Hint[] => {
    if (!registry.get(name)) return [[name, description]];
    const entry = entries.find(
      (value) =>
        value.context === context &&
        value.to !== null &&
        "action" in value.to &&
        value.to.action === name,
    );
    return entry ? [[displayKeys(entry.keys), description]] : [];
  });
}
