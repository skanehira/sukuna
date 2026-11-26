import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { healthResponseSchema } from "../shared/api";
import { createApp } from "./app";

describe("createApp", () => {
  it("GET /api/health は 200 と status ok を返す", async () => {
    const response = await createApp().request("/api/health");

    expect(response.status).toBe(200);
    expect(healthResponseSchema.parse(await response.json())).toEqual({ status: "ok" });
  });

  it("clientDir を渡すと SPA を配信する", async () => {
    const clientDir = mkdtempSync(join(tmpdir(), "sukuna-client-"));
    const html = "<!doctype html><title>sukuna</title>";
    writeFileSync(join(clientDir, "index.html"), html);

    try {
      const response = await createApp({ clientDir }).request("/");

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(html);
    } finally {
      rmSync(clientDir, { recursive: true, force: true });
    }
  });

  it("clientDir を渡すと、静的ファイルに無い画面の URL でも index.html を返す", async () => {
    const clientDir = mkdtempSync(join(tmpdir(), "sukuna-client-"));
    const html = "<!doctype html><title>sukuna</title>";
    writeFileSync(join(clientDir, "index.html"), html);

    try {
      const response = await createApp({ clientDir }).request("/conversations/abc");

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(html);
    } finally {
      rmSync(clientDir, { recursive: true, force: true });
    }
  });

  it("clientDir を渡しても、未知の /api のパスは 404 を返す", async () => {
    const clientDir = mkdtempSync(join(tmpdir(), "sukuna-client-"));
    writeFileSync(join(clientDir, "index.html"), "<!doctype html><title>sukuna</title>");

    try {
      const response = await createApp({ clientDir }).request("/api/unknown");

      expect(response.status).toBe(404);
    } finally {
      rmSync(clientDir, { recursive: true, force: true });
    }
  });
});
