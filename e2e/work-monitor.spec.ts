import { expect, test } from "@playwright/test";
import { capture } from "./evidence";

test.use({ viewport: { width: Number(process.env.UI_VIEWPORT_WIDTH ?? 1440), height: 900 } });

test("キーだけで作業中の会話を見て、タイムラインを開き、AI を止める", async ({ page }) => {
  await page.goto("/conversations/e2e-work-monitor");
  const conversation = page.getByRole("region", { name: /^会話: / });
  const working = conversation.getByLabel("作業中の状況");
  await expect(working).toBeVisible();
  await expect(conversation.getByRole("textbox")).toBeFocused();
  await capture(page, "作業中の会話");

  await page.keyboard.press("Space");
  await page.keyboard.press("t");
  const timeline = page.getByRole("region", { name: "タイムライン", exact: true });
  await expect(timeline.getByRole("textbox")).toBeFocused();
  await expect(timeline.getByText("報告 (3 分ごと)", { exact: true })).toBeVisible();
  await capture(page, "タイムラインを開いた状態");

  const row = timeline.locator(".cm-activeLine");
  for (let attempt = 0; attempt < 10; attempt++) {
    if ((await row.textContent())?.includes("CSV の書き出し")) break;
    await page.keyboard.press("j");
  }
  await expect(row).toContainText("CSV の書き出し");
  await page.keyboard.press("Enter");
  const details = page.getByRole("region", { name: "タスクの詳細", exact: true });
  await expect(details.getByRole("textbox")).toBeFocused();
  await capture(page, "タスクの詳細を開いた状態");
  await page.keyboard.press("Control+h");
  await expect(timeline.getByRole("textbox")).toBeFocused();

  const stopped = page.waitForResponse(
    (response) =>
      response.url().endsWith("/conversations/e2e-work-monitor/stop") &&
      response.request().method() === "POST",
  );
  await page.keyboard.press("Space");
  await page.keyboard.press("x");
  await stopped;
  await expect(working).toHaveCount(0);
  await expect(timeline).toBeVisible();
  await capture(page, "AI を止めて指示待ちになった会話");
});
