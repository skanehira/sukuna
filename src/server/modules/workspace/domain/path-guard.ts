import { isAbsolute, posix } from "node:path";
import { err, ok, type Result } from "neverthrow";
import type { FileSystemPort, WorkspaceError } from "./ports";

const outside: WorkspaceError = {
  code: "invalid_input",
  message: "会話のディレクトリの外のファイルは開けません",
};

export async function guardPath(
  cwd: string,
  input: string,
  fs: Pick<FileSystemPort, "realpath">,
): Promise<Result<{ path: string; absolutePath: string }, WorkspaceError>> {
  if (
    !input ||
    input.includes("\0") ||
    input.includes("\\") ||
    isAbsolute(input) ||
    /^[a-z]:\//i.test(input)
  )
    return err(outside);
  const path = posix.normalize(input);
  if (
    path === ".." ||
    path.startsWith("../") ||
    input.split("/")[0] === ".git" ||
    path.split("/")[0] === ".git"
  )
    return err(outside);
  const root = await fs.realpath(cwd);
  if (root.isErr()) return err(root.error);
  const target = await fs.realpath(posix.join(root.value, path));
  if (target.isErr())
    return err(
      target.error.code === "not_found"
        ? { code: "not_found", message: `ファイルがありません: ${input}` }
        : target.error,
    );
  const relative = posix.relative(root.value, target.value);
  if (
    relative === ".." ||
    relative.startsWith("../") ||
    isAbsolute(relative) ||
    relative.split("/")[0] === ".git"
  )
    return err(outside);
  return ok({ path, absolutePath: target.value });
}

export async function normalizeRecordedPath(
  cwd: string,
  input: string,
  fs: Pick<FileSystemPort, "realpath" | "lstat" | "readlink">,
): Promise<Result<string, WorkspaceError>> {
  if (!input || input.includes("\0") || input.includes("\\") || /^[a-z]:\//i.test(input))
    return err(outside);
  const root = await fs.realpath(cwd);
  if (root.isErr()) return err(root.error);
  const target = await resolveRecordedTarget(
    isAbsolute(input) ? posix.normalize(input) : posix.join(root.value, input),
    fs,
    new Set(),
  );
  if (target.isErr()) return err(target.error);
  const relative = posix.relative(root.value, target.value);
  if (
    relative === ".." ||
    relative.startsWith("../") ||
    isAbsolute(relative) ||
    relative.split("/")[0] === ".git"
  )
    return err(outside);
  let path = input;
  if (isAbsolute(input)) {
    const candidates = [posix.relative(cwd, input), posix.relative(root.value, input)];
    const contained = candidates.find(
      (candidate) => candidate !== ".." && !candidate.startsWith("../") && !isAbsolute(candidate),
    );
    if (contained !== undefined) path = contained;
    else {
      let ancestor = input;
      let suffix = "";
      while (true) {
        const resolved = await fs.realpath(ancestor);
        if (resolved.isOk()) {
          path = posix.relative(root.value, posix.join(resolved.value, suffix));
          break;
        }
        if (resolved.error.code !== "not_found") return err(resolved.error);
        const parent = posix.dirname(ancestor);
        if (parent === ancestor) return err(resolved.error);
        suffix = posix.join(posix.basename(ancestor), suffix);
        ancestor = parent;
      }
    }
  }
  const normalized = posix.normalize(path);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    isAbsolute(normalized) ||
    path.split("/")[0] === ".git" ||
    normalized.split("/")[0] === ".git"
  )
    return err(outside);
  return ok(normalized);
}

async function resolveRecordedTarget(
  input: string,
  fs: Pick<FileSystemPort, "lstat" | "readlink">,
  resolving: Set<string>,
): Promise<Result<string, WorkspaceError>> {
  const parts = input.split("/");
  let resolved = "/";
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part || part === ".") continue;
    if (part === "..") {
      resolved = posix.dirname(resolved);
      continue;
    }
    const candidate = posix.join(resolved, part);
    const info = await fs.lstat(candidate);
    if (info.isErr()) {
      if (info.error.code !== "not_found") return err(info.error);
      const missing = posix.join(candidate, ...parts.slice(index + 1));
      return missing === candidate || missing.startsWith(`${candidate}/`)
        ? ok(missing)
        : resolveRecordedTarget(missing, fs, resolving);
    }
    if (!info.value.symbolicLink) {
      resolved = candidate;
      continue;
    }
    if (resolving.has(candidate)) return err(outside);
    const link = await fs.readlink(candidate);
    if (link.isErr()) return err(link.error);
    resolving.add(candidate);
    const target = await resolveRecordedTarget(
      isAbsolute(link.value) ? link.value : `${resolved}/${link.value}`,
      fs,
      resolving,
    );
    resolving.delete(candidate);
    if (target.isErr()) return err(target.error);
    resolved = target.value;
  }
  return ok(resolved);
}
