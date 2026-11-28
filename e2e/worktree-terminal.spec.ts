import { expect, test as base } from "@playwright/test";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { capture } from "./evidence";

const test = base.extend<{ worktreeProject: string }>({
  worktreeProject: async ({ browserName }, use) => {
    const home = process.env.SUKUNA_E2E_HOME;
    if (!home) throw new Error("E2E のデータディレクトリがありません。");
    const cwd = realpathSync(mkdtempSync(join(home, `terminal-project-${browserName}-`)));
    const id = basename(cwd);
    const db = new Database(join(home, "sukuna.db"), { fileMustExist: true });
    db.pragma("foreign_keys = ON");
    try {
      execFileSync("git", ["init", "-q", "-b", "main", cwd]);
      execFileSync("git", [
        "-C",
        cwd,
        "-c",
        "user.name=E2E",
        "-c",
        "user.email=e2e@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-qm",
        "initial",
        "--allow-empty",
      ]);
      db.prepare("INSERT INTO projects(id,name,path,default_branch) VALUES (?, ?, ?, 'main')").run(
        id,
        "inventory-terminal",
        cwd,
      );
      await use(id);
    } finally {
      try {
        db.prepare("DELETE FROM worktrees WHERE project_id = ?").run(id);
        db.prepare("DELETE FROM projects WHERE id = ?").run(id);
      } finally {
        db.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  },
});

test("worktree をキーで作って選び、そのターミナルから出力を読む", async ({
  page,
  worktreeProject,
}) => {
  await page.goto(`/projects/${worktreeProject}`);
  const project = page.getByRole("region", { name: "inventory-terminal", exact: true });
  await expect(project.getByRole("textbox", { name: "バッファ" })).toBeFocused();
  await page.keyboard.press("Space");
  await page.keyboard.press("k");
  const worktrees = page.getByRole("region", { name: "worktree", exact: true });
  const list = worktrees.getByRole("textbox", { name: "バッファ" });
  await expect(list).toBeFocused();
  await expect(worktrees.getByText("worktree を作る", { exact: false })).toBeVisible();
  await capture(page, "プロジェクトの worktree の一覧");

  await page.keyboard.press("1");
  await page.keyboard.press("Enter");
  const name = page.getByRole("textbox", { name: "worktree の名前", exact: true });
  await expect(name).toBeFocused();
  await page.keyboard.type("try-2");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");

  await expect(worktrees.locator(".cm-activeLine").filter({ hasText: "try-2" })).toBeVisible();
  await expect(list).toBeFocused();
  await page.keyboard.press("Enter");
  await capture(page, "作成した worktree を選んだ一覧");
  await page.keyboard.press("Space");
  await page.keyboard.press("g");

  const terminal = page.getByRole("region", { name: /^ターミナル/ });
  await expect(terminal.locator(".xterm-helper-textarea")).toBeFocused();
  await expect(terminal.locator(".xterm-rows > div").first()).not.toHaveText("");
  await page.keyboard.type("pwd");
  await page.keyboard.press("Enter");
  await expect(
    terminal.locator(".xterm-rows").getByText(/\.claude\/worktrees\/try-2/),
  ).toBeVisible();
  await capture(page, "worktree のターミナルの出力");
});
