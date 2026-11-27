import { describe, expect, it } from "vite-plus/test";
import { createApp } from "./app";
import {
  createClockFake,
  createTailscaleFake,
  incomingWith,
} from "./modules/identity/test-support";

describe("アプリシェルのAPIの保護", () => {
  it("Tailscaleの範囲外のIPで/api/healthを呼ぶと401 unauthorizedを返しwhoisを呼ばない", async () => {
    const tailscale = createTailscaleFake();
    const app = createApp({
      build: "test",
      identity: {
        login: "dev@example.com",
        devIdentity: undefined,
        tailscale: tailscale.api,
        clock: createClockFake(),
      },
    });
    const response = await app.request(
      "/api/health",
      undefined,
      incomingWith("192.168.1.20", 50000),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "unauthorized",
        message:
          "Tailscale の本人として確認できませんでした。自分のアカウントで Tailscale につないでから、再読み込みしてください。",
        details: { reason: "identity" },
      },
    });
    expect(tailscale.whoisCalls).toEqual([]);
  });
});
