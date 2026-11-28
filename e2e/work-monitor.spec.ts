import { expect, test } from "@playwright/test";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capture } from "./evidence";

test.use({ viewport: { width: Number(process.env.UI_VIEWPORT_WIDTH ?? 1440), height: 900 } });

function recordReport(home: string, text: string) {
  const file = join(home, "claude-config/timeline/sessions/e2e-work-monitor-session.json");
  const timeline = JSON.parse(readFileSync(file, "utf8"));
  timeline.reports.push({ at: Date.now(), text });
  writeFileSync(file, JSON.stringify(timeline));
}

test("キーだけで作業中の会話を見て、タイムラインを開き、AI を止める", async ({ page }) => {
  const home = process.env.SUKUNA_E2E_HOME!;
  writeFileSync(join(home, "shop-api", "monitor-notes.md"), "CSV の検証手順");
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

  await page.keyboard.press("Space");
  await page.keyboard.press("e");
  const files = page.getByRole("region", { name: "ファイル", exact: true });
  await expect(files.getByRole("textbox")).toBeFocused();
  await expect(files.getByText("monitor-notes.md", { exact: false })).toBeVisible();
  const fileRow = files.locator(".cm-activeLine");
  for (let attempt = 0; attempt < 20; attempt++) {
    if ((await fileRow.textContent())?.includes("monitor-notes.md")) break;
    await page.keyboard.press("j");
  }
  await expect(fileRow).toContainText("monitor-notes.md");
  await page.keyboard.press("Enter");
  const file = page.getByRole("region", { name: /^monitor-notes\.md / });
  await expect(file.getByText("CSV の検証手順")).toBeVisible();
  await page.keyboard.press("Control+w");
  await page.keyboard.press("l");
  await expect(files.getByRole("textbox")).toBeFocused();
  await page.reload();
  await expect(files.getByRole("textbox")).toBeFocused();
  await page.keyboard.press("Control+h");
  await expect(timeline.getByRole("textbox")).toBeFocused();
  recordReport(home, "ファイルを読みながら確認した報告");
  await expect(timeline.getByText("ファイルを読みながら確認した報告")).toBeVisible();
  await page.reload();
  await expect(timeline.getByRole("textbox")).toBeFocused();
  await expect(timeline.getByText("ファイルを読みながら確認した報告")).toBeVisible();
  recordReport(home, "再読み込み後も受け取った報告");
  await expect(timeline.getByText("再読み込み後も受け取った報告")).toBeVisible();
  await capture(page, "ファイルを開いたまま受け取った作業報告");

  await page.keyboard.press("Control+w");
  await page.keyboard.press("h");
  await expect(file.getByRole("textbox")).toBeFocused();
  await page.keyboard.press("-");
  await expect(conversation.getByRole("textbox")).toBeFocused();
  recordReport(home, "会話に戻って確認した報告");
  await expect(timeline.getByText("会話に戻って確認した報告")).toBeVisible();
  await page.keyboard.press("Control+w");
  await page.keyboard.press("l");
  await expect(timeline.getByRole("textbox")).toBeFocused();

  await page.goForward();
  await expect(file.getByText("CSV の検証手順")).toBeVisible();
  await expect(timeline.getByRole("textbox")).toBeFocused();
  unlinkSync(join(home, "shop-api", "monitor-notes.md"));
  await page.reload();
  await expect(timeline).toHaveCount(0);
  await expect(file.getByRole("textbox")).toBeFocused();
  await capture(page, "削除されたファイルの表示で主に戻った状態");
  await page.keyboard.press("-");
  await expect(conversation.getByRole("textbox")).toBeFocused();
  await page.keyboard.press("Control+w");
  await page.keyboard.press("l");
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
