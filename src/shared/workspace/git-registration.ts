import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function filesystemKey(value: { dev: bigint; ino: bigint; birthtimeNs: bigint }) {
  return [value.dev, value.ino, value.birthtimeNs].join("\0");
}

export function physicalFile(path: string): string | null {
  try {
    const row = lstatSync(path, { bigint: true });
    return row.isFile() ? filesystemKey(row) : null;
  } catch {
    return null;
  }
}

export function physicalDirectory(path: string): string | null {
  try {
    const row = lstatSync(path, { bigint: true });
    return row.isDirectory() ? filesystemKey(row) : null;
  } catch {
    return null;
  }
}

export function worktreeRegistration(gitDir: string, path: string) {
  try {
    const marker = join(gitDir, "gitdir");
    const target = readFileSync(marker, "utf8").trim();
    if (resolve(gitDir, target) !== join(path, ".git")) return null;
    const directory = physicalDirectory(gitDir);
    if (!directory) return null;
    const markerState = lstatSync(marker, { bigint: true });
    if (!markerState.isFile()) return null;
    return {
      id: `${gitDir}${"\0"}${directory}`,
      pointer: `${markerState.ino}${"\0"}${markerState.birthtimeNs}`,
    };
  } catch {
    return null;
  }
}

export function worktreeGitDirectory(path: string): string | null {
  try {
    const marker = join(path, ".git");
    if (!lstatSync(marker).isFile()) return null;
    const value = readFileSync(marker, "utf8").trim();
    return value.startsWith("gitdir: ") ? resolve(dirname(marker), value.slice(8)) : null;
  } catch {
    return null;
  }
}
