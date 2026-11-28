import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";

type ProjectActivityError = { code: "conflict" | "internal"; message: string };

export function reserveProjectActivity(
  stateDirectory: string,
  projectId: string,
  mode: "run" | "remove",
): Result<{ release(): void }, ProjectActivityError> {
  let guard: Database.Database | undefined;
  try {
    const directory = join(stateDirectory, "project-run-leases");
    mkdirSync(directory, { recursive: true });
    const lease = new Database(join(directory, `${encodeURIComponent(projectId)}.db`), {
      timeout: 0,
    });
    guard = lease;
    if (mode === "run") {
      lease.exec("BEGIN");
      lease.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
    } else lease.exec("BEGIN EXCLUSIVE");
    return ok({ release: () => lease.close() });
  } catch (error) {
    guard?.close();
    if (error instanceof Error && "code" in error && error.code === "SQLITE_BUSY")
      return err({
        code: "conflict",
        message: "プロジェクトの会話が動き始めたか、登録を解除しています。状態を確認してください。",
      });
    return err({ code: "internal", message: "プロジェクトの開始と解除を調整できませんでした。" });
  }
}
