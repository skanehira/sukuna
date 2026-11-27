import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitCli as serverGit } from "./git-cli";
import { createGitCli as runnerGit } from "../../../../runner/modules/workspace/adapter/git-cli";
describe.each([
  ["server", serverGit],
  ["runner", runnerGit],
] as const)("%s の git の土台", (_, createGit) => {
  it("実行の口を差し替えると引数と作業場所を渡す", async () => {
    const calls: unknown[] = [];
    const git = createGit({
      run: (args, opts) => {
        calls.push({ args, opts });
        return Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 });
      },
    });
    expect(await git.run(["status", "--short"], { cwd: "/repo" })).toEqual({
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    });
    expect(calls).toEqual([{ args: ["status", "--short"], opts: { cwd: "/repo" } }]);
  });
  it("実物で一時リポジトリのルートを返す", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sukuna-git-")));
    const git = createGit();
    try {
      expect((await git.run(["init", "--quiet"], { cwd: dir })).exitCode).toBe(0);
      expect(await git.run(["rev-parse", "--show-toplevel"], { cwd: dir })).toEqual({
        stdout: `${dir}\n`,
        stderr: "",
        exitCode: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
