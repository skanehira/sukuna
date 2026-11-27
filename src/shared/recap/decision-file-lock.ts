import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, type Result } from "neverthrow";
import type { DecisionFileLock, RecapError } from "./ports";

export function createDecisionFileLock(
  options: { directory?: string; timeoutMs?: number } = {},
): DecisionFileLock {
  return {
    run: <T>(projectPath: string, relativePath: string, operation: () => Result<T, RecapError>) => {
      let database: Database.Database | undefined;
      try {
        const directory =
          options.directory ??
          join(tmpdir(), `sukuna-decision-locks-${process.getuid?.() ?? "user"}`);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const key = createHash("sha256")
          .update(join(realpathSync(projectPath), relativePath))
          .digest("hex");
        database = new Database(join(directory, `${key}.sqlite`), {
          timeout: options.timeoutMs ?? 5000,
        });
        database.exec("BEGIN IMMEDIATE");
        return operation();
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "SQLITE_BUSY") {
          return err({
            code: "conflict",
            message:
              "決まったことのファイルを別のプロセスが保存しています。少し待ってから、もう一度保存してください。",
          });
        }
        return err({
          code: "internal",
          message: `決まったことのファイルを保存できませんでした (${join(projectPath, relativePath)})。パスとアクセス権を確認してください。`,
        });
      } finally {
        database?.close();
      }
    },
  };
}
