import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { capture } from "./evidence";

test("作業中に預けた指示を ↑ で呼び出して直し、Ctrl+Enter で AI を止めてすぐに届ける", async ({
  page,
  request,
}) => {
  const started = await request.post("/api/conversations", {
    data: { projectId: "e2e-shop-api", workspace: { kind: "project" } },
  });
  await expect(started).toBeOK();
  const { conversation } = (await started.json()) as { conversation: { id: string } };
  const path = `/api/conversations/${conversation.id}`;
  const send = (text: string) =>
    request.post(`${path}/messages`, {
      data: { text, images: [], mode: "send", clientMessageId: randomUUID() },
    });
  await expect(await send("E2E 預けた指示を直す作業")).toBeOK();
  await expect
    .poll(async () => {
      const state = (await (await request.get(path)).json()) as {
        conversation: { runState: string };
      };
      return state.conversation.runState;
    })
    .toBe("working");
  await expect(await send("BOM 付きのときも確かめて")).toBeOK();
  await expect(await send("終わったらテストの件数を教えて")).toBeOK();

  await page.goto(`/conversations/${conversation.id}`);
  const view = page.getByRole("region", { name: /^会話: / });
  await expect(view.getByRole("textbox", { name: "バッファ" })).toBeFocused();
  await page.keyboard.press("i");
  await expect(page.getByRole("textbox", { name: "指示", exact: true })).toBeFocused();
  await page.keyboard.type("書きかけの文");
  await capture(page, "書きかけを書いた入力欄");
  await page.keyboard.press("ArrowUp");
  await expect(
    page.getByRole("textbox", { name: "預けた指示を直す (2 / 2 件目)", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await page.keyboard.press("c");
  await page.keyboard.press("c");
  await page.keyboard.type("件数と所要時間を教えて");
  await capture(page, "呼び出した 2 件目の指示を直した入力欄");
  await page.keyboard.press("Control+Enter");

  await expect(view.getByText("預けた指示を 2 件受け取りました。", { exact: true })).toBeVisible();
  await capture(page, "直した指示が届き AI が応答した会話");
  await page.keyboard.press("i");
  await expect(page.getByRole("textbox", { name: "指示", exact: true })).toHaveText("書きかけの文");
  await capture(page, "書きかけが残っている入力欄");
});
