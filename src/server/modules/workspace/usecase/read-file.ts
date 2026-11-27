import { err, ok, type Result } from "neverthrow";
import type { FileContentResponse } from "../../../../shared/files";
import { decodeFile, MAX_FILE_BYTES } from "../domain/file-kind";
import { guardPath } from "../domain/path-guard";
import type { WorkspaceDependencies, WorkspaceError } from "../domain/ports";
import { workspaceContext } from "./workspace-context";

export async function readFile(
  id: string,
  path: string,
  deps: WorkspaceDependencies,
): Promise<Result<FileContentResponse, WorkspaceError>> {
  const context = await workspaceContext(id, deps);
  if (context.isErr()) return err(context.error);
  const guarded = await guardPath(context.value.cwd, path, deps.fs);
  if (guarded.isErr()) return err(guarded.error);
  const info = await deps.fs.stat(guarded.value.absolutePath);
  if (info.isErr()) return err(info.error);
  if (info.value.directory)
    return err({
      code: "invalid_input",
      message: "ディレクトリは開けません。ファイルツリーで開いてください",
    });
  const base = { path: guarded.value.path, size: info.value.size };
  if (base.size > MAX_FILE_BYTES) return ok({ ...base, kind: "too_large" });
  const bytes = await deps.fs.read(guarded.value.absolutePath);
  if (bytes.isErr()) return err(bytes.error);
  return ok({ ...base, ...decodeFile(bytes.value) });
}
