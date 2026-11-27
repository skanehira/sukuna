import { expect, test as base } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { capture } from "./evidence";

const test = base.extend<{ noticeProject: { name: string; marker: string } }>({
  noticeProject: async ({ request }, use) => {
    const seed = await request.get("/api/projects/e2e-shop-api");
    await expect(seed).toBeOK();
    const fixture = realpathSync(((await seed.json()) as { path: string }).path);
    expect(fixture.startsWith(realpathSync(tmpdir()) + sep)).toBe(true);
    expect(basename(fixture)).toBe("shop-api");

    const cwd = mkdtempSync(join(fixture, "notice-"));
    const name = basename(cwd);
    let projectId: string | undefined;
    try {
      execFileSync("git", ["init", "-q", "-b", "main", cwd]);
      const response = await request.post("/api/projects", { data: { path: cwd, name } });
      await expect(response).toBeOK();
      projectId = ((await response.json()) as { project: { id: string } }).project.id;
      await use({ name, marker: join(cwd, ".e2e-notice-ready") });
    } finally {
      try {
        if (projectId) await expect(await request.delete("/api/projects/" + projectId)).toBeOK();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  },
});

test.use({ viewport: { width: Number(process.env.UI_VIEWPORT_WIDTH ?? 1440), height: 900 } });

test("別の画面で待っている会話のお知らせを受け、開くと未読が減る", async ({
  page,
  context,
  noticeProject,
}) => {
  const prompt = "予約 API の通知を確認 " + noticeProject.name;
  const title = "会話: " + prompt;
  const loaded = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/inbox" && response.ok(),
  );
  await page.goto("/");
  const existing = (await (await loaded).json()) as {
    sections: { name: string; rows: { unread: boolean }[] }[];
  };
  const before = existing.sections
    .filter(({ name }) => name === "decision" || name === "instruction")
    .flatMap(({ rows }) => rows)
    .filter(({ unread }) => unread).length;

  const author = await context.newPage();
  let shown: string[] | undefined;
  author.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname !== "/ws") return;
    socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as { op: string; topics?: string[] };
      if (frame.op === "shown") shown = frame.topics;
    });
  });
  await author.goto("/");
  await expect(
    author
      .getByRole("region", { name: "一覧", exact: true })
      .getByRole("textbox", { name: "バッファ" }),
  ).toBeFocused();
  await author.keyboard.press("Space");
  await author.keyboard.press("n");
  await author
    .getByRole("region", { name: "会話を始める・切り替える" })
    .getByText(noticeProject.name + " で会話を始める", { exact: true })
    .click();
  await author.keyboard.press("Enter");

  await expect(author).toHaveURL(/\/conversations\/[^/?]+$/);
  const conversationUrl = new URL(author.url());
  const id = conversationUrl.pathname.split("/").at(-1)!;
  await expect.poll(() => shown).toEqual(["conversation:" + id]);
  await author.keyboard.press("i");
  await expect(author.getByRole("textbox", { name: "指示", exact: true })).toBeFocused();
  await author.keyboard.type(prompt);
  await author.keyboard.press("Escape");
  const submitted = author.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api" + conversationUrl.pathname + "/messages" &&
      response.ok(),
  );
  await author.keyboard.press("Enter");
  await submitted;
  await expect(
    author.getByRole("region", { name: /^会話: / }).getByRole("textbox", { name: "バッファ" }),
  ).toBeFocused();

  await author.keyboard.press("-");
  await expect(author).toHaveURL(/\/$/);
  await expect.poll(() => shown).toEqual([]);
  await page.bringToFront();
  writeFileSync(noticeProject.marker, "");

  await expect(page.getByRole("status", { name: "お知らせ", exact: true })).toBeVisible();
  await expect(page).toHaveTitle("(" + (before + 1) + ") sukuna");
  await capture(page, "別の画面に判断待ちのお知らせが出た状態");

  await page.keyboard.press("Space");
  await page.keyboard.press("n");
  await page
    .getByRole("region", { name: "会話を始める・切り替える" })
    .getByText(title, { exact: true })
    .click();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(conversationUrl.href);
  await expect(page.getByRole("region", { name: title, exact: true })).toBeVisible();
  await expect(page).toHaveTitle(before === 0 ? "sukuna" : "(" + before + ") sukuna");
  await capture(page, "判断待ちの会話を開いた状態");
});
