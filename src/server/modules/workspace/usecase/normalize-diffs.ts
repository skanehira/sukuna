import { err, ok, type Result } from "neverthrow";
import { normalizeRecordedPath } from "../domain/path-guard";
import type { DiffRecord, FileSystemPort, WorkspaceError } from "../domain/ports";

export async function normalizeDiffs(
  cwd: string,
  events: DiffRecord[],
  fs: FileSystemPort,
): Promise<Result<DiffRecord[], WorkspaceError>> {
  const normalized: DiffRecord[] = [];
  for (const event of events) {
    const path = await normalizeRecordedPath(cwd, event.payload.path, fs);
    if (path.isErr()) {
      if (path.error.code === "internal") return err(path.error);
      continue;
    }
    normalized.push({ ...event, payload: { ...event.payload, path: path.value } });
  }
  return ok(normalized);
}
