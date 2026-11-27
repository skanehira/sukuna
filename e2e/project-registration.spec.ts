import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { capture } from "./evidence";

test.use({ viewport: { width: Number(process.env.UI_VIEWPORT_WIDTH ?? 1440), height: 900 } });

test("設定から Git リポジトリをキーボードで登録し、その節とツリーに表示する", async ({
  page,
}, testInfo) => {
  const path = testInfo.outputPath("tools-ui");
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["-C", path, "init", "-b", "main"]);

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const command = async (value: string) => {
    await page.keyboard.press("Shift+Semicolon");
    const input = page.getByRole("textbox", { name: "コマンド" });
    await input.fill(value);
    await input.press("Enter");
  };

  await page.goto("/");
  await expect(page.getByRole("region", { name: "一覧" })).toBeVisible();
  await command("set");
  const settings = page.getByRole("region", { name: "設定" });
  const register = settings.getByText("プロジェクトを登録する", { exact: true });
  await expect(register).toBeVisible();
  await capture(page, "設定にあるプロジェクトの登録メニュー");

  const lines = settings.locator(".cm-line");
  const row = (await lines.allTextContents()).findIndex((text) =>
    text.includes("プロジェクトを登録する"),
  );
  await command(String(row + 1));
  await page.keyboard.press("Enter");
  const input = page.getByRole("textbox", { name: "プロジェクトのパス" });
  await expect(input).toBeFocused();
  await page.keyboard.insertText(path);
  await capture(page, "登録するリポジトリのパスを入力");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");

  const tree = page.getByRole("region", { name: "sukuna" });
  await expect(tree.getByText("tools-ui", { exact: true })).toBeVisible();
  await expect(settings.getByText("プロジェクト tools-ui", { exact: true })).toBeVisible();
  await expect(settings.getByRole("textbox", { name: "バッファ" })).toBeFocused();
  await capture(page, "新しいプロジェクトをツリーと設定に表示");
  expect(errors).toEqual([]);
});
