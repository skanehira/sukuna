import { lstat, readFile, readlink, realpath, stat } from "node:fs/promises";
import { ResultAsync } from "neverthrow";
import type { FileSystemPort, WorkspaceError } from "../domain/ports";

function fileError(error: unknown): WorkspaceError {
  if (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  )
    return { code: "not_found", message: "ファイルがありません" };
  return { code: "internal", message: "ファイルを読み取れませんでした" };
}

export function createFileSystem(): FileSystemPort {
  return {
    realpath: async (path) => ResultAsync.fromPromise(realpath(path), fileError),
    lstat: async (path) =>
      ResultAsync.fromPromise(lstat(path), fileError).map((info) => ({
        symbolicLink: info.isSymbolicLink(),
      })),
    readlink: async (path) => ResultAsync.fromPromise(readlink(path), fileError),
    stat: async (path) =>
      ResultAsync.fromPromise(stat(path), fileError).map((info) => ({
        size: info.size,
        directory: info.isDirectory(),
      })),
    read: async (path) => ResultAsync.fromPromise(readFile(path), fileError),
  };
}
