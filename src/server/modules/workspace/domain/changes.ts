import type { ChangesResponse } from "../../../../shared/files";
import type { DiffRecord } from "./ports";

export function aggregateChanges(events: DiffRecord[]): ChangesResponse {
  const files = new Map<string, ChangesResponse["files"][number]>();
  for (const event of events.toSorted((a, b) => a.seq - b.seq)) {
    const { path, change, truncated } = event.payload;
    const contentLines = (event.payload.content ?? "").split("\n");
    if (contentLines.at(-1) === "") contentLines.pop();
    const hunks =
      change === "create"
        ? [
            {
              oldStart: 0,
              oldLines: 0,
              newStart: 1,
              newLines: contentLines.length,
              lines: contentLines.map((line) => `+${line}`),
            },
          ]
        : event.payload.hunks.map((hunk) => ({
            oldStart: hunk.old_start,
            oldLines: hunk.old_lines,
            newStart: hunk.new_start,
            newLines: hunk.new_lines,
            lines: hunk.lines,
          }));
    const file = files.get(path) ?? { path, added: 0, removed: 0, changes: [] };
    for (const line of hunks.flatMap((hunk) => hunk.lines)) {
      if (line.startsWith("+")) file.added += 1;
      if (line.startsWith("-")) file.removed += 1;
    }
    file.changes.push({ seq: event.seq, createdAt: event.createdAt, change, hunks, truncated });
    files.set(path, file);
  }
  return { files: [...files.values()] };
}
