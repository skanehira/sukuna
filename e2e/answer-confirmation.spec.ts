import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { ConversationEventsPage } from "../src/shared/conversation/api";
import { capture } from "./evidence";

test("別のタブで回答を減らした後は確認し直してから送れる", async ({ page, request }) => {
  const started = await request.post("/api/conversations", {
    data: { projectId: "e2e-shop-api", workspace: { kind: "project" } },
  });
  await expect(started).toBeOK();
  const { conversation } = (await started.json()) as { conversation: { id: string } };
  const { id } = conversation;
  const path = `/api/conversations/${id}`;
  await expect(
    await request.post(`${path}/messages`, {
      data: {
        text: "回答の送信確認を試す",
        images: [],
        mode: "send",
        clientMessageId: randomUUID(),
      },
    }),
  ).toBeOK();

  let questionSeq: number | undefined;
  await expect
    .poll(async () => {
      const { events } = (await (
        await request.get(`${path}/events`)
      ).json()) as ConversationEventsPage;
      questionSeq = events.find((event) => event.type === "question")?.seq;
      return questionSeq;
    })
    .toBeGreaterThan(0);
  const answers = {
    "0": { choices: ["定期処理"], text: null },
    "1": { choices: ["はい"], text: null },
  };
  await expect(await request.put(`${path}/answers`, { data: { questionSeq, answers } })).toBeOK();

  let pauseAnswerNotices = false;
  let answerNoticePaused = false;
  await page.routeWebSocket("**/ws", (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      const notice = JSON.parse(message.toString()) as {
        topic: string;
        type: string;
        payload?: { parts?: string[] };
      };
      if (
        pauseAnswerNotices &&
        notice.topic === `conversation:${id}` &&
        notice.type === "changed" &&
        notice.payload?.parts?.includes("answers")
      ) {
        answerNoticePaused = true;
        return;
      }
      socket.send(message);
    });
  });
  await page.goto(`/conversations/${id}`);
  const pane = page.getByRole("region", { name: /^会話: / });
  const confirmation = page.getByLabel("操作の確認");
  const selected = pane.locator(".cm-menu-done");
  const continuation = pane.getByText("回答を受け取りました。", { exact: true });
  const openConfirmation = async () => {
    await page.keyboard.press("8");
    await page.keyboard.press("Enter");
    await expect(confirmation).toBeVisible();
  };

  const another = await page.context().newPage();
  await another.goto(`/conversations/${id}`);
  const otherSelected = another.getByRole("region", { name: /^会話: / }).locator(".cm-menu-done");
  await expect(otherSelected).toHaveCount(2);
  await page.bringToFront();
  await expect(selected).toHaveCount(2);
  await openConfirmation();
  await capture(page, "2 問に答えた時点の送信確認");

  await another.bringToFront();
  pauseAnswerNotices = true;
  const saved = another.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === `${path}/answers`,
  );
  await another.keyboard.press("4");
  await another.keyboard.press("Enter");
  await saved;
  await expect(otherSelected).toHaveCount(1);
  await expect.poll(() => answerNoticePaused).toBe(true);
  await expect(selected).toHaveCount(2);

  await page.bringToFront();
  await page.keyboard.press("y");

  await expect(selected).toHaveCount(1);
  await expect(pane.locator(".cm-menu-main.cm-menu-name")).toBeVisible();
  await expect(continuation).toHaveCount(0);
  await expect(confirmation).toHaveCount(0);
  await capture(page, "送信を止めて別のタブの編集を読み直した会話");

  pauseAnswerNotices = false;
  await openConfirmation();
  await capture(page, "最新の回答の送信確認");
  await page.keyboard.press("y");
  await expect(continuation).toBeVisible();
  await capture(page, "確認し直した回答が届き AI が続きを返した会話");
});
