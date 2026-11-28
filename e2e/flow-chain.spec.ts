import { expect, test as base } from "@playwright/test";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { basename, join } from "node:path";
import { capture } from "./evidence";

const title = "設計レビューの一覧確認";
const number = 6601;
const test = base.extend<{ confirmedIssue: { id: string; socketPath: string } }>({
  confirmedIssue: async ({ browserName }, use) => {
    const home = process.env.SUKUNA_E2E_HOME;
    if (!home) throw new Error("E2E のデータディレクトリがありません。");
    const cwd = mkdtempSync(join(home, `flow-chain-${browserName}-`));
    const projectId = basename(cwd);
    const issueId = `${projectId}-issue`;
    const db = new Database(join(home, "sukuna.db"), { fileMustExist: true });
    db.pragma("foreign_keys = ON");
    try {
      const git = (...args: string[]) =>
        execFileSync(
          "git",
          [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.test",
            "-c",
            "commit.gpgsign=false",
            ...args,
          ],
          { cwd },
        );
      git("init", "-q", "-b", "main");
      git("commit", "--allow-empty", "-qm", "base");
      const now = Date.now();
      db.transaction(() => {
        db.prepare(
          "INSERT INTO projects(id,name,path,default_branch,auto_stages) VALUES (?, ?, ?, 'main', '[\"triage\",\"design\"]')",
        ).run(projectId, "設計レビューのテストプロジェクト", cwd);
        db.prepare(
          "INSERT INTO issues(id,project_id,number,title,state,created_at,updated_at) VALUES (?, ?, ?, ?, 'triage', ?, ?)",
        ).run(issueId, projectId, number, title, now, now);
        db.prepare(
          "INSERT INTO issue_events(issue_id,seq,type,payload,created_at) VALUES (?, 1, 'state_changed', ?, ?)",
        ).run(
          issueId,
          JSON.stringify({
            from: "draft",
            to: "triage",
            stopReason: null,
            detail: null,
            cause: "confirm",
          }),
          now,
        );
      })();
      await use({ id: issueId, socketPath: join(home, "runner.sock") });
    } finally {
      try {
        db.transaction(() => {
          db.prepare("DELETE FROM worktrees WHERE project_id = ?").run(projectId);
          db.prepare("DELETE FROM notifications WHERE target_kind = 'issue' AND target_id = ?").run(
            issueId,
          );
          db.prepare("DELETE FROM conversations WHERE project_id = ?").run(projectId);
          db.prepare("DELETE FROM issues WHERE project_id = ?").run(projectId);
          db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
        })();
      } finally {
        db.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  },
});

async function notifyRunner({ id, socketPath }: { id: string; socketPath: string }) {
  await new Promise<void>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: "/flow/notify",
        method: "POST",
        headers: { "content-type": "application/json" },
        timeout: 10_000,
      },
      (response) => {
        response.resume();
        response.once("end", () =>
          response.statusCode === 200
            ? resolve()
            : reject(new Error(`ランナーへの通知が失敗しました (${response.statusCode})`)),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("ランナーへの通知がタイムアウトしました。")));
    req.on("error", reject);
    req.end(JSON.stringify({ issue_id: id }));
  });
}

test.use({ viewport: { width: 1440, height: 900 } });

test("一覧を開いたまま精査と設計が終わると設計の承認が判断待ちに出る", async ({
  page,
  confirmedIssue,
}) => {
  await page.goto("/");
  const inbox = page.getByRole("region", { name: "一覧", exact: true });
  const row = inbox.locator(".cm-kind-row").filter({ hasText: title });
  const section = row.locator(
    "xpath=preceding-sibling::*[contains(concat(' ',normalize-space(@class),' '),' cm-kind-section ')][1]",
  );

  await expect(row).toBeVisible();
  await expect(section).toHaveText(/^作業中/);
  await capture(page, "一覧の作業中にある精査待ちの issue");

  await notifyRunner(confirmedIssue);
  await expect(row.getByText("設計の承認", { exact: true })).toBeVisible();
  await expect(section).toHaveText(/^判断待ち/);
  await expect(page).toHaveURL("/");
  await capture(page, "一覧の判断待ちに移った設計の承認");
});
