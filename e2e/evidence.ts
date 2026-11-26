import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

const evidenceDir = process.env.E2E_EVIDENCE_DIR;
let step = 0;

export async function capture(page: Page, state: string): Promise<void> {
  if (!evidenceDir) return;
  step += 1;
  mkdirSync(evidenceDir, { recursive: true });
  const slug =
    state
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "screen";
  const file = join(evidenceDir, `${String(step).padStart(2, "0")}-${slug}.png`);
  await page.screenshot({ path: file, fullPage: false });
  appendFileSync(
    join(evidenceDir, "screens.ndjson"),
    `${JSON.stringify({ step, state, file, width: page.viewportSize()?.width ?? 0 })}\n`,
  );
}
