import { expect, test } from "@playwright/test";
import { capture } from "./evidence";

test("キーだけで会話を始め、指示を送り、2 問に答えると AI が続きを返す", async ({ page }) => {
  await page.goto("/");
  const inbox = page.getByRole("region", { name: "一覧", exact: true });
  await expect(inbox.getByRole("textbox", { name: "バッファ" })).toBeFocused();

  await page.keyboard.press("Space");
  await page.keyboard.press("n");
  const switcher = page.getByRole("region", { name: "会話を始める・切り替える" });
  await expect(switcher.getByText("shop-api で会話を始める", { exact: true })).toBeVisible();
  await capture(page, "会話を始めるメニュー");
  await page.keyboard.press("1");
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/conversations\/[^/?]+$/);
  const conversation = page.getByRole("region", { name: /^会話: / });
  await expect(conversation.getByRole("textbox", { name: "バッファ" })).toBeFocused();
  await capture(page, "新しい会話を開いた状態");
  await page.keyboard.press("i");
  await expect(page.getByRole("textbox", { name: "指示", exact: true })).toBeFocused();
  await page.keyboard.type("予約 API を作って");
  await capture(page, "指示を入力した状態");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");

  await expect(conversation.locator(".cm-kind-ask")).toHaveCount(2);
  await capture(page, "AI が質問を 2 問出した状態");
  await page.keyboard.press("1");
  await page.keyboard.press("Enter");
  await expect(conversation.locator(".cm-menu-done")).toHaveCount(1);
  await page.keyboard.press("4");
  await page.keyboard.press("Enter");
  await expect(conversation.locator(".cm-menu-done")).toHaveCount(2);
  await capture(page, "2 問に答え、まとめて送る前の状態");
  await page.keyboard.press("6");
  await page.keyboard.press("Enter");

  await expect(
    conversation.getByText("選んだ方針で設計を進めます。", { exact: true }),
  ).toBeVisible();
  await capture(page, "回答を送り、AI の続きが表示された状態");
});
