import { expect, test } from "@playwright/test";
import { capture } from "./evidence";

test("アプリを開くと、ツリー・主のウィンドウ・右のウィンドウが出る", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("region", { name: "sukuna" })).toBeVisible();
  await expect(page.getByRole("region", { name: "会話: バッファの土台" })).toBeVisible();
  await expect(page.getByRole("region", { name: "直近" })).toBeVisible();
  await capture(page, "バッファの土台の画面 (初期表示)");
});
