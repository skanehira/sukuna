import type { ActionInfo, KeymapEntry } from "./registry";
import { normalizeKeys } from "./notation";
function normalized(entry: KeymapEntry): KeymapEntry {
  return {
    ...entry,
    keys: normalizeKeys(entry.keys),
    to: entry.to && "keys" in entry.to ? { keys: normalizeKeys(entry.to.keys) } : entry.to,
  };
}
type DescribeAction = (name: string) => ActionInfo | undefined;
const noActionInfo: DescribeAction = () => undefined;

export function keymapViews(entry: KeymapEntry, describe: DescribeAction): string[] | undefined {
  return entry.to !== null && "action" in entry.to ? describe(entry.to.action)?.views : undefined;
}

export function keymapViewsOverlap(
  previous: KeymapEntry,
  next: KeymapEntry,
  describe: DescribeAction,
): boolean {
  const first = keymapViews(previous, describe);
  const second = keymapViews(next, describe);
  return first === undefined || second === undefined || first.some((view) => second.includes(view));
}

export function resolveKeymap(
  defaults: KeymapEntry[],
  configured: KeymapEntry[],
  describe: DescribeAction = noActionInfo,
): KeymapEntry[] {
  let result = defaults.map(normalized);
  for (const value of configured) {
    const entry = normalized(value);
    result = result.filter(
      (current) =>
        current.keys !== entry.keys ||
        current.context !== entry.context ||
        (entry.to !== null && !keymapViewsOverlap(current, entry, describe)),
    );
    if (entry.to !== null) result.push(entry);
  }
  return result;
}
