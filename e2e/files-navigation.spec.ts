import { expect, test as base } from "@playwright/test";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { capture } from "./evidence";

const title = "在庫の引き当ての相談";
const firstLine = "export const reservationTimeout = 30;";
const matchLine = "export const reserve = () => reservationTimeout;";

const test = base.extend<{ fileConversation: string }>({
  fileConversation: async ({ browserName }, use) => {
    const home = process.env.SUKUNA_E2E_HOME;
    if (!home) throw new Error("E2E のデータディレクトリがありません。");

    const cwd = mkdtempSync(join(home, `file-navigation-${browserName}-`));
    const id = basename(cwd);
    const db = new Database(join(home, "sukuna.db"), { fileMustExist: true });
    db.pragma("foreign_keys = ON");
    try {
      execFileSync("git", ["init", "-q", "-b", "main", cwd]);
      mkdirSync(join(cwd, "src"));
      writeFileSync(
        join(cwd, "src/confirm.ts"),
        [firstLine, "", "const enabled = true;", "", matchLine, ""].join("\n"),
      );
      db.transaction(() => {
        db.prepare(
          "INSERT INTO projects(id,name,path,default_branch) VALUES (?, ?, ?, 'main')",
        ).run(id, "inventory-api", cwd);
        db.prepare(
          "INSERT INTO conversations(id,project_id,kind,cwd,title,run_state,last_activity_at) VALUES (?, ?, 'chat', ?, ?, 'idle', ?)",
        ).run(id, id, cwd, title, Date.now());
      })();

      await use(id);
    } finally {
      try {
        db.transaction(() => {
          db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
          db.prepare("DELETE FROM projects WHERE id = ?").run(id);
        })();
      } finally {
        db.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  },
});

test.use({ viewport: { width: 1440, height: 900 } });

test("会話からキーだけでツリーと検索を開き、一致したファイルの行を読む", async ({
  page,
  fileConversation,
}) => {
  await page.goto(`/conversations/${fileConversation}`);
  const conversation = page.getByRole("region", { name: `会話: ${title}`, exact: true });
  await expect(conversation.getByRole("textbox", { name: "バッファ", exact: true })).toBeFocused();

  await page.keyboard.press("Space");
  await page.keyboard.press("e");
  const tree = page.getByRole("region", { name: "ファイル", exact: true });
  await expect(tree.getByRole("textbox", { name: "バッファ", exact: true })).toBeFocused();
  await expect(tree.getByText(/▸ src$/)).toBeInViewport();
  await capture(page, "会話の右にファイルツリーを表示");

  await page.keyboard.press("j");
  await expect(tree.locator(".cm-line.cm-activeLine")).toHaveText(/▸ src$/);
  await page.keyboard.press("Enter");
  await expect(tree.getByText("confirm.ts", { exact: true })).toBeInViewport();
  await page.keyboard.press("j");
  await expect(tree.locator(".cm-line.cm-activeLine")).toHaveText("confirm.ts");
  await page.keyboard.press("Enter");

  const file = page.getByRole("region", { name: /^src\/confirm\.ts\b/ });
  const contents = file.getByRole("textbox", { name: "バッファ", exact: true });
  await expect(contents).toBeFocused();
  await expect(file.getByText(firstLine, { exact: true })).toBeInViewport();
  await capture(page, "ツリーから開いたファイルの本文");

  await page.keyboard.press("Space");
  await page.keyboard.press("/");
  const command = page.getByRole("textbox", { name: "コマンド", exact: true });
  await expect(command).toBeFocused();
  await page.keyboard.type("reserve");
  await page.keyboard.press("Enter");

  const results = page.getByRole("region", { name: "ファイルの中身を検索", exact: true });
  await expect(results.getByRole("textbox", { name: "バッファ", exact: true })).toBeFocused();
  await expect(results.getByText(/src\/confirm\.ts:5:/)).toBeInViewport();
  await capture(page, "reserve が一致した検索結果");

  await page.keyboard.press("j");
  await page.keyboard.press("Enter");
  await expect(contents).toBeFocused();
  const cursor = file.locator(".cm-line.cm-activeLine");
  await expect(cursor).toHaveText(matchLine);
  await expect(cursor).toBeInViewport();
  await capture(page, "検索で一致した5行目にカーソルがあるファイル");
});

test("Markdown のファイルの Mermaid の図を描き、図の中の HTML は要素にしない", async ({
  page,
  fileConversation,
}) => {
  const home = process.env.SUKUNA_E2E_HOME;
  if (!home) throw new Error("E2E のデータディレクトリがありません。");
  writeFileSync(
    join(home, fileConversation, "DIAGRAM.md"),
    [
      "# 引き当ての流れ",
      "",
      "```mermaid",
      "graph TD",
      '  A["<img src=x onerror=window.mermaidInjected=1>"] --> B[引き当て]',
      "```",
      "",
    ].join("\n"),
  );

  await page.goto(`/conversations/${fileConversation}/file?path=DIAGRAM.md&line=1`);
  const diagram = page.locator(".cm-mermaid svg");
  await expect(diagram).toBeVisible();
  await expect(diagram).toContainText("引き当て");
  await capture(page, "Markdown のファイルに描いた Mermaid の図");

  await expect(page.locator(".cm-mermaid img")).toHaveCount(0);
  expect(await page.evaluate(() => "mermaidInjected" in window)).toBe(false);
});
