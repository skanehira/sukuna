import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { err, ok } from "neverthrow";
import { createApp } from "../../../app";
import { errorResponseSchema, meResponseSchema } from "../../../../shared/api";
import { createResolveIdentity } from "../usecase/resolve-identity";
import {
  createClockFake,
  createTailscaleFake,
  incomingMessageWith,
  incomingWith,
  type TailscaleFakeOptions,
} from "../test-support";
import { createUpgradeAuthorizer } from "./middleware";

const LOGIN = "dev@example.com";
const BUILD = "test-build";
const INDEX_HTML =
  '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>';
const DENIED_TITLE = "このアプリは使えません";
const DENIED_IDENTITY_MESSAGE =
  "Tailscale の本人として確認できませんでした。自分のアカウントで Tailscale につないでから、再読み込みしてください。";
const DENIED_UNAVAILABLE_MESSAGE =
  "Tailscale に問い合わせできませんでした。Mac Studio の Tailscale が動いているかを確かめてから、再読み込みしてください。";

let clientDir: string;

beforeAll(() => {
  clientDir = mkdtempSync(join(tmpdir(), "sukuna-identity-"));
  writeFileSync(join(clientDir, "index.html"), INDEX_HTML);
});

afterAll(() => {
  rmSync(clientDir, { recursive: true, force: true });
});

type SetupOptions = TailscaleFakeOptions & {
  login?: string;
  devIdentity?: string;
};

function deniedHtml(message: string): string {
  return [
    "<!doctype html>",
    '<html lang="ja">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${DENIED_TITLE}</title>`,
    "</head>",
    "<body>",
    "<main>",
    `<h1>${DENIED_TITLE}</h1>`,
    `<p>${message}</p>`,
    '<a href="">再読み込み</a>',
    "</main>",
    "</body>",
    "</html>",
  ].join("");
}

function setup(options: SetupOptions = {}) {
  const tailscale = createTailscaleFake({
    whois: options.whois,
    readCredentials: options.readCredentials,
  });
  const clock = createClockFake();
  const app = createApp({
    build: BUILD,
    clientDir,
    identity: {
      login: options.login ?? LOGIN,
      devIdentity: options.devIdentity,
      tailscale: tailscale.api,
      clock,
    },
  });
  return { app, tailscale, clock };
}

