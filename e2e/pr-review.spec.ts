import { expect, test as base } from "@playwright/test";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { capture } from "./evidence";
import {
  physicalDirectory,
  worktreeGitDirectory,
  worktreeRegistration,
} from "../src/shared/workspace/git-registration";

const projectId = "e2e-pr-review";
const issueId = "e2e-pr-review-issue";
const worktreeId = "e2e-pr-review-worktree";
const conversationId = "e2e-pr-review-implementation";
const number = 7001;
const issueTitle = "予約カレンダーに祝日を表示する";
const imageUrl = "https://evidence.example.test/calendar.svg";

type ReviewFixture = {
  cwd: string;
  tree: string;
  branch: string;
  base: string;
  head: string;
  url: string;
};

const test = base.extend<{ reviewIssue: string }>({
  reviewIssue: async ({ browserName, request }, use) => {
    const home = process.env.SUKUNA_E2E_HOME;
    if (!home || browserName !== "chromium")
      throw new Error("PR レビューの前提データがありません。");
    const fixture = JSON.parse(readFileSync(join(home, "pr-review.json"), "utf8")) as ReviewFixture;
    const directory = physicalDirectory(fixture.tree);
    const admin = worktreeGitDirectory(fixture.tree);
    const registration = admin && worktreeRegistration(admin, fixture.tree)?.id;
    if (!directory || !registration) throw new Error("前提の worktree を確認できません。");
    const provenanceKey = `implementation-worktree:${worktreeId}`;
    const db = new Database(join(home, "sukuna.db"), { fileMustExist: true });
    db.pragma("foreign_keys = ON");
    let seeded = false;
    try {
      const at = Date.now();
      db.transaction(() => {
        db.prepare(
          "INSERT INTO projects(id,name,path,default_branch,uses_github) VALUES (?, ?, ?, 'main', 1)",
        ).run(projectId, "予約の管理", fixture.cwd);
        db.prepare(
          "INSERT INTO issues(id,project_id,number,title,state,stop_reason,confirm_before_merge,pr_url,created_at,updated_at) VALUES (?, ?, ?, ?, 'stopped', 'merge_confirm', 1, ?, ?, ?)",
        ).run(issueId, projectId, number, issueTitle, fixture.url, at, at);
        db.prepare(
          "INSERT INTO worktrees(id,project_id,path,branch,branch_created,origin,issue_id) VALUES (?, ?, ?, ?, 1, 'flow', ?)",
        ).run(worktreeId, projectId, fixture.tree, fixture.branch, issueId);
        db.prepare("INSERT INTO settings(key,value) VALUES (?, ?)").run(
          provenanceKey,
          JSON.stringify({ identity: { directory, registration }, cleanupPath: null }),
        );
        db.prepare(
          "INSERT INTO conversations(id,project_id,kind,issue_id,cwd,worktree_id,title) VALUES (?, ?, 'impl', ?, ?, ?, ?)",
        ).run(conversationId, projectId, issueId, fixture.tree, worktreeId, `#${number} の実装`);
        const append = db.prepare(
          "INSERT INTO issue_events(issue_id,seq,type,payload,created_at) VALUES (?, ?, ?, ?, ?)",
        );
        append.run(
          issueId,
          1,
          "state_changed",
          JSON.stringify({
            from: "ready",
            to: "implementing",
            cause: "impl_started",
            stopReason: null,
            detail: null,
          }),
          at,
        );
        append.run(
          issueId,
          2,
          "ready_for_merge",
          JSON.stringify({
            prUrl: fixture.url,
            headSha: fixture.head,
            comparisonBase: fixture.base,
            worktreeId,
            summary: "祝日を表示",
          }),
          at,
        );
        append.run(
          issueId,
          3,
          "state_changed",
          JSON.stringify({
            from: "implementing",
            to: "stopped",
            cause: "ready_for_merge",
            stopReason: "merge_confirm",
            detail: "祝日を表示",
          }),
          at,
        );
      })();
      seeded = true;
      await use(issueId);
    } finally {
      db.close();
      if (seeded) {
        const stopped = await request.delete(`/api/projects/${projectId}`);
        await expect(stopped, await stopped.text()).toBeOK();
      }
    }
  },
});

test.use({ viewport: { width: 1440, height: 900 } });

test("キーボードで PR の差分に指摘を送り、直しを確認して merge を許可する", async ({
  page,
  reviewIssue,
}) => {
  await page.route(imageUrl, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="122" viewBox="0 0 360 122"><rect width="360" height="122" fill="#f7f8fc"/><text x="16" y="25" font-size="14" fill="#18213d">予約カレンダー</text><rect x="16" y="43" width="328" height="31" rx="4" fill="#fff"/><rect x="16" y="81" width="328" height="27" rx="4" fill="#ede8fb"/><text x="26" y="64" font-size="12" fill="#18213d">05 / 04  みどりの日</text><text x="26" y="99" font-size="12" fill="#4e367d">05 / 05  こどもの日</text></svg>',
    }),
  );
  await page.goto(`/issues/${reviewIssue}`);
  const diff = page.getByRole("region", { name: /\/ 差分$/ });
  const buffer = diff.getByRole("textbox", { name: "バッファ" });
  const keys = async (...sequence: string[]) => {
    for (const key of sequence) await page.keyboard.press(key);
  };
  await expect(buffer).toBeFocused();
  const historyLength = await page.evaluate(() => window.history.length);
  await expect(diff.getByRole("img", { name: "祝日を表示したカレンダー" })).toBeVisible();
  await expect(diff.locator(".cm-kind-add").filter({ hasText: "holidayAccent" })).toBeVisible();
  await capture(page, "merge 前に開く差分、CI の状況と動作確認の画像");

  await keys("/", ...Array.from("holidayAccent"), "Enter");
  await expect(diff.locator(".cm-activeLine").filter({ hasText: "holidayAccent" })).toBeVisible();
  await keys("Space", "c");
  const prompt = page.getByRole("textbox", { name: "指示", exact: true });
  await expect(prompt).toBeFocused();
  await page.keyboard.insertText("祝日の色を見直す");
  await keys("Escape", "Enter");
  await expect(diff.locator(".cm-mark-gutter span").filter({ hasText: /^!$/ })).toBeVisible();
  await capture(page, "選んだ差分に指示をストックした状態");
  await keys("Space", "s", "c");

  await expect(diff.locator(".cm-kind-add").filter({ hasText: "holidayHighlight" })).toBeVisible();
  await expect(diff.getByText("merge を許可する", { exact: true })).toBeVisible();
  await keys("1", "Enter");
  const confirm = page.getByLabel("操作の確認");
  await expect(confirm).toBeVisible();
  await capture(page, "直した版の差分と merge 許可の確認");
  await keys("y");

  await expect(diff.getByText("merge 済み", { exact: true })).toBeVisible();
  await keys("Control+l");
  const conversation = page.getByRole("region", { name: /\/ 会話$/ });
  await expect(conversation.getByText("完了", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/issues\/e2e-pr-review-issue\/conversation$/);
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
  await expect(
    conversation.getByText("予約カレンダーの祝日の色を直しました。", { exact: true }),
  ).toBeVisible();
  await capture(page, "merge が終わり完了になった issue");
  await page.reload();
  await expect(conversation.getByText("完了", { exact: true })).toBeVisible();
});
