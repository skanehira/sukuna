import { expect, test, type WebSocketRoute } from "@playwright/test";
import Database from "better-sqlite3";
import { join } from "node:path";
import type { Snapshot, Draft, DraftRequest } from "../src/front/lib/conversation/types";
import { databasePath } from "./database-path";

test.use({ viewport: { width: 1440, height: 900 } });
const project = "history-e2e-project";
const otherProject = "history-e2e-other-project";
const first = "history-e2e-first";
const target = "history-e2e-target";
test.beforeAll(() => {
  const home = process.env.SUKUNA_E2E_HOME!;
  const db = new Database(databasePath(home));
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO projects(id,name,path,default_branch) VALUES (?,?,?,?)").run(
    project,
    "a-history-shop",
    join(home, "history-shop"),
    "main",
  );
  db.prepare("INSERT INTO projects(id,name,path,default_branch) VALUES (?,?,?,?)").run(
    otherProject,
    "z-history-docs",
    join(home, "history-docs"),
    "main",
  );
  for (const [id, title] of [
    [first, "元の会話"],
    [target, "履歴の会話"],
  ]) {
    db.prepare(
      "INSERT INTO conversations(id,project_id,kind,cwd,title,run_state,last_seq,recap_seq,last_activity_at) VALUES (?,?,'chat',?,?,'idle',1,1,?)",
    ).run(id, project, home, title, Date.now());
    db.prepare(
      "INSERT INTO conversation_events(conversation_id,seq,type,payload,created_at) VALUES (?,1,'assistant_text',?,?)",
    ).run(
      id,
      JSON.stringify({ text: "開始\n途中\n作業末尾", parent_tool_use_id: null }),
      Date.now(),
    );
  }
  db.close();
});
test.afterAll(() => {
  const db = new Database(databasePath(process.env.SUKUNA_E2E_HOME!));
  db.pragma("foreign_keys = ON");
  db.prepare("DELETE FROM conversations WHERE project_id = ?").run(project);
  db.prepare("DELETE FROM projects WHERE id IN (?,?)").run(project, otherProject);
  db.close();
});
const cases = [
  { side: "tree", scenario: "delayed" },
  { side: "right", scenario: "delayed" },
  { side: "tree", scenario: "loaded" },
  { side: "right", scenario: "loaded" },
  { side: "tree", scenario: "discarded" },
  { side: "right", scenario: "discarded" },
  { side: "tree", scenario: "failed" },
  { side: "right", scenario: "failed" },
  { side: "tree", scenario: "prompt" },
  { side: "right", scenario: "prompt" },
  { side: "tree", scenario: "main" },
  { side: "right", scenario: "main" },
  { side: "tree", scenario: "command" },
  { side: "right", scenario: "command" },
  { side: "tree", scenario: "default" },
  { side: "right", scenario: "default" },
  { side: "right", scenario: "search" },
] as const;
for (const { side, scenario } of cases) {
  test(`本物の一覧APIと会話fixture: ${side}の再表示とCtrl+o (${scenario})`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (!["error", "warning"].includes(message.type())) return;
      if (
        scenario === "failed" &&
        message.text() ===
          "Failed to load resource: the server responded with a status of 503 (Service Unavailable)"
      )
        return;
      errors.push(message.text());
    });
    let socket: WebSocketRoute | undefined;
    let reconnected = () => {};
    await page.routeWebSocket("**/ws", (ws) => {
      socket = ws;
      reconnected();
    });
    const drafts = new Map<string, Draft>();
    await page.route("**/api/conversations/**", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === "PUT" && url.pathname.endsWith("/draft")) {
        const body: DraftRequest = route.request().postDataJSON();
        const draft = {
          text: body.text,
          images: body.images,
          updatedAt: body.editedAt,
          updatedBy: body.clientId,
        };
        drafts.set(url.pathname.split("/")[3], draft);
        return route.fulfill({ json: { draft, applied: true } });
      }
      const match = url.pathname.match(
        /^\/api\/conversations\/(history-e2e-first|history-e2e-target)(\/events)?$/,
      );
      if (!match) return route.continue();
      if (match[2])
        return route.fulfill({
          json: {
            events:
              Number(url.searchParams.get("after")) === 0
                ? [
                    {
                      seq: 1,
                      createdAt: 1,
                      type: "assistant_text",
                      payload: { text: "開始\n途中\n作業末尾", parent_tool_use_id: null },
                    },
                  ]
                : [],
            lastSeq: 1,
            hasMore: false,
          },
        });
      const snapshot: Snapshot = {
        conversation: {
          id: match[1],
          projectId: project,
          projectName: "a-history-shop",
          title: match[1] === first ? "元の会話" : "履歴の会話",
          kind: "chat",
          issueId: null,
          parentConversationId: null,
          cwd: "/fixture/history-shop",
          worktree: null,
          runState: match[1] === first ? "working" : "idle",
          stopReason: null,
          resetsAt: null,
          lastSeq: 1,
          lastReadSeq: 0,
          lastPosition: null,
          closedAt: null,
        },
        draft: drafts.get(match[1]) ?? null,
        queue: [],
        pendingAnswers: null,
        pendingPermission: null,
        commands: [],
      };
      return route.fulfill({ json: snapshot });
    });
    const newer =
      scenario === "prompt" ||
      scenario === "main" ||
      scenario === "command" ||
      scenario === "search";
    const origin = side === "tree" && !newer ? "/" : `/conversations/${first}?tail=1`;
    const destination = side === "tree" ? `/projects/${otherProject}` : `/conversations/${target}`;
    const label = side === "tree" ? "z-history-docs" : "会話: 履歴の会話";
    const region = page.getByRole("region", {
      name: side === "tree" ? "sukuna" : "会話を始める・切り替える",
      exact: true,
    });
    const choose = async (value: string) => {
      await region.locator(".cm-line").getByText(value, { exact: true }).click();
      await expect(
        region.locator(".cm-activeLine").getByText(value, { exact: true }),
      ).toBeVisible();
    };
    await page.goto(origin);
    if (side === "right") {
      await page
        .getByRole("region", { name: "会話: 元の会話", exact: true })
        .locator(".cm-content")
        .focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("n");
    }
    await choose(label);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(destination);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested = () => {};
    const request = new Promise<void>((resolve) => {
      requested = resolve;
    });
    let recovered = scenario !== "failed";
    await page.route("**/api/projects", async (route) => {
      requested();
      await gate;
      if (!recovered)
        return route.fulfill({
          status: 503,
          json: { error: { code: "network_error", message: "一覧の通信に失敗しました" } },
        });
      return route.continue();
    });
    try {
      if (scenario === "loaded") release();
      await page.reload({ waitUntil: "domcontentloaded" });
      await request;
      if (scenario === "loaded")
        await expect(region.locator(".cm-line").getByText(label, { exact: true })).toBeVisible();
      else
        await expect(
          region
            .locator(".cm-line")
            .getByText(side === "tree" ? "設定" : "読み込み中", { exact: true }),
        ).toBeVisible();
      await region.locator(".cm-content").focus();
      if (scenario === "main" || scenario === "default" || scenario === "search") {
        await page.keyboard.press("Control+w");
        await page.keyboard.press(side === "tree" ? "l" : "h");
      }
      await page.keyboard.press("Control+o");
      await expect(page).toHaveURL(origin);
      if (newer) {
        const main = page.getByRole("region", { name: "会話: 元の会話", exact: true });
        if (scenario === "search") {
          await expect(main.locator(".cm-content")).toBeFocused();
          await page.keyboard.press("/");
          await expect(main.locator(".cm-vim-panel input")).toBeFocused();
          await page.keyboard.press("a");
        } else await main.locator(".cm-activeLine").getByText("作業末尾", { exact: true }).click();
        if (scenario === "prompt") {
          await page.keyboard.press("i");
          await expect(page.getByRole("textbox", { name: "指示", exact: true })).toBeFocused();
          await page.keyboard.press("a");
        } else if (scenario === "command") {
          await page.keyboard.press("Shift+:");
          await expect(page.getByRole("textbox", { name: "コマンド", exact: true })).toBeFocused();
          await page.keyboard.press("h");
        }
      }
      if (scenario === "discarded") {
        if (side === "tree") {
          await choose("一覧");
          await page.keyboard.press("Enter");
          await page.keyboard.press("Control+w");
          await page.keyboard.press("l");
        } else await page.keyboard.press("q");
      }
      release();
      if (scenario === "failed") {
        await expect(
          region.getByText(
            side === "tree" ? "一覧の通信に失敗しました" : "会話の一覧を取得できませんでした",
            { exact: true },
          ),
        ).toBeVisible();
        recovered = true;
        const connected = new Promise<void>((resolve) => {
          reconnected = resolve;
        });
        await socket!.close();
        await connected;
        await page.evaluate("window.dispatchEvent(new Event('online'))");
      }
      if ((side === "right" || newer) && scenario !== "search")
        await expect(
          page
            .getByRole("region", { name: "会話: 元の会話", exact: true })
            .locator(".cm-activeLine")
            .getByText("作業末尾", { exact: true }),
        ).toBeVisible();
      if (newer) {
        await expect(
          region.locator(".cm-activeLine").getByText(label, { exact: true }),
        ).toBeVisible();
        if (scenario === "prompt") {
          const input = page.getByRole("textbox", { name: "指示", exact: true });
          await expect(input).toBeFocused();
          await page.keyboard.press("e");
          await expect(input).toHaveText("ae");
        } else if (scenario === "command") {
          const input = page.getByRole("textbox", { name: "コマンド", exact: true });
          await expect(input).toBeFocused();
          await page.keyboard.press("e");
          await expect(input).toHaveValue("he");
        } else if (scenario === "search") {
          const input = page
            .getByRole("region", { name: "会話: 元の会話", exact: true })
            .locator(".cm-vim-panel input");
          await expect(input).toBeFocused();
          await page.keyboard.press("e");
          await expect(input).toHaveValue("ae");
        } else
          await expect(
            page
              .getByRole("region", { name: "会話: 元の会話", exact: true })
              .locator(".cm-content"),
          ).toBeFocused();
      } else if (scenario === "discarded") {
        await expect(
          page
            .getByRole("region", { name: side === "tree" ? "一覧" : "会話: 元の会話", exact: true })
            .locator(".cm-content"),
        ).toBeFocused();
        await expect(
          page
            .getByRole("region", { name: "sukuna", exact: true })
            .locator(".cm-line")
            .getByText("z-history-docs", { exact: true }),
        ).toBeVisible();
        if (side === "tree")
          await expect(
            region.locator(".cm-activeLine").getByText("一覧", { exact: true }),
          ).toBeVisible();
        else await expect(region).toHaveCount(0);
      } else {
        await expect(
          region.locator(".cm-activeLine").getByText(label, { exact: true }),
        ).toBeVisible();
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(destination);
      }
      expect(errors).toEqual([]);
    } finally {
      release();
    }
  });
}
