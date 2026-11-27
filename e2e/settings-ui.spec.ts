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

  await page.keyboard.press("Space");
  await page.keyboard.press("n");
  await expect(page.getByText("shop-api で会話を始める", { exact: true })).toBeVisible();
  await page.keyboard.press("1");
  await page.keyboard.press("Enter");
  const conversation = page.getByRole("region", { name: /^会話: / });
  const conversationBuffer = conversation.getByRole("textbox", { name: "バッファ" });
  await expect(conversationBuffer).toBeFocused();
  await command(page, "h");
  const sameTabHelp = page.getByRole("region", { name: "ヘルプ" });
  await expect(sameTabHelp.getByRole("textbox", { name: "バッファ" })).toBeFocused();
  await command(another, "map <Space>M recap.toc");
  for (const tabHelp of [sameTabHelp, help]) {
    await expect(tabHelp.getByText("Space m、Space M", { exact: true })).toBeVisible();
  }
  const tocKey = sameTabHelp.getByText("Space m、Space M", { exact: true });
  await tocKey.click();
  await expect(tocKey).toBeInViewport();
  await capture(page, "会話から開いたヘルプに、別タブで変更した目次のキーが出る");
  await page.keyboard.press("-");
  await expect(conversationBuffer).toBeFocused();
  await page.keyboard.press("Space");
  await page.keyboard.press("Shift+M");
  await expect(page.getByRole("region", { name: "目次", exact: true })).toBeVisible();
  await capture(page, "変更したキーで目次を開く");
  await command(page, "q");
  await expect(conversationBuffer).toBeFocused();

  await page.route("**/api/projects/*/conversations", (route) =>
    route.fulfill({ json: { conversations: [], issueThreads: [] } }),
  );
  await command(another, "map <Space>B conversation.list");
  await expect(help.getByText("Space b、Space B", { exact: true })).toBeVisible();
  await page.keyboard.press("Space");
  await page.keyboard.press("Shift+B");
  await expect(page).toHaveURL("/convs");
  const list = page.getByRole("region", { name: "会話とスレッドの一覧" });
  await expect(list.getByText("会話はまだありません。Space n で始めます")).toBeVisible();
  await capture(page, "別タブで変更したキーで会話とスレッドの一覧を開く");
  await page.keyboard.press("-");
  await expect(conversationBuffer).toBeFocused();

  await command(page, "set");
  const settings = page.getByRole("region", { name: "設定" });
  await expect(settings.getByText("キーの割り当てを既定に戻す", { exact: true })).toBeVisible();
  await capture(page, "変更した割り当てがある設定画面");
  const settingsRows = await settings.locator(".cm-line").allTextContents();
  const resetRow = settingsRows.findIndex((line) => line.includes("キーの割り当てを既定に戻す"));
  await command(page, String(resetRow + 1));
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("操作の確認")).toBeVisible();
  await capture(page, "既定の割り当てに戻す前の確認");
  await page.keyboard.press("y");
  await expect(help.getByText("Space p", { exact: true })).toBeVisible();
  await expect(help.getByText("Space m", { exact: true })).toBeVisible();
  await expect(help.getByText("Space b", { exact: true })).toBeVisible();
  await expect(settings.getByText("既定のまま", { exact: true })).toBeVisible();
  await capture(page, "既定の割り当てに戻した設定画面");
  expect(errors).toEqual([]);
});
