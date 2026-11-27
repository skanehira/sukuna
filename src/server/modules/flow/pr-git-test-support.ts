import { mkdtempSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../../shared/command";
export const gitNames = [
  "regular.txt",
  "a\tb.txt",
  "a\nb.txt",
  "a\rb.txt",
  "a\u0007b.txt",
  "a\u0008b.txt",
  "a\u000bb.txt",
  "a\u000cb.txt",
  "引用.txt",
  'a"b.txt',
  "a\\b.txt",
];
export const gitPathCases = (["modified", "added", "renamed", "deleted"] as const).flatMap(
  (operation) => gitNames.map((name, index) => ({ operation, name, index })),
);
export async function createGitPathFixtures() {
  const root = mkdtempSync(join(tmpdir(), "sukuna-pr-paths-"));
  const repos = new Map<
    string,
    { path: string; diff: string; files: { path: string; additions: number; deletions: number }[] }
  >();
  for (const operation of ["modified", "added", "renamed", "deleted"] as const) {
    const path = join(root, operation);
    const git = async (args: string[]) => {
      const r = await runCommand("git", args, { cwd: root });
      if (r.exitCode !== 0) throw new Error(r.stderr);
      return r.stdout;
    };
    await git(["init", "--initial-branch=main", path]);
    const inRepo = async (args: string[]) => {
      const r = await runCommand("git", args, { cwd: path });
      if (r.exitCode !== 0) throw new Error(r.stderr);
      return r.stdout;
    };
    await inRepo(["config", "user.name", "Fixture"]);
    await inRepo(["config", "user.email", "fixture@example.invalid"]);
    if (operation !== "added")
      gitNames.forEach((name, i) =>
        writeFileSync(join(path, name), `first-${i}\nsecond-${i}\nthird-${i}\n`),
      );
    await inRepo(["add", "--all"]);
    await inRepo(["commit", "--allow-empty", "-m", "base"]);
    await inRepo(["checkout", "-b", "impl"]);
    gitNames.forEach((name, i) => {
      const current = join(path, name);
      if (operation === "renamed") {
        const next = join(path, "renamed-" + name);
        renameSync(current, next);
        writeFileSync(next, `first-${i}\nsecond-${i}\nthird-${i}\nadded-${i}\n`);
      } else if (operation === "deleted") rmSync(current);
      else
        writeFileSync(
          current,
          operation === "added" ? `added-${i}\n` : `first-${i}\nchanged-${i}\nthird-${i}\n`,
        );
    });
    await inRepo(["add", "--all"]);
    await inRepo(["commit", "-m", "change"]);
    const diff = await inRepo(["diff", "main...impl"]);
    repos.set(operation, {
      path,
      diff,
      files: gitNames.map((name) => ({
        path: operation === "renamed" ? "renamed-" + name : name,
        additions: operation === "deleted" ? 0 : 1,
        deletions: operation === "deleted" ? 3 : operation === "modified" ? 1 : 0,
      })),
    });
  }
  return { repos, remove: () => rmSync(root, { recursive: true, force: true }) };
}
export function expectedGitFile(operation: string, name: string, i: number) {
  return {
    path: operation === "renamed" ? "renamed-" + name : name,
    status: operation,
    binary: false,
    additions: operation === "deleted" ? 0 : 1,
    deletions: operation === "deleted" ? 3 : operation === "modified" ? 1 : 0,
    hunks: [
      operation === "added"
        ? { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: [`+added-${i}`] }
        : operation === "deleted"
          ? {
              oldStart: 1,
              oldLines: 3,
              newStart: 0,
              newLines: 0,
              lines: [`-first-${i}`, `-second-${i}`, `-third-${i}`],
            }
          : operation === "renamed"
            ? {
                oldStart: 1,
                oldLines: 3,
                newStart: 1,
                newLines: 4,
                lines: [` first-${i}`, ` second-${i}`, ` third-${i}`, `+added-${i}`],
              }
            : {
                oldStart: 1,
                oldLines: 3,
                newStart: 1,
                newLines: 3,
                lines: [` first-${i}`, `-second-${i}`, `+changed-${i}`, ` third-${i}`],
              },
    ],
  };
}
