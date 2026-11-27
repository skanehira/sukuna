import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { healthResponseSchema } from "../shared/api";
import { createApp } from "./app";
import {
  createClockFake,
  createTailscaleFake,
  incomingWith,
} from "./modules/identity/test-support";

function createTestApp(options: { clientDir?: string } = {}) {
  return createApp({
    build: "test-build",
    clientDir: options.clientDir,
    identity: {
      login: "dev@example.com",
      devIdentity: "dev@example.com",
      tailscale: createTailscaleFake().api,
      clock: createClockFake(),
    },
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

  it("clientDir を渡すと、静的ファイルに無い画面の URL でも index.html を返す", async () => {
    const clientDir = mkdtempSync(join(tmpdir(), "sukuna-client-"));
    const html = "<!doctype html><title>sukuna</title>";
    writeFileSync(join(clientDir, "index.html"), html);

    try {
      const response = await createTestApp({ clientDir }).request(
        "/conversations/abc",
        undefined,
        localConnection(),
      );

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
      const response = await createTestApp({ clientDir }).request(
        "/api/unknown",
        undefined,
        localConnection(),
      );

      expect(response.status).toBe(404);
    } finally {
      rmSync(clientDir, { recursive: true, force: true });
    }
  });
});
