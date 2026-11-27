import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { ok } from "neverthrow";
import { guardPath } from "./path-guard";

describe("会話のパスの検査", () => {
  let root: string;
  let cwd: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sukuna-path-"));
    cwd = join(root, "repo");
    mkdirSync(cwd);
    mkdirSync(join(cwd, ".git"));
    writeFileSync(join(cwd, ".git/config"), "secret");
    writeFileSync(join(cwd, "a.txt"), "inside");
    writeFileSync(join(root, "outside"), "outside");
    symlinkSync(join(root, "outside"), join(cwd, "outside-link"));
    symlinkSync(join(cwd, "a.txt"), join(cwd, "inside-link"));
    symlinkSync(join(cwd, ".git"), join(cwd, "git-link"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each([
    "",
    "a\0.txt",
    "../outside",
    "sub/../../outside",
    "/etc/passwd",
    "C:/secret",
    "src\\a.txt",
    ".git",
    ".git/config",
    "sub/../.git/config",
    "outside-link",
    "git-link/config",
  ])("%s は invalid_input になる", async (path) => {
    const result = await guardPath(cwd, path, {
      realpath: async (value) => ok(realpathSync(value)),
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      code: "invalid_input",
      message: "会話のディレクトリの外のファイルは開けません",
    });
  });

  it.each(["a.txt", "inside-link", "sub/../a.txt"])(
    "%s は会話の中の実体のパスを返す",
    async (path) => {
      const result = await guardPath(cwd, path, {
        realpath: async (value) => ok(realpathSync(value)),
      });
      expect(result._unsafeUnwrap()).toEqual({
        path: path === "inside-link" ? path : "a.txt",
        absolutePath: realpathSync(join(cwd, "a.txt")),
      });
    },
  );
});
