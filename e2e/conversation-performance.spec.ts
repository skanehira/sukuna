import { expect, test as base } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { capture } from "./evidence";

const title = "長い会話のキー応答";
const test = base.extend<{ workload: { ids: string[]; counts: () => number[] } }>({
  workload: async ({ request }, use) => {
    const home = process.env.SUKUNA_E2E_HOME;
    if (!home) throw new Error("E2E のデータの置き場所がありません");
    const project = randomUUID();
    const ids = Array.from({ length: 12 }, () => randomUUID());
    const directory = mkdtempSync(join(home, "key-performance-"));
    const db = new Database(join(home, "sukuna.db"), { fileMustExist: true });
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    const count = db
      .prepare(`
      SELECT COUNT(*) FROM conversation_events
      WHERE conversation_id = ? AND type = 'assistant_text'
        AND json_extract(payload, '$.text') LIKE '連続出力 %'
    `)
      .pluck();
    try {
      db.transaction(() => {
        db.prepare(
          "INSERT INTO projects(id,name,path,default_branch,auto_stages) VALUES(?,?,?,'main','[]')",
        ).run(project, "キー応答の測定", directory);
        const add = db.prepare(`
          INSERT INTO conversations
            (id,project_id,kind,cwd,title,last_seq,last_read_seq,recap_seq,last_activity_at)
          VALUES(?,?,'chat',?,?,?,?,?,?)
        `);
        for (const [index, id] of ids.entries()) {
          const seq = index === 0 ? 1 : 0;
          add.run(
            id,
            project,
            directory,
            index === 0 ? title : `負荷 ${index}`,
            seq,
            seq,
            seq,
            Date.now(),
          );
        }
        db.prepare(
          "INSERT INTO conversation_events(conversation_id,seq,type,payload,created_at) VALUES(?,1,'assistant_text',?,?)",
        ).run(
          ids[0],
          JSON.stringify({
            text: Array.from(
              { length: 10_000 },
              (_, index) => "履歴 " + String(index + 1).padStart(5, "0"),
            ).join("\n"),
            parent_tool_use_id: null,
          }),
          Date.now(),
        );
      })();
      await use({ ids, counts: () => ids.map((id) => Number(count.get(id))) });
    } finally {
      try {
        await Promise.all(ids.map((id) => request.post(`/api/conversations/${id}/stop`)));
        db.transaction(() => {
          for (const id of ids) db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
          db.prepare("DELETE FROM projects WHERE id = ?").run(project);
        })();
      } finally {
        db.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  },
});

type MeasuredLine = {
  textContent: string | null;
  getBoundingClientRect(): { top: number; bottom: number; height: number };
};

type MeasureContent = EventTarget & {
  querySelector(selector: string): MeasuredLine | null;
  closest(selector: string): MeasuredLine | null;
};

type MeasuringPage = typeof globalThis & {
  innerHeight: number;
  keyToPaint?: number[];
  requestAnimationFrame(callback: () => void): void;
};

test.use({ viewport: { width: Number(process.env.UI_VIEWPORT_WIDTH ?? 1440), height: 900 } });

test("12会話の出力中に1万行の会話でキーを押すと、次の描画までのp95が100ミリ秒以下になる", async ({
  page,
  request,
  workload,
}) => {
  await page.goto("/conversations/" + workload.ids[0]);
  const pane = page.getByRole("region", { name: "会話: " + title, exact: true });
  const editor = pane.getByRole("textbox", { name: "バッファ", exact: true });
  const cursor = pane.locator(".cm-line.cm-activeLine");
  await expect(editor).toBeFocused();
  await page.keyboard.press("Shift+KeyG");
  await expect(cursor).toHaveText("履歴 10000");
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await expect(cursor).toHaveText("履歴 00001");

  const sent = await Promise.all(
    workload.ids.map((id, index) =>
      request.post(`/api/conversations/${id}/messages`, {
        data: {
          text: `E2E performance ${index}`,
          images: [],
          mode: "send",
          clientMessageId: randomUUID(),
        },
      }),
    ),
  );
  for (const response of sent) await expect(response).toBeOK();
  await expect.poll(() => workload.counts().every((count) => count >= 3)).toBe(true);

  await editor.evaluate((target) => {
    const samples: number[] = [];
    const browser = globalThis as MeasuringPage;
    browser.keyToPaint = samples;
    const content = target as MeasureContent;
    const scroller = content.closest(".cm-scroller");
    if (!scroller) throw new Error("バッファのスクロール領域がありません");
    content.addEventListener(
      "keydown",
      (event) => {
        if (!event.isTrusted || (event as Event & { key: string }).key !== "j") return;
        const start = event.timeStamp;
        const expected = "履歴 " + String(samples.length + 2).padStart(5, "0");
        const isVisible = () => {
          const active = content.querySelector(".cm-line.cm-activeLine");
          if (active?.textContent !== expected) return false;
          const line = active.getBoundingClientRect();
          const clip = scroller.getBoundingClientRect();
          return (
            line.height > 0 &&
            line.bottom > Math.max(0, clip.top) &&
            line.top < Math.min(browser.innerHeight, clip.bottom)
          );
        };
        const checkFrame = () => {
          if (!isVisible()) {
            browser.requestAnimationFrame(checkFrame);
            return;
          }
          browser.requestAnimationFrame(() => {
            if (isVisible()) samples.push(performance.now() - start);
            else checkFrame();
          });
        };
        browser.requestAnimationFrame(checkFrame);
      },
      { capture: true },
    );
  });

  const before = workload.counts();
  for (let index = 1; index <= 50; index++) {
    await page.keyboard.press("j");
    await page.waitForFunction(
      (expected) => (globalThis as MeasuringPage).keyToPaint?.length === expected,
      index,
      { polling: "raf" },
    );
  }
  const after = workload.counts();
  await expect(cursor).toHaveText("履歴 00051");
  const measurements = await page.evaluate(() => (globalThis as MeasuringPage).keyToPaint ?? []);
  const sorted = [...measurements].sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
  console.log(
    JSON.stringify({
      keyToPaintMs: measurements,
      p95Ms: p95,
      eventsDuringKeys: after.map((count, index) => count - before[index]!),
    }),
  );
  expect(measurements).toHaveLength(50);
  expect(after.every((count, index) => count > before[index]!)).toBe(true);
  expect(p95).toBeLessThanOrEqual(100);
  await capture(page, "12会話の出力中に長い会話の51行目へキー操作で移動した画面");
});
