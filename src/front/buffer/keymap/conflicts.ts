import type { ActionRegistry, KeymapEntry } from "./registry";
import { normalizeKeys, parseKeys } from "./notation";
import { vimBuiltins } from "./vim-builtins";
function views(entry: KeymapEntry, registry: ActionRegistry): string[] | undefined {
  return entry.to !== null && "action" in entry.to
    ? registry.get(entry.to.action)?.views
    : undefined;
}
export function findConflicts(
  current: KeymapEntry[],
  next: KeymapEntry,
  registry: ActionRegistry,
): KeymapEntry[] {
  if (next.to === null) return [];
  const keys = parseKeys(normalizeKeys(next.keys));
  if (keys === null) return [];
  const nextViews = views(next, registry);
  const builtin = vimBuiltins.filter(
    (entry) =>
      !current.some(
        (value) =>
          normalizeKeys(value.keys) === normalizeKeys(entry.keys) &&
          value.context === entry.context,
      ),
  );
  return [...current, ...builtin].filter((entry) => {
    if (entry.context !== next.context) return false;
    const existingViews = views(entry, registry);
    if (nextViews && existingViews && !nextViews.some((view) => existingViews.includes(view)))
      return false;
    const tokens = parseKeys(normalizeKeys(entry.keys));
    if (tokens === null) return false;
    return tokens
      .slice(0, Math.min(tokens.length, keys.length))
      .every((key, index) => key === keys[index]);
  });
}
