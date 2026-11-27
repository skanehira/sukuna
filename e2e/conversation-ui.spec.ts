import { expect, test, type WebSocketRoute } from "@playwright/test";
import type { Event, Snapshot } from "../src/front/lib/conversation/types";
import { capture } from "./evidence";

test.use({ viewport: { width: Number(process.env.UI_VIEWPORT_WIDTH ?? 1440), height: 900 } });

test("API fixtureを使うUIブラウザ確認: キーだけで会話を始め、指示を送り、2問に答える", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(message.text());
  });
  const snapshot: Snapshot = {
    conversation: {
      id: "ui-conversation",
      projectId: "ui-project",
      projectName: "shop-api",
      kind: "chat",
      issueId: null,
      parentConversationId: null,
      title: "新しい会話",
      cwd: "/fixture/shop-api",
      worktree: null,
      runState: "idle",
      stopReason: null,
      resetsAt: null,
      lastSeq: 0,
      lastReadSeq: 0,
      lastPosition: null,
      closedAt: null,
    },
    draft: null,
    queue: [],
    pendingAnswers: null,
    pendingPermission: null,
    commands: [{ name: "/dev-spec", description: "設計を進める" }],
  };
  const events: Event[] = [];
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket("**/ws", (ws) => {
    socket = ws;
  });
  const publish = (event: Event) => {
    events.push(event);
    snapshot.conversation.lastSeq = event.seq;
    socket?.send(
      JSON.stringify({
        topic: "conversation:ui-conversation",
        seq: event.seq,
        type: "event",
        payload: {
          ...event,
          conversation_id: "ui-conversation",
          sdk_uuid: null,
          created_at: event.createdAt,
        },
      }),
    );
  };
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/me" || path === "/api/health" || path === "/api/settings")
        return route.continue();
      if (path === "/api/inbox")
        return route.fulfill({
          json: {
            sections: [
              { name: "decision", rows: [] },
              { name: "instruction", rows: [] },
              { name: "working", rows: [] },
            ],
          },
        });
      if (path === "/api/projects")
        return route.fulfill({
          json: {
            projects: [
              {
                id: "ui-project",
                name: "shop-api",
                flowPaused: false,
                conversations: [],
                issues: [],
              },
            ],
          },
        });
      if (path === "/api/conversations")
        return route.fulfill({ status: 201, json: { conversation: snapshot.conversation } });
      if (path.endsWith("/events"))
        return route.fulfill({
          json: {
            events: events.filter(
              (event) => event.seq > Number(new URL(request.url()).searchParams.get("after") ?? 0),
            ),
            lastSeq: snapshot.conversation.lastSeq,
            hasMore: false,
          },
        });
      if (path.endsWith("/messages")) {
        const body = request.postDataJSON();
        snapshot.draft = null;
        snapshot.conversation.runState = "waiting_answer";
        await route.fulfill({ status: 202, json: { result: "delivered", queueItem: null } });
        publish({
          seq: 1,
          createdAt: 1,
          type: "user_message",
          payload: { text: body.text, images: [], origin: "developer" },
        });
        publish({
          seq: 2,
          createdAt: 2,
          type: "assistant_text",
          payload: { text: "確認したいことが2点あります。", parent_tool_use_id: null },
        });
        publish({
          seq: 3,
          createdAt: 3,
          type: "question",
          payload: {
            request_id: "ui-question",
            questions: [
              {
                question: "在庫を戻す方法は?",
                header: "方法",
                multi_select: false,
                options: [
                  { label: "定期処理", description: "1分ごと" },
                  { label: "次の処理", description: "必要なとき" },
                ],
              },
              {
                question: "設定で変えられるようにする?",
                header: "設定",
                multi_select: false,
                options: [{ label: "はい", description: "設定で変える" }],
              },
            ],
          },
        });
        return;
      }
      if (path.endsWith("/answers/send")) {
        const answers = snapshot.pendingAnswers!.answers;
        snapshot.pendingAnswers = null;
        snapshot.conversation.runState = "idle";
        await route.fulfill({ status: 202, json: { result: "answered" } });
        publish({
          seq: 4,
          createdAt: 4,
          type: "answer",
          payload: { request_id: "ui-question", answers, as_message: false },
        });
        publish({
          seq: 5,
          createdAt: 5,
          type: "assistant_text",
          payload: { text: "選んだ方針で設計を進めます。", parent_tool_use_id: null },
        });
        return;
      }
      if (path.endsWith("/answers")) {
        snapshot.pendingAnswers = request.postDataJSON();
        return route.fulfill({ json: { pendingAnswers: snapshot.pendingAnswers } });
      }
      if (path.endsWith("/draft")) {
        const body = request.postDataJSON();
        snapshot.draft =
          body.text || body.images.length
            ? {
                text: body.text,
                images: body.images,
                updatedAt: body.editedAt,
                updatedBy: body.clientId,
              }
            : null;
        return route.fulfill({ json: { draft: snapshot.draft, applied: true } });
      }
      if (path === "/api/conversations/ui-conversation") return route.fulfill({ json: snapshot });
      return route.fulfill({
        status: 404,
        json: { error: { code: "not_found", message: "fixture対象外です" } },
      });
    },
  );
  await page.goto("/");
  await page.getByRole("region", { name: "一覧", exact: true }).locator(".cm-content").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("n");
  const switcher = page.getByRole("region", { name: "会話を始める・切り替える" });
  await expect(switcher.locator(".cm-menu")).toHaveCount(1);
  await capture(page, "会話を始めるメニュー (API fixture)");
  await page.keyboard.press("1");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/conversations/ui-conversation");
  const main = page.getByRole("region", { name: "会話: 新しい会話", exact: true });
  await expect(main.locator(".cm-kind-note")).toBeVisible();
  await capture(page, "会話の初期表示 (API fixture)");
  await page.keyboard.press("i");
  const prompt = page.getByRole("textbox", { name: "指示", exact: true });
  await expect(prompt).toBeVisible();
  await page.keyboard.type("/dev-spec");
  await capture(page, "指示の入力とスキル候補 (API fixture)");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(main.locator(".cm-kind-ask")).toHaveCount(2);
  await capture(page, "AIの質問が2問並んだ状態 (API fixture)");
  await page.keyboard.press("1");
  await page.keyboard.press("Enter");
  await expect(main.locator(".cm-menu-done")).toHaveCount(1);
  await page.keyboard.press("4");
  await page.keyboard.press("Enter");
  await expect(main.locator(".cm-menu-done")).toHaveCount(2);
  await capture(page, "2問の回答を送る前の状態 (API fixture)");
  await page.keyboard.press("6");
  await page.keyboard.press("Enter");
  await expect(main.locator(".cm-speaker-ai")).toHaveCount(2);
  await expect(main.locator(".cm-menu-main")).toHaveCount(0);
  await capture(page, "回答送信後にAIの続きが表示された状態 (API fixture)");
  expect(errors).toEqual([]);
});
