import { findConflicts } from "../buffer/keymap/conflicts";
import { displayKeys } from "../buffer/keymap/notation";
import type { ActionRegistry, KeymapEntry } from "../buffer/keymap/registry";

export function proposeKeymapChange(
  current: KeymapEntry[],
  entry: KeymapEntry,
  actions: ActionRegistry,
): { additions: KeymapEntry[]; conflicts: KeymapEntry[]; confirmation: string | undefined } {
  const conflicts = findConflicts(current, entry, actions);
  const remove = new Set(conflicts);
  if (
    entry.context === "terminal" &&
    entry.to &&
    "action" in entry.to &&
    entry.to.action === "terminal.normal"
  ) {
    for (const old of current.filter(
      (old) =>
        old.context === "terminal" &&
        old.keys !== entry.keys &&
        old.to &&
        "action" in old.to &&
        old.to.action === "terminal.normal",
    ))
      remove.add(old);
  }
  const additions: KeymapEntry[] = [];
  for (const keys of new Set([...remove].map((old) => old.keys))) {
    additions.push({ keys, context: entry.context, to: null });
    additions.push(
      ...current.filter(
        (old) => old.context === entry.context && old.keys === keys && !remove.has(old),
      ),
    );
  }
  additions.push(entry);
  return {
    additions,
    conflicts,
    confirmation:
      conflicts.length === 0
        ? undefined
        : `${conflicts
            .map((conflict) => {
              const to = conflict.to;
              const label =
                to && "action" in to
                  ? (actions.describe(to.action)?.label ?? to.action)
                  : to && "keys" in to
                    ? `Vim ${displayKeys(to.keys)}`
                    : "割り当て";
              return `${displayKeys(conflict.keys)} は「${label}」に使われています`;
            })
            .join("、")}。新しい割り当てを使いますか? (y: 新しい割り当て / n: 今のまま)`,
  };
}

export function includesConflict(accepted: KeymapEntry[], conflict: KeymapEntry): boolean {
  return accepted.some(
    (old) =>
      old.keys === conflict.keys &&
      old.context === conflict.context &&
      JSON.stringify(old.to) === JSON.stringify(conflict.to),
  );
}