describe("本人の判定のミドルウェア", () => {
  it("本人の接続元では GET /api/me が 200 で login・device・build を返し、SPA の HTML を配る", async () => {
    const { app, tailscale } = setup();

    const response = await app.request("/api/me", undefined, incomingWith("100.64.0.7", 4321));

    expect(response.status).toBe(200);
    expect(meResponseSchema.parse(await response.json())).toEqual({
      login: LOGIN,
      device: "macbook-air",
      build: BUILD,
    });
    expect(tailscale.whoisCalls).toEqual([
      { address: "100.64.0.7", port: 4321, credentials: { port: 4580, password: "proof" } },
    ]);

    const page = await app.request("/", undefined, incomingWith("100.64.0.7", 4321));

    expect(page.status).toBe(200);
    expect(await page.text()).toBe(INDEX_HTML);
  });

  it("本人ではない接続元では API が 401 unauthorized を返し、API ではないパスは拒否の画面だけの HTML を返す", async () => {
    const { app } = setup({
      whois: async () => ok({ loginName: "other@example.com", deviceName: "macbook-air" }),
    });

    const api = await app.request("/api/me", undefined, incomingWith("100.64.0.7", 4321));

    expect(api.status).toBe(401);
    expect(errorResponseSchema.parse(await api.json())).toEqual({
      error: {
        code: "unauthorized",
        message: DENIED_IDENTITY_MESSAGE,
        details: { reason: "identity" },
      },
    });

    const page = await app.request("/", undefined, incomingWith("100.64.0.7", 4321));

    expect(page.status).toBe(401);
    expect(await page.text()).toBe(deniedHtml(DENIED_IDENTITY_MESSAGE));
  });

  it("接続元が取れないときは、401 で拒否する", async () => {
    const { app } = setup();

    const response = await app.request("/api/me");

    expect(response.status).toBe(401);
    expect(errorResponseSchema.parse(await response.json())).toEqual({
      error: {
        code: "unauthorized",
        message: DENIED_IDENTITY_MESSAGE,
        details: { reason: "identity" },
      },
    });
  });

  it("Tailscale の範囲の外の接続元では whois を呼ばず、拒否の画面の HTML を返す。::ffff: は IPv4 にしてから whois に渡す", async () => {
    const { app, tailscale } = setup();

    const page = await app.request("/", undefined, incomingWith("192.168.1.20", 50000));

    expect(page.status).toBe(401);
    expect(await page.text()).toBe(deniedHtml(DENIED_IDENTITY_MESSAGE));
    expect(tailscale.whoisCalls).toEqual([]);
    expect(tailscale.credentialReads()).toBe(0);

    const api = await app.request("/api/me", undefined, incomingWith("192.168.1.20", 50000));

    expect(api.status).toBe(401);
    expect(errorResponseSchema.parse(await api.json())).toEqual({
      error: {
        code: "unauthorized",
        message: DENIED_IDENTITY_MESSAGE,
        details: { reason: "identity" },
      },
    });

    const forwarded = await app.request(
      "/api/me",
      undefined,
      incomingWith("::ffff:100.64.0.7", 4321),
    );

    expect(forwarded.status).toBe(200);
    expect(tailscale.whoisCalls).toEqual([
      { address: "100.64.0.7", port: 4321, credentials: { port: 4580, password: "proof" } },
    ]);
  });

  it("whois が失敗すると、拒否の HTML の 2 文目が問い合わせできなかった文になり、結果を覚えない", async () => {
    const { app, tailscale } = setup({ whois: async () => err("auth") });

    const first = await app.request("/", undefined, incomingWith("100.64.0.7", 4321));

    expect(first.status).toBe(401);
    expect(await first.text()).toBe(deniedHtml(DENIED_UNAVAILABLE_MESSAGE));
    expect(tailscale.whoisCalls).toHaveLength(2);

    const second = await app.request("/", undefined, incomingWith("100.64.0.7", 4321));

    expect(second.status).toBe(401);
    expect(tailscale.whoisCalls).toHaveLength(4);
  });

  it.each([60_000, 61_000])(
    "認証失敗は 1 回だけ問い合わせ直し、59,999ms までの本人情報を %i ms で更新して持ち主の変更を拒否する",
    async (refreshAt) => {
      const owner = { loginName: LOGIN, deviceName: "macbook-air" };
      const nextOwner = { loginName: "other@example.com", deviceName: "macbook-air" };
      const whoisResults = [err("auth"), ok(owner)];
      const { app, tailscale, clock } = setup({
        whois: async () => whoisResults.shift() ?? ok(nextOwner),
      });

      const first = await app.request("/api/me", undefined, incomingWith("100.64.0.7", 4321));

      expect(first.status).toBe(200);
      expect(meResponseSchema.parse(await first.json())).toEqual({
        login: LOGIN,
        device: "macbook-air",
        build: BUILD,
      });
      expect(tailscale.whoisCalls).toHaveLength(2);
      expect(tailscale.credentialReads()).toBe(2);

      clock.set(59_999);
      const cached = await app.request("/api/me", undefined, incomingWith("100.64.0.7", 4322));

      expect(cached.status).toBe(200);
      expect(meResponseSchema.parse(await cached.json())).toEqual({
        login: LOGIN,
        device: "macbook-air",
        build: BUILD,
      });
      expect(tailscale.whoisCalls).toHaveLength(2);

      clock.set(refreshAt);
      const refreshed = await app.request("/api/me", undefined, incomingWith("100.64.0.7", 4323));

      expect(refreshed.status).toBe(401);
      expect(errorResponseSchema.parse(await refreshed.json())).toEqual({
        error: {
          code: "unauthorized",
          message: DENIED_IDENTITY_MESSAGE,
          details: { reason: "identity" },
        },
      });
      expect(tailscale.whoisCalls).toHaveLength(3);
      expect(tailscale.credentialReads()).toBe(3);
    },
  );

  it("SUKUNA_DEV_IDENTITY があると 127.0.0.1 からの接続が通り、login はその値、device は local になる", async () => {
    const { app, tailscale } = setup({ devIdentity: "dev@example.com" });

    const response = await app.request("/api/me", undefined, incomingWith("127.0.0.1", 50000));

    expect(response.status).toBe(200);
    expect(meResponseSchema.parse(await response.json())).toEqual({
      login: "dev@example.com",
      device: "local",
      build: BUILD,
    });
    expect(tailscale.whoisCalls).toEqual([]);
  });
});

describe("createUpgradeAuthorizer", () => {
  it("upgrade の判定の口は、本人ではない接続元に断る結果を返す", async () => {
    const tailscale = createTailscaleFake({
      whois: async () => ok({ loginName: "other@example.com", deviceName: "macbook-air" }),
    });
    const resolve = createResolveIdentity({
      login: LOGIN,
      devIdentity: undefined,
      tailscale: tailscale.api,
      clock: createClockFake(),
    });
    const authorize = createUpgradeAuthorizer({ resolve });

    const outside = await authorize(incomingMessageWith("192.168.1.20", 50000));
    expect(outside).toEqual({ allowed: false, reason: "identity" });
    expect(tailscale.whoisCalls).toEqual([]);

    const mismatch = await authorize(incomingMessageWith("100.64.0.7", 4321));
    expect(mismatch).toEqual({ allowed: false, reason: "identity" });
    expect(tailscale.whoisCalls).toHaveLength(1);
  });

  it("upgrade の判定の口は、本人の接続元を通す", async () => {
    const tailscale = createTailscaleFake();
    const resolve = createResolveIdentity({
      login: LOGIN,
      devIdentity: undefined,
      tailscale: tailscale.api,
      clock: createClockFake(),
    });
    const authorize = createUpgradeAuthorizer({ resolve });

    const allowed = await authorize(incomingMessageWith("100.64.0.7", 4321));

    expect(allowed).toEqual({ allowed: true, identity: { login: LOGIN, device: "macbook-air" } });
  });
});
