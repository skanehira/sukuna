import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { healthResponseSchema } from "../shared/api";
import { createApp } from "./app";
import { incomingWith } from "./modules/identity/test-support";

function createTestApp(options: { clientDir?: string } = {}) {
  return createApp({
    build: "test-build",
    clientDir: options.clientDir,
  });
}

const localConnection = () => incomingWith("127.0.0.1", 50000);

describe("createApp", () => {
  it("GET /api/health は 200 と status ok を返す", async () => {
    const response = await createTestApp().request("/api/health", undefined, localConnection());

    expect(response.status).toBe(200);
    expect(healthResponseSchema.parse(await response.json())).toEqual({ status: "ok" });
  });

  it("clientDir を渡すと SPA を配信する", async () => {
    const clientDir = mkdtempSync(join(tmpdir(), "sukuna-client-"));
    const html = "<!doctype html><title>sukuna</title>";
    writeFileSync(join(clientDir, "index.html"), html);

    try {
      const response = await createTestApp({ clientDir }).request(
        "/",
        undefined,
        localConnection(),
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(html);
    } finally {
      rmSync(clientDir, { recursive: true, force: true });
    }
  });

  it("SPA のフォールバックは /apiary/abc にも index.html を返す", async () => {
    const clientDir = mkdtempSync(join(tmpdir(), "sukuna-client-"));
    const html = "<!doctype html><title>sukuna</title>";
    writeFileSync(join(clientDir, "index.html"), html);

    try {
      const response = await createTestApp({ clientDir }).request(
        "/apiary/abc",
        undefined,
        localConnection(),
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(html);
    } finally {
      rmSync(clientDir, { recursive: true, force: true });
    }
  });

  it("画面の深い URL は index.html、未知の /api のパスは HTML 以外の 404 を返す", async () => {
    const clientDir = mkdtempSync(join(tmpdir(), "sukuna-client-"));

    try {
      const html = "<!doctype html><title>sukuna</title>";
      writeFileSync(join(clientDir, "index.html"), html);
      const app = createTestApp({ clientDir });

      const pageResponse = await app.request("/conversations/abc", undefined, localConnection());
      const apiResponse = await app.request("/api/unknown", undefined, localConnection());

      expect(pageResponse.status).toBe(200);
      expect(await pageResponse.text()).toBe(html);
      expect(apiResponse.status).toBe(404);
      expect(apiResponse.headers.get("content-type") ?? "").not.toMatch(/^text\/html(?:\s*;|$)/i);
      expect(await apiResponse.text()).not.toBe(html);
    } finally {
      rmSync(clientDir, { recursive: true, force: true });
    }
  });
});
