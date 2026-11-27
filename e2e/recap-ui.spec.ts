import { expect, test } from "@playwright/test";
import { capture } from "./evidence";

test.use({ viewport: { width: Number(process.env.UI_VIEWPORT_WIDTH ?? 1440), height: 900 } });
test("API fixtureを使うUIブラウザ確認: 未読から目次を編集し、検索と表示の履歴を使う", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(message.text());
  });
  const state = { reflectedSeq: 4, failedAt: null, updating: false };
  let readSeq = 2;
  const toc = {
    chapters: [
      {
        position: 1,
        title: "APIの整理",
        startSeq: 1,
        endSeq: 2,
        decisions: [{ id: "D1", text: "既存のAPIを使う" }],
      },
      { position: 2, title: "在庫の引き当て", startSeq: 3, endSeq: null, decisions: [] },
    ],
    state,
  };
  const decisions = {
    path: "docs/decisions/recap-ui.md",
    exists: true,
    hash: "h",
    state,
    items: [
      {
        id: "D1",
        kind: "decision",
        text: "既存のAPIを使う",
        reason: null,
        seq: 2,
        changedTo: null,
      },
      {
        id: "D2",
        kind: "rejected",
        text: "別の認証を作る",
        reason: "既存のセッションを使うため",
        seq: 2,
        changedTo: null,
      },
      {
        id: "D3",
        kind: "pending",
        text: "期限を設定で変えるか",
        reason: null,
        seq: 4,
        changedTo: null,
      },
    ],
  };
  const events = [
    {
      seq: 1,
      createdAt: 1,
      type: "user_message",
      payload: { text: "予約APIの機能を整理してください。", images: [], origin: "developer" },
    },
    {
      seq: 2,
      createdAt: 2,
      type: "assistant_text",
      payload: {
        text: "検索・作成・取り消しの3つの機能に分けます。\n既存のAPIとセッションを使います。",
        parent_tool_use_id: null,
      },
    },
    {
      seq: 3,
      createdAt: 3,
      type: "user_message",
      payload: { text: "在庫の引き当ても同じAPIでやりたい。", images: [], origin: "developer" },
    },
    {
      seq: 4,
      createdAt: 4,
      type: "assistant_text",
      payload: {
        text: "在庫の引き当てを同じAPIへ追加します。\n期限切れの引き当てを戻す方法はどちらにしますか?\n期限を設定で変えられるようにしますか?",
        parent_tool_use_id: null,
      },
    },
  ];
  await page.routeWebSocket("**/ws", () => {});
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/me" || path === "/api/health") return route.continue();
    if (path === "/api/keymap") return route.fulfill({ json: { version: 1, entries: [] } });
    if (path.endsWith("/read")) {
      readSeq = Math.max(readSeq, request.postDataJSON().readSeq ?? 0);
      return route.fulfill({ status: 204 });
    }
    if (path.endsWith("/events"))
      return route.fulfill({ json: { events, lastSeq: 4, hasMore: false } });
    if (path.endsWith("/recap"))
      return route.fulfill({
        json: {
          lastUserMessage: { seq: 3, text: "在庫の引き当ても同じAPIでやりたい。" },
          questions: [
            {
              id: "q1",
              seq: 4,
              kind: "text",
              text: "期限切れの引き当てを戻す方法はどちらにしますか?",
            },
            { id: "q2", seq: 4, kind: "text", text: "期限を設定で変えられるようにしますか?" },
          ],
          pendingPermission: null,
          draft: { exists: true },
          counts: { stock: 2, threads: 1, activeThreads: 1, queue: 0 },
          lastReadSeq: readSeq,
          lastPosition: 1,
          state,
        },
      });
    if (path.endsWith("/toc")) return route.fulfill({ json: toc });
    if (path.endsWith("/toc/2")) {
      toc.chapters[1].title = request.postDataJSON().title;
      return route.fulfill({ json: toc });
    }
    if (path.endsWith("/decisions")) return route.fulfill({ json: decisions });
    return route.fulfill({
      json: {
        conversation: {
          id: "recap-ui",
          projectId: "p",
          projectName: "shop-api",
          kind: "chat",
          issueId: null,
          parentConversationId: null,
          title: "予約APIの壁打ち",
          cwd: "/fixture/shop-api",
          worktree: null,
          runState: "idle",
          stopReason: null,
          resetsAt: null,
          lastSeq: 4,
          lastReadSeq: readSeq,
          lastPosition: 1,
          closedAt: null,
        },
        draft: null,
        queue: [],
        pendingAnswers: null,
        pendingPermission: null,
        commands: [],
      },
    });
  });
  await page.goto("/conversations/recap-ui?tail=1");
  await expect(page.getByRole("region", { name: "直近" })).toBeVisible();
  await expect
    .poll(async () => {
      const region = page.getByRole("region", { name: "会話: 予約APIの壁打ち" });
      const cursor = await region.locator(".cm-activeLine").boundingBox();
      const window = await region.locator(".cm-scroller").boundingBox();
      const marker = await region.getByText("ここから未読", { exact: true }).boundingBox();
      if (!cursor || !window || !marker) return false;
      return (
        marker.y >= window.y - 1 &&
        marker.y + marker.height <= cursor.y + 1 &&
        cursor.y - window.y <= marker.height + 6 &&
        cursor.y + cursor.height <= window.y + window.height
      );
    })
    .toBe(true);
  await capture(page, "未読の先頭と直近の質問を表示");
  await page.reload();
  await expect(page.getByRole("region", { name: "直近" })).toBeVisible();
  const main = page.getByRole("region", { name: "会話: 予約APIの壁打ち" }).getByLabel("バッファ");
  await main.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("m");
  await expect(page.getByRole("region", { name: "目次" })).toBeVisible();
  await capture(page, "目次に章と決まったことを表示");
  const tocBuffer = page.getByRole("region", { name: "目次" }).getByLabel("バッファ");
  await tocBuffer.focus();
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await page.keyboard.press("c");
  await page.keyboard.press("c");
  const prompt = page.getByRole("textbox", { name: "章の名前" });
  await expect(prompt).toBeVisible();
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("在庫の引き当てと期限");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(prompt).toHaveCount(0);
  await capture(page, "章の名前を保存した目次");
  await tocBuffer.focus();
  await page.keyboard.press("/");
  const search = page.getByRole("textbox", { name: "検索" });
  await search.fill("API");
  await search.press("Enter");
  await expect(page.getByRole("region", { name: "検索結果" })).toBeVisible();
  await capture(page, "章と決まったことと本文を検索");
  await page.getByRole("region", { name: "検索結果" }).getByLabel("バッファ").focus();
  await page.keyboard.press("Control+h");
  await expect(page.getByRole("region", { name: "目次" })).toBeVisible();
  await page.keyboard.press("Space");
  await page.keyboard.press("d");
  await expect(page.getByRole("region", { name: "決まったこと" })).toBeVisible();
  await capture(page, "決定と採らなかった案と保留を表示");
  expect(errors).toEqual([]);
});
