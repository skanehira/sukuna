import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capture } from "./evidence";

const conversationId = "recap-navigation-conversation";
const projectId = "recap-navigation-project";
const title = "予約 API の設計相談";
const chapter = "在庫の引き当て";
const chapterStart = "次に在庫の引き当てを検討します。";
const decision = "既存の予約 API を使う";
const evidence = "既存の予約 API に引き当てを追加します。";
const unread = "期限を過ぎた引き当ては解除します。";
const question = "引き当ての期限は何分にしますか?";
const answer = "引き当ての期限は 30 分にしてください。";

let projectPath: string | undefined;

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeAll(() => {
  const home = process.env.SUKUNA_E2E_HOME;
  if (!home) throw new Error("E2E のデータの置き場所がありません");
  const repository = mkdtempSync(join(home, "recap-navigation-"));
  projectPath = repository;
  const ledger = join(repository, "docs", "decisions");
  mkdirSync(ledger, { recursive: true });
  writeFileSync(
    join(ledger, `${conversationId}.md`),
    `<!-- sukuna-decisions:v2 -->\n# 決まったこと: ${title}\n\n- [決定] D1: ${JSON.stringify(decision)} <!-- seq=3 -->\n`,
  );

  const db = new Database(join(home, "sukuna.db"), { fileMustExist: true });
  try {
    const now = Date.now();
    db.transaction(() => {
      db.prepare(
        "INSERT INTO projects (id, name, path, default_branch) VALUES (?, ?, ?, 'main')",
      ).run(projectId, "予約管理", repository);
      db.prepare(
        "INSERT INTO conversations (id, project_id, kind, cwd, title, last_seq, last_read_seq, recap_seq, last_activity_at) VALUES (?, ?, 'chat', ?, ?, 5, 3, 5, ?)",
      ).run(conversationId, projectId, repository, title, now);

      const addEvent = db.prepare(
        "INSERT INTO conversation_events (conversation_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      addEvent.run(
        conversationId,
        1,
        "user_message",
        JSON.stringify({ text: "予約 API の方針を相談したい。", images: [], origin: "developer" }),
        now,
      );
      for (const [index, text] of [
        chapterStart,
        evidence,
        unread,
        `期限について確認があります。\n${question}`,
      ].entries()) {
        addEvent.run(
          conversationId,
          index + 2,
          "assistant_text",
          JSON.stringify({ text, parent_tool_use_id: null }),
          now,
        );
      }

      const addChapter = db.prepare(
        "INSERT INTO toc_entries (conversation_id, position, title, start_seq) VALUES (?, ?, ?, ?)",
      );
      addChapter.run(conversationId, 1, "予約の方針", 1);
      addChapter.run(conversationId, 2, chapter, 2);
      db.prepare(
        "INSERT INTO questions (id, conversation_id, seq, kind, text) VALUES (?, ?, 5, 'text', ?)",
      ).run(`${conversationId}-question`, conversationId, question);
    })();
  } finally {
    db.close();
  }
});

test.afterAll(() => {
  const home = process.env.SUKUNA_E2E_HOME;
  if (!home || !projectPath) return;

  const db = new Database(join(home, "sukuna.db"), { fileMustExist: true });
  try {
    db.pragma("foreign_keys = ON");
    db.transaction(() => {
      db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
      db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    })();
  } finally {
    db.close();
    rmSync(projectPath, { recursive: true, force: true });
  }
});

test("一覧から会話を開き、未読の先頭から質問・章・決定を辿ってキーだけで回答を送る", async ({
  page,
}) => {
  const keys = page.keyboard;
  const inbox = page.getByRole("region", { name: "一覧", exact: true });
  const conversation = page.getByRole("region", { name: `会話: ${title}`, exact: true });
  const body = conversation.getByRole("textbox", { name: "バッファ", exact: true });
  const cursor = conversation.locator(".cm-line.cm-activeLine");

  await page.goto("/");
  await expect(inbox.getByRole("textbox", { name: "バッファ", exact: true })).toBeFocused();
  await expect(inbox.getByText(`会話: ${title}`, { exact: true })).toBeVisible();
  await keys.press("/");
  await expect(inbox.locator(".cm-vim-panel input")).toBeFocused();
  await keys.insertText(title);
  await keys.press("Enter");
  await expect(
    inbox.locator(".cm-line.cm-activeLine").getByText(`会話: ${title}`, { exact: true }),
  ).toBeVisible();
  await capture(page, "一覧で未読の会話を選択");
  await keys.press("Enter");

  const recent = page.getByRole("region", { name: "直近", exact: true });
  await expect(body).toBeFocused();
  await expect(cursor).toHaveText(unread);
  await expect(cursor).toBeInViewport();
  await expect(conversation.getByText("ここから未読", { exact: true })).toBeInViewport();
  await expect(recent.getByText(question, { exact: true })).toBeVisible();
  await capture(page, "未読の先頭と右ウィンドウの質問");
  await keys.press("Control+w");
  await keys.press("l");
  await expect(recent.getByRole("textbox", { name: "バッファ", exact: true })).toBeFocused();
  await keys.press("Enter");
  await expect(body).toBeFocused();
  await expect(cursor).toHaveText(question);
  await expect(cursor).toBeInViewport();
  await capture(page, "本文の質問の行にジャンプ");

  const toc = page.getByRole("region", { name: "目次", exact: true });
  await keys.press("Space");
  await keys.press("m");
  await expect(toc.getByRole("textbox", { name: "バッファ", exact: true })).toBeFocused();
  await keys.press("j");
  await keys.press("Enter");
  await expect(body).toBeFocused();
  await expect(cursor).toHaveText(chapterStart);
  await expect(cursor).toBeInViewport();
  await capture(page, "目次から本文の章の先頭にジャンプ");

  const decisions = page.getByRole("region", { name: "決まったこと", exact: true });
  await keys.press("Space");
  await keys.press("d");
  await expect(decisions.getByRole("textbox", { name: "バッファ", exact: true })).toBeFocused();
  await expect(decisions.getByText(`決定: ${decision}`, { exact: true })).toBeVisible();
  await keys.press("Enter");
  await expect(body).toBeFocused();
  await expect(cursor).toHaveText(evidence);
  await expect(cursor).toBeInViewport();
  await capture(page, "決まったことから根拠の発言にジャンプ");

  await keys.press("i");
  await expect(page.getByRole("textbox", { name: "指示", exact: true })).toBeFocused();
  await keys.type(answer);
  await keys.press("Escape");
  await keys.press("Enter");
  await expect(conversation.getByText(answer, { exact: true })).toBeInViewport();
  await capture(page, "送った回答が会話に表示された状態");
});
