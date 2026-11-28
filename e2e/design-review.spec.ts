import { expect, test as base } from "@playwright/test";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { capture } from "./evidence";
import { databasePath } from "./database-path";

const number = 6701;
const title = "設計レビューの操作";
const spec = "設計.md";
const original = "最初の修正方針";
const revised = "指摘を反映した新しい修正方針";

const git = (path: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-C",
      path,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();

const test = base.extend<{ issue: string }>({
  issue: async ({ browserName }, use) => {
    const home = process.env.SUKUNA_E2E_HOME;
    if (!home) throw new Error("E2E のデータディレクトリがありません。");
    const repository = realpathSync(mkdtempSync(join(home, `design-review-${browserName}-`)));
    const project = basename(repository);
    const issue = `${project}-issue`;
    const conversation = `${project}-conversation`;
    const worktree = `${project}-worktree`;
    const path = join(repository, ".claude/worktrees", `design-${number}`);
    const branch = `sukuna/design-${number}`;
    const db = new Database(databasePath(home), { fileMustExist: true });
    db.pragma("foreign_keys = ON");
    try {
      git(repository, "init", "-q", "-b", "main");
      writeFileSync(join(repository, spec), "以前の予約\n");
      git(repository, "add", ".");
      git(repository, "commit", "-qm", "base");
      const baseCommit = git(repository, "rev-parse", "HEAD");
      mkdirSync(join(repository, ".claude/worktrees"), { recursive: true });
      git(repository, "worktree", "add", "-qb", branch, path);
      writeFileSync(join(path, spec), "同時に在庫を確保する\n");
      git(path, "add", ".");
      git(path, "commit", "-qm", "design");
      const headCommit = git(path, "rev-parse", "HEAD");
      const now = Date.now();
      db.transaction(() => {
        db.prepare(
          "INSERT INTO projects (id,name,path,default_branch,auto_stages) VALUES (?, '在庫', ?, 'main', '[]')",
        ).run(project, repository);
        db.prepare(
          "INSERT INTO issues (id,project_id,number,title,state,created_at,updated_at) VALUES (?, ?, ?, ?, 'design_review', ?, ?)",
        ).run(issue, project, number, title, now, now);
        db.prepare(
          "INSERT INTO worktrees (id,project_id,issue_id,path,branch,origin,branch_created) VALUES (?, ?, ?, ?, ?, 'flow', 1)",
        ).run(worktree, project, issue, path, branch);
        db.prepare(
          "INSERT INTO conversations (id,project_id,issue_id,kind,cwd,worktree_id,session_id,title) VALUES (?, ?, ?, 'design', ?, ?, ?, '在庫の設計')",
        ).run(conversation, project, issue, path, worktree, conversation);
        db.prepare(
          "INSERT INTO issue_events (issue_id,seq,type,payload,created_at) VALUES (?, 1, 'design_submitted', ?, ?)",
        ).run(
          issue,
          JSON.stringify({
            policy: original,
            checks: ["期限は 30 分?"],
            branch,
            baseCommit,
            headCommit,
          }),
          now,
        );
      })();
      await use(issue);
    } finally {
      try {
        const approval = db.prepare(
          "SELECT 1 FROM issue_events WHERE issue_id=? AND type='design_approved'",
        );
        if (approval.get(issue)) {
          const settled = db.prepare(
            "SELECT 1 FROM issue_events WHERE issue_id=? AND type IN ('worktree_removed','worktree_kept','design_reflect_failed')",
          );
          await expect
            .poll(() => Boolean(settled.get(issue)), {
              message: "設計の反映と一時作業場所の片付けを待つ",
              timeout: 10_000,
            })
            .toBe(true);
        }
        db.transaction(() => {
          db.prepare("DELETE FROM conversations WHERE project_id=?").run(project);
          db.prepare("DELETE FROM worktrees WHERE project_id=?").run(project);
          db.prepare("DELETE FROM issues WHERE project_id=?").run(project);
          db.prepare("DELETE FROM projects WHERE id=?").run(project);
        })();
      } finally {
        db.close();
        rmSync(repository, { recursive: true, force: true });
      }
    }
  },
});

test.use({ viewport: { width: 1440, height: 900 } });

test("設計を差し戻し、設計の会話の続きで直った設計を読む", async ({ page, issue }) => {
  await page.goto(`/issues/${issue}`);
  const design = page.getByRole("region", { name: /\/ 設計$/ });
  await expect(design.getByText(original, { exact: true })).toBeVisible();
  await expect(design.getByRole("textbox", { name: "バッファ" })).toBeFocused();
  await capture(page, "差し戻す前の設計レビュー");
  await page.keyboard.press("2");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "差し戻し", exact: true })).toBeFocused();
  await page.keyboard.insertText("E2E-6701 の指摘。期限を変更してください");
  await capture(page, "差し戻しの指摘を書いた入力欄");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  const conversation = page.getByRole("region", { name: /\/ 会話$/ });
  await expect(conversation.getByText(/E2E-6701 の指摘/)).toBeVisible();
  await capture(page, "設計した会話に届いた差し戻し");
  await page.keyboard.press("Control+l");
  await expect(design.getByText(revised, { exact: true })).toBeVisible();
  await expect(design.getByText(/承認して実装へ進める/)).toBeVisible();
  await capture(page, "直し終えた設計レビュー");
});

test("設計書の差分から指示をストックし、確認して設計を承認する", async ({ page, issue }) => {
  await page.goto(`/issues/${issue}`);
  const design = page.getByRole("region", { name: /\/ 設計$/ });
  await expect(design.getByText(original, { exact: true })).toBeVisible();
  await expect(design.getByText("同時に在庫を確保する", { exact: true })).toBeVisible();
  await expect(design.getByRole("textbox", { name: "バッファ" })).toBeFocused();
  await capture(page, "方針と設計書の差分");
  await page.keyboard.press("/");
  await page.keyboard.insertText("同時に在庫を確保する");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await page.keyboard.press("c");
  await expect(page.getByRole("textbox", { name: "指示", exact: true })).toBeFocused();
  await page.keyboard.insertText("期限は設定から読んでください");
  await capture(page, "差分の追加行に指示を書く");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status", { name: "お知らせ" })).toContainText(
    "指示をストックしました",
  );
  await page.keyboard.press("1");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/送っていない指示が 1 件あります/)).toBeVisible();
  await capture(page, "未送信の指示を添えた承認確認");
  await page.keyboard.press("y");
  await expect(
    page.getByRole("region", { name: /\/ 会話$/ }).getByText("実装待ち", { exact: true }),
  ).toBeVisible();
  await capture(page, "承認して実装待ちになった issue");
});
