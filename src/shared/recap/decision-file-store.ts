import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, Result } from "neverthrow";
import { parseDecisionFile } from "./decision-file";
import { createDecisionFileLock } from "./decision-file-lock";
import type { DecisionFileLock, DecisionFileStore, DecisionSnapshot, RecapError } from "./ports";

type FileIO = {
  read(path: string): string | null;
  directory(path: string): void;
  write(path: string, content: string): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
  temporary(path: string): string;
};
const nodeIO: FileIO = {
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  },
  directory: (path) => {
    if (!statSync(path).isDirectory())
      throw new Error("プロジェクトのパスがディレクトリではありません");
  },
  write: (path, content) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, { flag: "wx" });
  },
  rename: renameSync,
  remove: (path) => rmSync(path, { force: true }),
  temporary: (path) => `${path}.${randomUUID()}.tmp`,
};
export const decisionFilePath = (id: string) => `docs/decisions/${id}.md`;
export const decisionFileHash = (content: string) =>
  createHash("sha256").update(content).digest("hex");
function snapshot(path: string, content: string | null): DecisionSnapshot {
  return {
    path,
    exists: content !== null,
    hash: content === null ? null : decisionFileHash(content),
    content: content ?? "",
    items: parseDecisionFile(content ?? ""),
  };
}
export function createDecisionFileStore(
  io: FileIO = nodeIO,
  lock: DecisionFileLock = createDecisionFileLock(),
): DecisionFileStore {
  function read(projectPath: string, conversationId: string) {
    return Result.fromThrowable(
      () => {
        io.directory(projectPath);
        if (!/^[^/\\]+$/.test(conversationId) || conversationId === "." || conversationId === "..")
          throw new Error("会話の番号が不正です");
        const path = decisionFilePath(conversationId);
        return snapshot(path, io.read(join(projectPath, path)));
      },
      (): RecapError => ({
        code: "internal",
        message: `決まったことのファイルを読めませんでした (${projectPath})。パスとアクセス権を確認してください。`,
      }),
    )();
  }
  return {
    read,
    update: (projectPath, conversationId, title, transform, baseHash) =>
      lock.run(projectPath, decisionFilePath(conversationId), () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const current = read(projectPath, conversationId);
          if (current.isErr()) return err(current.error);
          if (baseHash !== undefined && current.value.hash !== baseHash)
            return err({
              code: "conflict",
              message:
                "決まったことのファイルが変わりました。読み直して、もう一度保存してください。",
            });
          const original = current.value.content;
          const source = current.value.exists
            ? original
            : `# 決まったこと: ${title.replace(/[\r\n]/g, " ")}\n\n- 種別: 決定台帳\n- 会話: ${conversationId}\n\n`;
          const replacement = transform(source, current.value.hash);
          const content = typeof replacement === "string" ? replacement : replacement.content;
          if (
            content === original ||
            (!current.value.exists && parseDecisionFile(content).length === 0)
          )
            return current;
          const path = join(projectPath, current.value.path);
          const temporary = io.temporary(path);
          const write = Result.fromThrowable(
            () => {
              io.write(temporary, content);
              if (typeof replacement !== "string") replacement.prepare();
              const latest = read(projectPath, conversationId);
              if (latest.isErr() || latest.value.hash !== current.value.hash) {
                if (typeof replacement !== "string") replacement.cancel();
                return latest.isErr() ? err(latest.error) : ok(false);
              }
              io.rename(temporary, path);
              return ok(true);
            },
            (): RecapError => ({
              code: "internal",
              message: `決まったことのファイルを保存できませんでした (${path})。パスとアクセス権を確認してください。`,
            }),
          )().andThen((result) => result);
          const cleanup = Result.fromThrowable(
            () => io.remove(temporary),
            (): RecapError => ({
              code: "internal",
              message: `一時ファイルを削除できませんでした (${temporary})。アクセス権を確認してください。`,
            }),
          )();
          if (write.isErr()) return err(write.error);
          if (cleanup.isErr()) return err(cleanup.error);
          if (write.value) return ok(snapshot(current.value.path, content));
        }
        return err({
          code: "conflict",
          message:
            "決まったことのファイルの変更が続いています。読み直して、もう一度保存してください。",
        });
      }),
  };
}
