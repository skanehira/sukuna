import { expect, test } from "@playwright/test";
import { capture } from "./evidence";

test("アプリを開くと、見出しとツリー・主のウィンドウが出る", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "sukuna" })).toBeVisible();
  await expect(page.getByRole("region", { name: "sukuna" })).toBeVisible();
  await expect(page.getByRole("region", { name: "一覧" })).toBeVisible();
  await capture(page, "アプリの初期表示");
});
