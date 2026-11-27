import type { ActionRegistry, KeymapEntry } from "./registry";
import { normalizeKeys, parseKeys } from "./notation";
import { vimBuiltins } from "./vim-builtins";
import { keymapViews, keymapViewsOverlap } from "./resolve";
export function findConflicts(
  current: KeymapEntry[],
  next: KeymapEntry,
  registry: ActionRegistry,
): KeymapEntry[] {
  if (next.to === null) return [];
  const keys = parseKeys(normalizeKeys(next.keys));
  if (keys === null) return [];
  const describe = (name: string) => registry.describe(name);
  const targetViews = keymapViews(next, describe);
  const builtin = vimBuiltins.filter((entry) => {
    if (entry.context !== next.context) return false;
    const builtinKeys = normalizeKeys(entry.keys);
    const coveringViews = current
      .filter(
        (value) =>
          value.to !== null &&
          value.context === entry.context &&
          builtinKeys.startsWith(normalizeKeys(value.keys)),
      )
      .flatMap(({ to }) => {
        if (to === null) return [];
        if ("keys" in to) return [undefined];
        const action = describe(to.action);
        return action &&
          (entry.context !== "prompt" || action.fromPrompt || action.name === "cmdline")
          ? [action.views]
          : [];
      });
    if (coveringViews.includes(undefined)) return false;
    return (
      targetViews === undefined ||
      !targetViews.every((view) => coveringViews.some((views) => views?.includes(view)))
    );
  });
  return [...current, ...builtin].filter((entry) => {
    if (entry.context !== next.context) return false;
    if (!keymapViewsOverlap(entry, next, describe)) return false;
    const tokens = parseKeys(normalizeKeys(entry.keys));
    if (tokens === null) return false;
    return tokens
      .slice(0, Math.min(tokens.length, keys.length))
      .every((key, index) => key === keys[index]);
  });
}
