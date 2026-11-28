import { linkSync, mkdtempSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { physicalFile } from "./git-registration";

export type RecordedGitLock = { path: string; key: string; stagedPath?: string };
export type LockObserver = {
  planned(file: RecordedGitLock): void;
  released(file: RecordedGitLock): void;
};

export function isStagedGitLock(file: RecordedGitLock): boolean {
  const staged = file.stagedPath;
  if (!staged) return false;
  const site = dirname(staged);
  return (
    basename(staged) === "lock" &&
    basename(site).startsWith(".sukuna-lock-") &&
    dirname(site) === dirname(file.path) &&
    physicalFile(staged) === file.key
  );
}

export function releaseRecordedGitLock(file: RecordedGitLock) {
  if (file.stagedPath && !isStagedGitLock(file)) return;
  if (physicalFile(file.path) === file.key) unlinkSync(file.path);
  if (file.stagedPath && physicalFile(file.stagedPath) === file.key) {
    unlinkSync(file.stagedPath);
    rmdirSync(dirname(file.stagedPath));
  }
}

export function acquireRecordedGitLock(path: string, observer: LockObserver, text = "") {
  mkdirSync(dirname(path), { recursive: true });
  const staging = mkdtempSync(join(dirname(path), ".sukuna-lock-"));
  const stagedPath = join(staging, "lock");
  writeFileSync(stagedPath, text, { flag: "wx", mode: 0o600 });
  const key = physicalFile(stagedPath);
  if (!key) throw new Error("Git のロックを確認できませんでした");
  const file = { path, key, stagedPath };
  const release = () => {
    releaseRecordedGitLock(file);
    observer.released(file);
  };
  try {
    observer.planned(file);
    linkSync(stagedPath, path);
    return { file, release };
  } catch (error) {
    release();
    throw error;
  }
}
