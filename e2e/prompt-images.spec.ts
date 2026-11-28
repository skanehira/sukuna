import { expect, test } from "@playwright/test";
import { capture } from "./evidence";

test.use({ viewport: { width: Number(process.env.UI_VIEWPORT_WIDTH ?? 1440), height: 900 } });

test("macOS の入力欄で Ctrl+v を押すと、クリップボードの画像の縮小が番号付きで並び、送ると発言に画像が付く", async ({
  page,
  context,
  baseURL,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" });
  });
  await page.goto("/");
  const inbox = page.getByRole("region", { name: "一覧", exact: true });
  await expect(inbox.getByRole("textbox", { name: "バッファ" })).toBeFocused();
  await page.keyboard.press("Space");
  await page.keyboard.press("n");
  const switcher = page.getByRole("region", { name: "会話を始める・切り替える" });
  await expect(switcher.getByText("shop-api で会話を始める", { exact: true })).toBeVisible();
  await page.keyboard.press("1");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/conversations\/[^/?]+$/);
  const conversation = page.getByRole("region", { name: /^会話: / });
  await expect(conversation.getByRole("textbox", { name: "バッファ" })).toBeFocused();

  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 100;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#2f6fdf";
    context.fillRect(0, 0, 160, 100);
    context.fillStyle = "#f4b400";
    context.fillRect(40, 25, 80, 50);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("no png"))), "image/png"),
    );
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  });
  await page.keyboard.press("i");
  await expect(page.getByRole("textbox", { name: "指示", exact: true })).toBeFocused();
  await page.keyboard.type("この画面を確認して");
  await page.keyboard.press("Control+v");

  const thumbnail = page
    .getByRole("listbox", { name: "貼った画像" })
    .getByRole("option", { name: "画像 1" })
    .getByRole("img", { name: "画像 1" });
  await expect(thumbnail).toBeVisible();
  await expect
    .poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);
  await capture(page, "Ctrl+v で貼った画像の縮小が番号 1 で並んだ状態");

  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(conversation.locator(".cm-kind-speaker")).toHaveCount(1);
  await expect(conversation.locator(".cm-kind-note")).toHaveCount(1);
  await capture(page, "送った発言に画像 1 件が付いた状態");
});
