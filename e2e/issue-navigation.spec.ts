import { expect, test as base, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { capture } from "./evidence";

const title = "予約の監査ログを追加する";
const test = base.extend<{ project: string }>({
  project: async ({ browserName }, use) => {
    const home = process.env.SUKUNA_E2E_HOME;
    if (!home) throw new Error("E2E のデータディレクトリがありません。");
    const cwd = mkdtempSync(join(home, `issue-navigation-${browserName}-`));
    const id = basename(cwd);
    const db = new Database(join(home, "sukuna.db"), { fileMustExist: true });
    db.pragma("foreign_keys = ON");
    try {
      execFileSync("git", ["init", "-q", "-b", "main", cwd]);
      db.prepare(
        "INSERT INTO projects(id,name,path,default_branch,auto_stages) VALUES (?, 'reservation-api', ?, 'main', '[\"triage\"]')",
      ).run(id, cwd);
      await use(id);
    } finally {
      try {
        db.transaction(() => {
          db.prepare("DELETE FROM conversations WHERE project_id = ?").run(id);
          db.prepare("DELETE FROM issues WHERE project_id = ?").run(id);
          db.prepare("DELETE FROM projects WHERE id = ?").run(id);
        })();
      } finally {
        db.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  },
});

async function writeField(page: Page, label: string, text: string) {
  const input = page.getByRole("textbox", { name: label, exact: true });
  await page.keyboard.press("i");
  await expect(input).toBeFocused();
  await page.keyboard.insertText(text);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(input).toHaveCount(0);
}

test.use({ viewport: { width: 1440, height: 900 } });

test("プロジェクトで issue を作り、精査を開いてから優先度を編集する", async ({ page, project }) => {
  await page.goto(`/projects/${project}`);
  const overview = page.getByRole("region", { name: "reservation-api", exact: true });
  await expect(overview.getByRole("textbox", { name: "バッファ" })).toBeFocused();

  await page.keyboard.press("Space");
  await page.keyboard.press("o");
  const form = page.getByRole("region", { name: "issue の作成・編集", exact: true });
  await expect(form.getByRole("textbox", { name: "バッファ" })).toBeFocused();
  await capture(page, "項目を入力する前の issue 作成画面");

  await page.keyboard.press("j");
  await writeField(page, "題名", title);
  await expect(page).toHaveURL(/\/issues\/[^/]+\/edit$/);
  await expect(form.getByText(title, { exact: true })).toBeVisible();
  await expect(form.getByRole("textbox", { name: "バッファ" })).toBeFocused();
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await writeField(page, "本文", "予約が確定した時刻と予約番号を記録する。");
  await expect(form.getByText(/予約が確定した時刻/)).toBeInViewport();
  await capture(page, "題名と本文を保存した下書き");

  await page.keyboard.press("1");
  await page.keyboard.press("Enter");
  await expect(overview.getByRole("textbox", { name: "バッファ" })).toBeFocused();
  await expect(overview.getByText(new RegExp(title))).toBeInViewport();
  await capture(page, "issue を確定したプロジェクトの画面");

  await page.keyboard.press("/");
  await page.keyboard.insertText(title);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  const details = page.getByRole("region", { name: new RegExp(title + " / 会話$") });
  const stage = details.getByText(/精査の会話/);
  await expect(stage).toBeVisible();
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await expect(stage).toBeInViewport();
  await expect(details.getByText("予約の監査ログを精査します。", { exact: true })).toBeVisible();
  await expect(details.getByText(/AI が判断を求めています/)).toBeVisible();
  await capture(page, "自動で始まった精査の会話");

  await page.keyboard.press("-");
  await expect(overview.getByRole("textbox", { name: "バッファ" })).toBeFocused();
  await page.keyboard.press("c");
  await page.keyboard.press("c");
  await expect(form.getByRole("textbox", { name: "バッファ" })).toBeFocused();
  await page.keyboard.press("/");
  await page.keyboard.insertText("優先度");
  await page.keyboard.press("Enter");
  await writeField(page, "優先度", "高");
  await expect(form.getByText("高", { exact: true })).toBeInViewport();
  await capture(page, "編集画面で優先度を変更した issue");
});

test("担当会話を切り替えると同じ issue のタスク詳細が新しい会話に追従する", async ({
  page,
  project,
}) => {
  const home = process.env.SUKUNA_E2E_HOME!;
  const id = `${project}-monitor`;
  const stages = [
    { kind: "impl", title: "実装の作業記録", task: "予約の実装を確かめる" },
    { kind: "triage", title: "精査の作業記録", task: "予約の条件を洗い出す" },
  ];
  const timelineDir = join(home, "claude-config", "timeline", "sessions");
  mkdirSync(timelineDir, { recursive: true });
  const database = new Database(join(home, "sukuna.db"), { fileMustExist: true });
  try {
    const now = Date.now();
    database
      .prepare(
        "INSERT INTO issues (id, project_id, number, title, state, created_at, updated_at) VALUES (?, ?, 1, '監視対象の切り替え', 'implementing', ?, ?)",
      )
      .run(id, project, now, now);
    for (const { kind, title, task } of stages) {
      const conversation = `${id}-${kind}`;
      database
        .prepare(
          "INSERT INTO conversations (id, project_id, issue_id, kind, cwd, title, session_id, last_seq, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
        )
        .run(conversation, project, id, kind, join(home, project), title, conversation, now);
      database
        .prepare(
          "INSERT INTO conversation_events (conversation_id, seq, type, payload, created_at) VALUES (?, 1, 'assistant_text', ?, ?)",
        )
        .run(conversation, JSON.stringify({ text: title, parent_tool_use_id: null }), now);
      writeFileSync(
        join(timelineDir, `${conversation}.json`),
        JSON.stringify({
          version: 1,
          journal: [
            {
              at: now,
              toolUseId: kind,
              ops: [
                { op: "add", id: `root-${kind}`, title: `${title}の計画` },
                { op: "add", id: kind, parent: `root-${kind}`, title: task },
              ],
            },
          ],
          reports: [],
        }),
      );
    }
  } finally {
    database.close();
  }
  await page.goto(`/issues/${id}`);
  const issue = page.getByRole("region", { name: /監視対象の切り替え \/ 会話$/ });
  await expect(issue.getByText(stages[0]!.title, { exact: true })).toBeVisible();
  await expect(issue.getByRole("textbox", { name: "バッファ" })).toBeFocused();
  const progress = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/api/issues/${id}/progress`,
  );
  await page.keyboard.press("Space");
  await page.keyboard.press("t");
  expect((await progress).ok()).toBe(true);
  const timeline = page.getByRole("region", { name: "タイムライン", exact: true });
  await timeline.locator(".cm-kind-row").filter({ hasText: stages[0]!.task }).click();
  await page.keyboard.press("Enter");
  const detail = page.getByRole("region", { name: "タスクの詳細", exact: true });
  await expect(detail.getByText(stages[0]!.task, { exact: true })).toBeVisible();

  await page.keyboard.press("Control+w");
  await page.keyboard.press("h");
  await expect(issue.getByRole("textbox", { name: "バッファ" })).toBeFocused();
  await page.keyboard.press("1");
  await page.keyboard.press("Enter");
  await expect(issue.getByText(stages[1]!.title, { exact: true })).toBeVisible();
  await expect(
    detail.getByText(/タスクが見つかりません。タイムラインから選び直してください/),
  ).toBeVisible();
  await expect(detail.getByText(stages[0]!.task, { exact: true })).toHaveCount(0);
  await page.keyboard.press("Control+w");
  await page.keyboard.press("l");
  await expect(detail.getByRole("textbox", { name: "バッファ" })).toBeFocused();
  await page.keyboard.press("Control+h");
  await expect(timeline.locator(".cm-kind-row").filter({ hasText: stages[1]!.task })).toBeVisible();
  await capture(page, "担当会話を切り替えたあとのタイムライン");
});
