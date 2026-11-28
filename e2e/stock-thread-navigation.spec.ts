import { expect, test, type Locator } from "@playwright/test";
import { capture } from "./evidence";

const PAINT_COLORS = ["surface", "raised", "line", "sel", "accent", "search"] as const;
type PaintColor = (typeof PAINT_COLORS)[number];
type PaintColumn = number | "after-text" | "right";

async function paintedBackgrounds(line: Locator, columns: PaintColumn[]) {
  const xs = await line.evaluate((element, columns) => {
    const row = element.getBoundingClientRect();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) textNodes.push(node as Text);
    const range = document.createRange();
    return columns.map((column) => {
      if (column === "right") return Math.floor(row.width - 6);
      if (column === "after-text") {
        range.selectNodeContents(element);
        return Math.floor(range.getBoundingClientRect().right - row.left + 2);
      }
      let offset = column;
      for (const node of textNodes) {
        const length = node.length;
        if (offset < length) {
          range.setStart(node, offset);
          range.setEnd(node, offset + 1);
          const { left, width } = range.getBoundingClientRect();
          return Math.floor(left - row.left + width / 2);
        }
        offset -= length;
      }
      throw new Error(`No character at column ${column}`);
    });
  }, columns);
  const png = (await line.screenshot({ scale: "css" })).toString("base64");
  return line.page().evaluate(
    async ({ png, xs, colors }) => {
      const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      const theme = getComputedStyle(document.documentElement);
      const codes = colors.map((name) =>
        name === "search"
          ? 0xffffab
          : Number.parseInt(theme.getPropertyValue(`--color-${name}`).trim().slice(1), 16),
      );
      return xs.map((x) => {
        const pixels = ctx.getImageData(x, 0, 1, bitmap.height).data;
        const counts = codes.map(() => 0);
        for (let i = 0; i < pixels.length; i += 4) {
          const code = pixels[i] * 65_536 + pixels[i + 1] * 256 + pixels[i + 2];
          const match = codes.indexOf(code);
          if (match >= 0) counts[match]++;
        }
        const largest = Math.max(...counts);
        return largest > 0 ? colors[counts.indexOf(largest)] : "other";
      });
    },
    { png, xs, colors: PAINT_COLORS },
  );
}

async function expectPaint(line: Locator, columns: PaintColumn[], colors: PaintColor[]) {
  await expect.poll(() => paintedBackgrounds(line, columns)).toEqual(colors);
}

