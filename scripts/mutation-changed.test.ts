import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

const script = fileURLToPath(new URL("./mutation-changed.sh", import.meta.url));

describe("変えた行だけに変異テストを流すスクリプト", () => {
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;

  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, env }).toString();
  const write = (path: string, lines: string[]) =>
    writeFileSync(join(repo, path), `${lines.join("\n")}\n`);
  const commit = (message: string) => {
    git("add", "-A");
    git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD").trim();
  };
  const run = (base: string) =>
    spawnSync("sh", [script, base], { cwd: repo, env, encoding: "utf8" });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sukuna-mutation-changed-"));
    repo = join(root, "repo");
    const bin = join(root, "bin");
    execFileSync("mkdir", ["-p", repo, bin, join(repo, "src")]);
    writeFileSync(join(bin, "vp"), '#!/bin/sh\necho "vp $*"\n');
    chmodSync(join(bin, "vp"), 0o755);
    env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    git("init", "--quiet");
    write("src/a.ts", ["l1", "l2", "l3", "l4", "l5"]);
    write("src/a.test.ts", ["t1"]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("変えた行と足したファイルの行の範囲を渡し、テストのファイルは渡さない", () => {
    const base = commit("base");
    write("src/a.ts", ["l1", "x2", "x3", "l4", "l5"]);
    write("src/b.ts", ["b1", "b2"]);
    write("src/a.test.ts", ["t2"]);
    commit("change");

    const result = run(base);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "変異テストの対象: src/a.ts:2-3,src/b.ts:1-2\nvp run mutation --mutate src/a.ts:2-3,src/b.ts:1-2\n",
    );
  });

  it.each([
    ["git の設定なし", []],
    ["diff.noprefix", [["diff.noprefix", "true"]]],
    ["color.diff=always", [["color.diff", "always"]]],
    ["diff.external", [["diff.external", "true"]]],
  ])("1 行だけ変えたときもその行を渡す (%s)", (_name, settings: string[][]) => {
    const base = commit("base");
    write("src/a.ts", ["l1", "l2", "l3", "x4", "l5"]);
    commit("change");
    for (const [key, value] of settings) git("config", key, value);

    const result = run(base);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "変異テストの対象: src/a.ts:4-4\nvp run mutation --mutate src/a.ts:4-4\n",
    );
  });

  it("行を消しただけでテストしか足していなければ、変異テストを流さずに終わる", () => {
    const base = commit("base");
    write("src/a.ts", ["l1", "l2", "l3", "l5"]);
    write("src/a.test.ts", ["t2"]);
    commit("change");

    const result = run(base);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`変異テストの対象になる行は変わっていない (${base}...HEAD)\n`);
  });

  it("基準の ref を解決できなければ、変異テストを流さずに失敗する", () => {
    commit("base");

    const result = run("origin/nonexistent");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});
