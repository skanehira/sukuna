import { expect, test } from "@playwright/test";
import type { Snapshot } from "../src/front/lib/conversation/types";
import type { ClosingSummary } from "../src/front/lib/lifecycle/api";
import { capture } from "./evidence";

test.use({ viewport: { width: Number(process.env.UI_VIEWPORT_WIDTH ?? 1440), height: 900 } });

test("締めくくりをやめて指示を書き、一覧と検索からスレッドの記録を開く", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(message.text());
  });
  const mainTitle = "会話: 予約 API の壁打ち";
  const threadTitle = "在庫が足りないときの応答は?";
  const project = "shop-api";
  let recapRequests = 0;
  const snapshot: Snapshot = {
    conversation: {
      id: "c1",
      projectId: "p1",
      projectName: project,
      kind: "chat",
      issueId: null,
      parentConversationId: null,
      title: "予約 API の壁打ち",
      cwd: "/fixture/shop-api",
      worktree: null,
      runState: "idle",
      stopReason: null,
      resetsAt: null,
      lastSeq: 1,
      lastReadSeq: 0,
      lastPosition: null,
      closedAt: null,
    },
    draft: null,
    queue: [],
    pendingAnswers: null,
    pendingPermission: null,
    commands: [],
  };
  const now = Date.now();
  const thread = {
    id: "t1",
    title: threadTitle,
    runState: "idle",
    closedAt: now - 90_000,
    lastActivityAt: now - 90_000,
  };
  const chat = {
    id: "c1",
    title: snapshot.conversation.title,
    runState: "idle",
    closedAt: null,
    lastActivityAt: now - 30_000,
  };
  const summary: ClosingSummary = {
    working: false,
    git: true,
    outputs: {
      issues: {
        ok: true,
        items: [{ id: "i1", number: 42, title: "在庫の引き当てを追加する", state: "triage" }],
      },
      files: { ok: true, items: ["src/order/stock.ts"] },
      commits: {
        ok: true,
        items: [{ hash: "3f2a9c1", subject: "引き当ての入力を検査する" }],
        more: 0,
      },
      prs: { ok: true, items: [] },
    },
    remaining: {
      uncommitted: { ok: true, items: ["docs/design/reserve.md"], more: 0 },
      unpushed: { ok: true, count: 1, upstream: false },
      stock: { questions: 0, instructions: 1 },
      runningThreads: [],
    },
  };
  await page.routeWebSocket("**/ws", () => {});
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (
      path === "/api/me" ||
      path === "/api/health" ||
      path === "/api/settings" ||
      path === "/api/inbox"
    )
      return route.continue();
    if (path === "/api/projects")
      return route.fulfill({
        json: {
          projects: [{ id: "p1", name: project, flowPaused: false, conversations: [], issues: [] }],
        },
      });
    if (path === "/api/projects/p1/conversations")
      return route.fulfill({
        json: {
          conversations: [
            { ...chat, threads: [thread] },
            {
              ...chat,
              id: "closed",
              title: "決済フローの相談",
              closedAt: now - 180_000,
              lastActivityAt: now - 180_000,
              threads: [],
            },
          ],
          issueThreads: [],
        },
      });
    if (path === "/api/conversations/c1/closing-summary") return route.fulfill({ json: summary });
    if (path === "/api/conversations/c1/read") return route.fulfill({ status: 204 });
    if (path === "/api/conversations/c1/recap") {
      recapRequests++;
      return route.fulfill({
        json: {
          lastUserMessage: null,
          questions: [],
          pendingPermission: null,
          draft: { exists: false },
          counts: { stock: 1, threads: 1, activeThreads: 0, queue: 0 },
          lastReadSeq: 0,
          lastPosition: null,
          state: { reflectedSeq: 1, failedAt: null, updating: false },
        },
      });
    }
    if (path === "/api/conversations/c1") return route.fulfill({ json: snapshot });
    if (path === "/api/conversations/t1")
      return route.fulfill({
        json: {
          ...snapshot,
          conversation: {
            ...snapshot.conversation,
            ...thread,
            kind: "thread",
            parentConversationId: "c1",
          },
        },
      });
    if (path.endsWith("/events")) {
      const text = path.includes("/t1/")
        ? "在庫不足のときは確保せず、品切れを返します。"
        : "予約 API の設計を整理しました。";
      return route.fulfill({
        json: {
          events: [
            {
              seq: 1,
              createdAt: now - 30_000,
              type: "assistant_text",
              payload: { text, parent_tool_use_id: null },
            },
          ],
          lastSeq: 1,
          hasMore: false,
        },
      });
    }
    if (path.endsWith("/draft")) return route.fulfill({ json: { draft: null, applied: true } });
    if (path === "/api/search" && url.searchParams.get("q") === "在庫")
      return route.fulfill({
        json: {
          results: [
            { ...thread, type: "conversation", kind: "thread", projectId: "p1", parentId: "c1" },
            {
              type: "issue",
              id: "i1",
              projectId: "p1",
              number: 42,
              title: "在庫の引き当てを追加する",
              state: "triage",
              lastActivityAt: now - 160_000,
            },
          ],
          truncated: false,
        },
      });
    return route.fulfill({
      status: 404,
      json: { error: { code: "not_found", message: "fixture 対象外" } },
    });
  });

  await page.goto("/conversations/c1");
  const conversation = page.getByRole("region", { name: mainTitle, exact: true });
  await expect(conversation.getByText("予約 API の設計を整理しました。")).toBeVisible();
  const recent = page.getByRole("region", { name: "直近", exact: true });
  await expect(recent).toBeVisible();
  await conversation.locator(".cm-content").focus();
  await capture(page, "会話の表示（API fixture）");
  await page.keyboard.press("Space");
  await page.keyboard.press("z");
  const closing = page.getByRole("region", { name: "会話を締めくくる", exact: true });
  await expect(closing.getByText("やめて会話に戻る")).toBeVisible();
  await capture(page, "成果、残っているものと締めくくりの選択");
  await page.keyboard.press("2");
  await page.keyboard.press("Enter");
  await expect(closing).toHaveCount(0);
  await page.keyboard.press("i");
  const prompt = page.getByRole("textbox", { name: "指示", exact: true });
  await expect(prompt).toBeVisible();
  await capture(page, "閉じずに会話へ戻り、指示の入力欄を開いた状態");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(prompt).toHaveCount(0);
  await page.keyboard.press("Space");
  await page.keyboard.press("b");
  const list = page.getByRole("region", { name: "会話とスレッドの一覧", exact: true });
  await expect(list.getByText("決済フローの相談", { exact: false })).toBeVisible();
  await capture(page, "閉じた会話とスレッドが並ぶ一覧");
  await page.keyboard.press("Space");
  await page.keyboard.press("f");
  const command = page.getByRole("textbox", { name: "コマンド", exact: true });
  await command.fill("find 在庫");
  await command.press("Enter");
  const results = page.getByRole("region", { name: "issue と会話を検索", exact: true });
  await expect(results.getByText(threadTitle, { exact: false })).toBeVisible();
  await capture(page, "スレッドと issue が並ぶ検索結果");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/conversations/c1?thread=t1");
  const threadRegion = page.getByRole("region", { name: "スレッド: " + threadTitle });
  await expect(
    threadRegion.getByText("在庫不足のときは確保せず、品切れを返します。"),
  ).toBeVisible();
  const requestsBeforeReload = recapRequests;
  await page.reload();
  await expect(conversation.getByText("ここから未読", { exact: true })).toBeVisible();
  await expect(
    threadRegion.getByText("在庫不足のときは確保せず、品切れを返します。"),
  ).toBeVisible();
  await expect(recent).toHaveCount(0);
  expect(recapRequests).toBe(requestsBeforeReload);
  await capture(page, "元の会話と、右に表示したスレッドの記録");
  expect(errors).toEqual([]);
});
