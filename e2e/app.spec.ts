import { expect, test } from "@playwright/test";
import { capture } from "./evidence";

test("アプリを開くと画面が出る", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "sukuna" })).toBeVisible();
  await capture(page, "アプリの初期表示");
});
