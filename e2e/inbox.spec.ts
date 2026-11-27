import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { join } from "node:path";
import { capture } from "./evidence";

test.use({ viewport: { width: 1440, height: 900 } });
const projectId = "inbox-e2e-project";
const projectName = "inbox";
const targetId = "inbox-e2e-target";
const conversations = [
  ["inbox-e2e-first", "開発の方針"],
  ["inbox-e2e-second", "予約 API の期限"],
  [targetId, "予約 API の壁打ち"],
] as const;
test.beforeAll(() => {
  const home = process.env.SUKUNA_E2E_HOME;
  if (!home) throw new Error("E2E のデータの置き場所がありません");
  const db = new Database(join(home, "sukuna.db"));
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO projects (id, name, path, default_branch) VALUES (?, ?, ?, ?)").run(
    projectId,
    projectName,
    home,
    "main",
  );
  for (const [index, [id, title]] of conversations.entries()) {
    const at = Date.now() - index * 1000;
    db.prepare(
      "INSERT INTO conversations (id, project_id, kind, cwd, title, run_state, last_seq, recap_seq, last_activity_at) VALUES (?, ?, 'chat', ?, ?, 'idle', 1, 1, ?)",
    ).run(id, projectId, home, title, at);
    db.prepare(
      "INSERT INTO conversation_events (conversation_id, seq, type, payload, created_at) VALUES (?, 1, 'assistant_text', ?, ?)",
    ).run(id, JSON.stringify({ text: "どの方針で進めますか?", parent_tool_use_id: null }), at);
    db.prepare(
      "INSERT INTO questions (id, conversation_id, seq, kind, text) VALUES (?, ?, 1, 'text', ?)",
    ).run(`q-${id}`, id, "どの方針で進めますか?");
  }
  db.close();
});
test.afterAll(() => {
  const db = new Database(join(process.env.SUKUNA_E2E_HOME!, "sukuna.db"));
  db.pragma("foreign_keys = ON");
  db.prepare("DELETE FROM conversations WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  db.close();
});

test("一覧のVim移動・検索・選択で、本物のAPIの会話をキーボードだけで開く", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    const pendingConversationApi =
      new URL(message.location().url || page.url()).pathname === `/api/conversations/${targetId}` &&
      message.text() ===
        "Failed to load resource: the server responded with a status of 404 (Not Found)";
    if ((message.type() === "error" || message.type() === "warning") && !pendingConversationApi)
      errors.push(message.text());
  });
  await page.goto("/");
  const inbox = page.getByRole("region", { name: "一覧", exact: true });
  const rows = inbox
    .locator(".cm-kind-row")
    .filter({ has: page.getByText(projectName, { exact: true }) });
  await expect(rows).toHaveCount(conversations.length);
  for (const [, title] of conversations)
    await expect(rows.getByText(`会話: ${title}`, { exact: true })).toHaveCount(1);
  await capture(page, "一覧の初期表示");
  await page.keyboard.press("j");
  await page.keyboard.press("k");
  await page.keyboard.press("/");
  await expect(inbox.locator(".cm-vim-panel input")).toBeVisible();
  await page.keyboard.insertText("予約 API");
  await page.keyboard.press("Enter");
  await page.keyboard.press("n");
  await capture(page, "Vim検索で次の会話を選んだ状態");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`/conversations/${targetId}`);
  await capture(page, "会話URLへの遷移後（会話APIは別issueで接続）");
  expect(errors).toEqual([]);
});
