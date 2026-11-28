import { expect, test } from "@playwright/test";
import { capture } from "./evidence";

test("選んだ箇所をストックして見直し、送ってスレッドを終える", async ({ page, request }) => {
  const response = await request.post("/api/conversations", {
    data: { projectId: "e2e-shop-api", workspace: { kind: "project" } },
  });
  await expect(response).toBeOK();
  const { conversation } = (await response.json()) as { conversation: { id: string } };
  const press = async (...keys: string[]) => {
    for (const key of keys) await page.keyboard.press(key);
  };
  const enterPrompt = async (label: string, text: string) => {
    await expect(page.getByRole("textbox", { name: label, exact: true })).toBeFocused();
    await page.keyboard.insertText(text);
    await press("Escape", "Enter");
  };

  await page.goto(`/conversations/${conversation.id}`);
  const main = page.getByRole("region", { name: /^会話: / });
  const mainBuffer = main.getByRole("textbox", { name: "バッファ", exact: true });
  const marks = main.locator(".cm-gutter");
  await expect(mainBuffer).toBeFocused();
  await press("i");
  await enterPrompt("指示", "ストックの確認を始める");
  await expect(main.getByText("結果を返します。", { exact: true })).toBeVisible();

  await press("g", "g", "/");
  await page.keyboard.insertText("在庫を記録");
  await press("Enter", "Shift+KeyV", "j", "Space", "c");
  await expect(page.getByRole("textbox", { name: "指示", exact: true })).toBeFocused();
  await capture(page, "選択した箇所を引用した指示の入力欄");
  await enterPrompt("指示", "在庫は永続化してください");
  await expect(marks.getByText("!", { exact: true }).first()).toBeVisible();

  await press("j", "j", "Space", "q");
  await enterPrompt("質問", "期限の理由を教えて");
  await expect(marks.getByText("?", { exact: true })).toBeVisible();
  await press("Space", "l");
  const stock = page.getByRole("region", { name: /^ストック: / });
  await expect(stock.getByText(/在庫は永続化してください/)).toBeVisible();
  await expect(stock.getByText(/期限の理由を教えて/)).toBeVisible();
  await capture(page, "質問と指示を見直すストックの一覧");

  await press("Space", "s", "a");
  await expect(marks.getByText("»", { exact: true })).toBeVisible();
  await press("Space", "r", "g", "g", "Enter");
  const thread = page.getByRole("region", {
    name: "スレッド: 期限の理由を教えて",
    exact: true,
  });
  await expect(thread.getByText("30 分が予約の有効期限です。", { exact: true })).toBeVisible();
  await capture(page, "引用と回答を表示した質問スレッド");

  await press("1", "Enter");
  await expect(page.getByRole("textbox", { name: "確定事項", exact: true })).toBeFocused();
  await capture(page, "確定事項の案が入った入力欄");
  await press("Escape", "Enter");
  await expect(stock.getByText(/期限は 30 分に統一します/)).toBeVisible();
  await capture(page, "スレッドを終えて確定事項が入ったストックの一覧");

  await press("Space", "s", "a");
  await expect(main.getByText("期限は 30 分に統一します。", { exact: true })).toBeVisible();
  await expect(marks.getByText("✓", { exact: true })).toBeVisible();
  await capture(page, "確定事項を送った会話と終了したスレッドの印");
});
