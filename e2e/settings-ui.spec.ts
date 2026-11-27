import { expect, test, type Page } from "@playwright/test";
import { capture } from "./evidence";

test.use({ viewport: { width: Number(process.env.UI_VIEWPORT_WIDTH ?? 1440), height: 900 } });

async function command(page: Page, text: string) {
  await page.keyboard.press("Shift+Semicolon");
  const input = page.getByRole("textbox", { name: "コマンド" });
  await input.fill(text);
  await input.press("Enter");
}

test("キーを変更し、別タブで開いているヘルプを更新して設定で既定へ戻す", async ({
  page,
  context,
}) => {
  const another = await context.newPage();
  const received: string[] = [];
  another.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname !== "/ws") return;
    socket.on("framereceived", ({ payload }) => received.push(String(payload)));
  });
  const errors: string[] = [];
  for (const tab of [page, another]) {
    tab.on("pageerror", (error) => errors.push(error.message));
    tab.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") errors.push(message.text());
    });
  }
  await another.goto("/");
  await expect(another.getByRole("region", { name: "一覧" })).toBeVisible();
  await command(another, "help");
  const help = another.getByRole("region", { name: "ヘルプ" });
  await expect(help.getByRole("textbox", { name: "バッファ" })).toBeVisible();
  await expect.poll(() => received.some((frame) => frame.includes('"type":"runner"'))).toBe(true);
  await capture(another, "別タブでヘルプを開いた状態");

  await page.goto("/");
  await expect(page.getByRole("region", { name: "一覧" })).toBeVisible();
  await command(page, "map <Space>T tree.focus");
  await expect(help.getByText("Space p、Space T", { exact: true })).toBeVisible();

  const actionRow = help.getByText("Space p、Space T", { exact: true });
  await actionRow.click();
  await expect(another.getByRole("status")).toContainText("tree.focus");
  await capture(another, "新しいキーを反映したヘルプと動作の名前");

  await command(page, "set");
  const settings = page.getByRole("region", { name: "設定" });
  await expect(settings.getByText("キーの割り当てを既定に戻す", { exact: true })).toBeVisible();
  await capture(page, "変更した割り当てがある設定画面");
  await page.keyboard.press("1");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("操作の確認")).toBeVisible();
  await capture(page, "既定の割り当てに戻す前の確認");
  await page.keyboard.press("y");
  await expect(help.getByText("Space p", { exact: true })).toBeVisible();
  await expect(settings.getByText("既定のまま", { exact: true })).toBeVisible();
  await capture(page, "既定の割り当てに戻した設定画面");
  expect(errors).toEqual([]);
});