test("選んだ箇所をストックして見直し、送ってスレッドを終える", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const response = await request.post("/api/conversations", {
    data: { projectId: "e2e-shop-api", workspace: { kind: "project" } },
  });
  await expect(response).toBeOK();
  const { conversation } = (await response.json()) as { conversation: { id: string } };
  const press = async (...keys: string[]) => {
    for (const key of keys) await page.keyboard.press(key);
  };
  const enterPrompt = async (label: string, text: string) => {
    await expect(page.getByRole("textbox", { name: label, exact: true })).toBeFocused();
    await page.keyboard.insertText(text);
    await press("Escape", "Enter");
  };

  await page.goto(`/conversations/${conversation.id}`);
  const main = page.getByRole("region", { name: /^会話: / });
  const mainBuffer = main.getByRole("textbox", { name: "バッファ", exact: true });
  const marks = main.locator(".cm-gutter");
  await expect(mainBuffer).toBeFocused();
  await press("i");
  await enterPrompt("指示", "ストックの確認を始める");
  await expect(main.getByText("結果を返します。", { exact: true })).toBeVisible();

  const cursorLayer = main.locator(".cm-vimCursorLayer");
  const cursor = cursorLayer.locator(".cm-cursor-primary");
  const firstReply = mainBuffer.locator(".cm-line").filter({ hasText: "在庫を記録します。" });
  const secondReply = mainBuffer.locator(".cm-line").filter({ hasText: "期限を検査します。" });
  const lastReply = mainBuffer.locator(".cm-line").filter({ hasText: "結果を返します。" });
  const instruction = mainBuffer.locator(".cm-line").filter({ hasText: "ストックの確認を始める" });
  await press("Shift+KeyG", "k", "k", "0");
  await expectPaint(firstReply, [0, 1, "right"], ["accent", "raised", "raised"]);
  await press("l");
  await expectPaint(firstReply, [0, 1, "right"], ["raised", "accent", "raised"]);
  await expect(cursorLayer).toHaveCSS("animation-name", "none");
  await capture(page, "Normal モードで会話の本文にブロックカーソルを表示");

  await press("v");
  await expectPaint(firstReply, [0, 1, 2, "right"], ["surface", "accent", "surface", "surface"]);
  await press("l", "l");
  await expectPaint(
    firstReply,
    [0, 1, 2, 3, 4, "right"],
    ["surface", "sel", "sel", "accent", "surface", "surface"],
  );
  await expect(cursorLayer).toHaveCSS("animation-name", "none");
  await capture(page, "ビジュアルモードで同じ行の文字を選択");

  await press("h");
  await expectPaint(firstReply, [1, 2, 3], ["sel", "accent", "surface"]);
  await press("o");
  await expectPaint(firstReply, [1, 2, 3], ["accent", "sel", "surface"]);
  await press("o", "j");
  await expectPaint(
    firstReply,
    [0, 1, 8, "after-text", "right"],
    ["surface", "sel", "sel", "surface", "surface"],
  );
  await expectPaint(secondReply, [0, 2, 3, "right"], ["sel", "accent", "surface", "surface"]);
  await capture(page, "ビジュアルモードで会話の本文を複数行にまたがって選択");
  await press("k");
  await expectPaint(firstReply, [1, 2, 3], ["sel", "accent", "surface"]);
  await expectPaint(secondReply, [0], ["surface"]);
  await press("h", "h");
  await expectPaint(firstReply, [0, 1, 2], ["accent", "sel", "surface"]);
  await press("Escape", "l");
  await expectPaint(firstReply, [0, 1, 2, "right"], ["raised", "accent", "raised", "raised"]);
  await capture(page, "選択解除後に Normal モードでカーソルを移動");

  await press("Shift+Digit4");
  await expectPaint(firstReply, [7, 8, "after-text"], ["raised", "accent", "raised"]);
  await press("v");
  await expectPaint(firstReply, [7, 8, "after-text"], ["surface", "accent", "surface"]);
  await press("h", "o");
  await expectPaint(firstReply, [7, 8, "after-text"], ["sel", "accent", "surface"]);
  await capture(page, "行末の文字に選択端のカーソルを表示");
  await press("l");
  await expectPaint(firstReply, [7, 8, "after-text"], ["sel", "sel", "accent"]);
  await press("Escape");

  await press("Shift+KeyG", "Shift+Digit4");
  await expectPaint(lastReply, [6, 7, "after-text"], ["raised", "accent", "raised"]);
  await press("v");
  await expectPaint(lastReply, [6, 7, "after-text"], ["surface", "accent", "surface"]);
  await press("h", "o");
  await expectPaint(lastReply, [6, 7, "after-text"], ["sel", "accent", "surface"]);
  await capture(page, "会話の最終行の最後の文字にカーソルを表示");
  await press("Escape", "k", "k");

  await press("k", "0", "l");
  await press("v", "l", "l");
  await expectPaint(
    instruction,
    [0, 1, 2, 3, 4, "right"],
    ["raised", "sel", "sel", "accent", "raised", "raised"],
  );
  await capture(page, "背景色のある発言の文字を選択");
  await press("Control+BracketLeft");
  await expectPaint(instruction, [1, 3, "right"], ["line", "accent", "line"]);
  expect(errors).toEqual([]);

  await press("/");
  await page.keyboard.insertText("在庫を記録");
  await press("Enter", "l", "v", "l", "l");
  await expectPaint(firstReply, [0, 1, 2, 3, 4], ["search", "sel", "sel", "accent", "search"]);
  await capture(page, "検索した語の一部を選択");
  await press("Escape", "0");
  await press("Shift+KeyV", "j", "Space", "c");
  await expect(page.getByRole("textbox", { name: "指示", exact: true })).toBeFocused();
  await expect(cursor).toBeHidden();
  await capture(page, "選択した箇所を引用した指示の入力欄");
  await enterPrompt("指示", "在庫は永続化してください");
  await expect(marks.getByText("!", { exact: true }).first()).toBeVisible();

  await press("j", "j", "Space", "q");
  await enterPrompt("質問", "期限の理由を教えて");
  await expect(marks.getByText("?", { exact: true })).toBeVisible();
  await press("Space", "l");
  const stock = page.getByRole("region", { name: /^ストック: / });
  await expect(stock.getByText(/在庫は永続化してください/)).toBeVisible();
  await expect(stock.getByText(/期限の理由を教えて/)).toBeVisible();
  await capture(page, "質問と指示を見直すストックの一覧");

  await press("Space", "s", "a");
  await expect(marks.getByText("»", { exact: true })).toBeVisible();
  await press("Space", "r", "g", "g", "Enter");
  const thread = page.getByRole("region", {
    name: "スレッド: 期限の理由を教えて",
    exact: true,
  });
  await expect(thread.getByText("30 分が予約の有効期限です。", { exact: true })).toBeVisible();
  await capture(page, "引用と回答を表示した質問スレッド");

  await press("1", "Enter");
  await expect(page.getByRole("textbox", { name: "確定事項", exact: true })).toBeFocused();
  await capture(page, "確定事項の案が入った入力欄");
  await press("Escape", "Enter");
  await expect(stock.getByText(/期限は 30 分に統一します/)).toBeVisible();
  await capture(page, "スレッドを終えて確定事項が入ったストックの一覧");

  await press("Space", "s", "a");
  await expect(main.getByText("期限は 30 分に統一します。", { exact: true })).toBeVisible();
  await expect(marks.getByText("✓", { exact: true })).toBeVisible();
  await capture(page, "確定事項を送った会話と終了したスレッドの印");
  expect(errors).toEqual([]);
});
