import { expect, test, type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { join } from "node:path";
import { capture } from "./evidence";

const id = "lifecycle-e2e-chat";
const title = "締めくくりを試す在庫の相談";
const reply = "在庫の相談を再開してください";

function withDatabase(work: (db: Database.Database) => void) {
  const home = process.env.SUKUNA_E2E_HOME;
  if (!home) throw new Error("E2E のデータの置き場所がありません");
  const db = new Database(join(home, "sukuna.db"), { fileMustExist: true });
  try {
    db.pragma("foreign_keys = ON");
    db.transaction(() => work(db)).immediate();
  } finally {
    db.close();
  }
}

test.beforeAll(() =>
  withDatabase((db) => {
    const at = Date.now();
    const { path: cwd } = db
      .prepare("SELECT path FROM projects WHERE id = 'e2e-shop-api'")
      .get() as {
      path: string;
    };
    db.prepare(
      "INSERT INTO conversations(id,project_id,kind,cwd,title,run_state,last_seq,recap_seq,last_activity_at) VALUES (?,'e2e-shop-api','chat',?,?,'idle',1,1,?)",
    ).run(id, cwd, title, at);
    db.prepare(
      "INSERT INTO conversation_events(conversation_id,seq,type,payload,created_at) VALUES (?,1,'assistant_text',?,?)",
    ).run(id, JSON.stringify({ text: "在庫の方針をまとめました。", parent_tool_use_id: null }), at);
  }),
);
test.afterAll(() =>
  withDatabase((db) => {
    db.prepare("DELETE FROM notifications WHERE target_kind='conversation' AND target_id=?").run(
      id,
    );
    db.prepare("DELETE FROM conversations WHERE id=?").run(id);
  }),
);

async function chooseConversation(page: Page, region: Locator) {
  await expect(region.getByRole("textbox", { name: "バッファ", exact: true })).toBeFocused();
  await page.keyboard.press("/");
  await expect(region.locator(".cm-vim-panel input")).toBeFocused();
  await page.keyboard.insertText(title);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp("/conversations/" + id + "(?:\\?.*)?$"));
}

test.use({ viewport: { width: 1440, height: 900 } });

test("閉じた会話を一覧で選び、続きを送ってキーボードだけで再開する", async ({ page }) => {
  await page.goto("/");
  const inbox = page.getByRole("region", { name: "一覧", exact: true });
  const row = (region: Locator) => region.getByText("会話: " + title, { exact: true });
  await expect(row(inbox)).toBeVisible();
  await capture(page, "開いている会話が並ぶ一覧");
  await chooseConversation(page, inbox);

  const chat = page.getByRole("region", { name: "会話: " + title });
  await expect(chat.getByRole("textbox", { name: "バッファ", exact: true })).toBeFocused();
  await page.keyboard.press("Space");
  await page.keyboard.press("z");
  const closing = page.getByRole("region", { name: "会話を締めくくる", exact: true });
  await expect(closing.getByText("この会話を閉じる", { exact: true })).toBeVisible();
  await expect(closing.getByRole("textbox", { name: "バッファ", exact: true })).toBeFocused();
  await capture(page, "締めくくりの確認を開いた状態");
  await page.keyboard.press("1");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/");
  await expect(inbox.getByRole("textbox", { name: "バッファ", exact: true })).toBeFocused();
  await expect(row(inbox)).toHaveCount(0);
  await capture(page, "閉じた会話が外れた一覧");

  await page.keyboard.press("Space");
  await page.keyboard.press("b");
  const conversations = page.getByRole("region", { name: "会話とスレッドの一覧", exact: true });
  const closedRow = conversations
    .locator(".cm-kind-row")
    .filter({ has: page.getByText("会話: " + title, { exact: true }) });
  await expect(closedRow.getByText("閉じた", { exact: true })).toBeVisible();
  await capture(page, "会話とスレッドの一覧に閉じた会話が並ぶ状態");
  await chooseConversation(page, conversations);

  await expect(chat.getByRole("textbox", { name: "バッファ", exact: true })).toBeFocused();
  await page.keyboard.press("i");
  await expect(page.getByRole("textbox", { name: "指示", exact: true })).toBeFocused();
  await page.keyboard.insertText(reply);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(chat.getByText(reply, { exact: true })).toBeVisible();
  await expect(chat.getByRole("textbox", { name: "バッファ", exact: true })).toBeFocused();
  await page.keyboard.press("Space");
  await page.keyboard.press("h");
  await expect(page).toHaveURL("/");
  await expect(row(inbox)).toBeVisible();
  await capture(page, "続きを送った会話が一覧に戻った状態");
});
