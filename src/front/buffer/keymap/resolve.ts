import type { KeymapEntry } from "./registry";
import { normalizeKeys } from "./notation";
function normalized(entry: KeymapEntry): KeymapEntry {
  return {
    ...entry,
    keys: normalizeKeys(entry.keys),
    to: entry.to && "keys" in entry.to ? { keys: normalizeKeys(entry.to.keys) } : entry.to,
  };
}
export function resolveKeymap(defaults: KeymapEntry[], configured: KeymapEntry[]): KeymapEntry[] {
  let result = defaults.map(normalized);
  for (const value of configured) {
    const entry = normalized(value);
    result = result.filter(
      (current) => current.keys !== entry.keys || current.context !== entry.context,
    );
    if (entry.to !== null) result.push(entry);
  }
  return result;
}
