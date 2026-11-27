import { describe, expect, it } from "vite-plus/test";
import { err, ok } from "neverthrow";
import { createClockFake, createTailscaleFake } from "../test-support";
import { createResolveIdentity } from "./resolve-identity";

const LOGIN = "dev@example.com";

describe("createResolveIdentity", () => {
  it("Tailscale の範囲の外の接続元は、whois を呼ばずに本人ではないと返す", async () => {
    const tailscale = createTailscaleFake();
    const resolve = createResolveIdentity({
      login: LOGIN,
      devIdentity: undefined,
      tailscale: tailscale.api,
      clock: createClockFake(),
    });

    const decision = await resolve({ address: "192.168.1.20", port: 50000 });

    expect(decision).toEqual({ allowed: false, reason: "identity" });
    expect(tailscale.whoisCalls).toEqual([]);
    expect(tailscale.credentialReads()).toBe(0);
  });

  it.each([
    { address: "100.64.0.0", allowed: true },
    { address: "100.127.255.255", allowed: true },
    { address: "100.63.255.255", allowed: false },
    { address: "100.128.0.1", allowed: false },
  ])(
    "$address は Tailscale の範囲の内側なら通り、外側なら whois を呼ばずに拒否する",
    async ({ address, allowed }) => {
      const tailscale = createTailscaleFake();
      const resolve = createResolveIdentity({
        login: LOGIN,
        devIdentity: undefined,
        tailscale: tailscale.api,
        clock: createClockFake(),
      });

      const decision = await resolve({ address, port: 50000 });

      if (allowed) {
        expect(decision).toEqual({
          allowed: true,
          identity: { login: LOGIN, device: "macbook-air" },
        });
        expect(tailscale.whoisCalls).toHaveLength(1);
      } else {
        expect(decision).toEqual({ allowed: false, reason: "identity" });
        expect(tailscale.whoisCalls).toEqual([]);
      }
    },
  );

  it("::ffff: の付いた接続元は IPv4 の形にしてから範囲を判定し、whois に渡す", async () => {
    const tailscale = createTailscaleFake();
    const resolve = createResolveIdentity({
      login: LOGIN,
      devIdentity: undefined,
      tailscale: tailscale.api,
      clock: createClockFake(),
    });

    const decision = await resolve({ address: "::ffff:100.64.0.7", port: 4321 });

    expect(decision).toEqual({ allowed: true, identity: { login: LOGIN, device: "macbook-air" } });
    expect(tailscale.whoisCalls).toEqual([
      { address: "100.64.0.7", port: 4321, credentials: { port: 4580, password: "proof" } },
    ]);
  });

  it("持ち主が SUKUNA_LOGIN と一致する接続元は通り、端末の名前を返す", async () => {
    const tailscale = createTailscaleFake();
    const resolve = createResolveIdentity({
      login: LOGIN,
      devIdentity: undefined,
      tailscale: tailscale.api,
      clock: createClockFake(),
    });

    const decision = await resolve({ address: "100.64.0.7", port: 4321 });

    expect(decision).toEqual({ allowed: true, identity: { login: LOGIN, device: "macbook-air" } });
  });

  it("持ち主が SUKUNA_LOGIN と一致しない接続元は本人ではないと返す", async () => {
    const tailscale = createTailscaleFake({
      whois: async () => ok({ loginName: "other@example.com", deviceName: "macbook-air" }),
    });
    const resolve = createResolveIdentity({
      login: LOGIN,
      devIdentity: undefined,
      tailscale: tailscale.api,
      clock: createClockFake(),
    });

    const decision = await resolve({ address: "100.64.0.7", port: 4321 });

    expect(decision).toEqual({ allowed: false, reason: "identity" });
  });

  it("SUKUNA_DEV_IDENTITY があると 127.0.0.1 は whois を呼ばずに通り、device は local になる", async () => {
    const tailscale = createTailscaleFake();
    const resolve = createResolveIdentity({
      login: LOGIN,
      devIdentity: "dev@example.com",
      tailscale: tailscale.api,
      clock: createClockFake(),
    });

    const decision = await resolve({ address: "127.0.0.1", port: 50000 });

    expect(decision).toEqual({
      allowed: true,
      identity: { login: "dev@example.com", device: "local" },
    });
    expect(tailscale.whoisCalls).toEqual([]);
  });

  it("SUKUNA_DEV_IDENTITY が無いときは 127.0.0.1 でも whois を呼ばずに拒否する", async () => {
    const tailscale = createTailscaleFake();
    const resolve = createResolveIdentity({
      login: LOGIN,
      devIdentity: undefined,
      tailscale: tailscale.api,
      clock: createClockFake(),
    });

    const decision = await resolve({ address: "127.0.0.1", port: 50000 });

    expect(decision).toEqual({ allowed: false, reason: "identity" });
    expect(tailscale.whoisCalls).toEqual([]);
    expect(tailscale.credentialReads()).toBe(0);
  });

  it("SUKUNA_DEV_IDENTITY があると ::1 からの接続も whois を呼ばずに通り、device は local になる", async () => {
    const tailscale = createTailscaleFake();
    const resolve = createResolveIdentity({
      login: LOGIN,
      devIdentity: "dev@example.com",
      tailscale: tailscale.api,
      clock: createClockFake(),
    });

    const decision = await resolve({ address: "::1", port: 50000 });

    expect(decision).toEqual({
      allowed: true,
      identity: { login: "dev@example.com", device: "local" },
    });
    expect(tailscale.whoisCalls).toEqual([]);
  });

  it("SUKUNA_DEV_IDENTITY は手元の接続元以外を特別扱いしない", async () => {
    const tailscale = createTailscaleFake({
      whois: async () => ok({ loginName: LOGIN, deviceName: "macbook-air" }),
    });
    const resolve = createResolveIdentity({
      login: LOGIN,
      devIdentity: "dev@example.com",
      tailscale: tailscale.api,
      clock: createClockFake(),
    });

    const decision = await resolve({ address: "100.64.0.7", port: 4321 });

    expect(decision).toEqual({ allowed: true, identity: { login: LOGIN, device: "macbook-air" } });
    expect(tailscale.whoisCalls).toHaveLength(1);
  });

  it("whois が 404 を返すと本人ではない理由で拒否し、問い合わせ直さない", async () => {
    const tailscale = createTailscaleFake({ whois: async () => err("not_found") });
    const resolve = createResolveIdentity({
      login: LOGIN,
      devIdentity: undefined,
      tailscale: tailscale.api,
      clock: createClockFake(),
    });

    const decision = await resolve({ address: "100.64.0.7", port: 4321 });

    expect(decision).toEqual({ allowed: false, reason: "identity" });
    expect(tailscale.whoisCalls).toHaveLength(1);
  });

  it("whois が失敗すると問い合わせできない理由で拒否し、結果を覚えない", async () => {
    const tailscale = createTailscaleFake({ whois: async () => err("auth") });
    const resolve = createResolveIdentity({
      login: LOGIN,
      devIdentity: undefined,
      tailscale: tailscale.api,
      clock: createClockFake(),
    });

    const first = await resolve({ address: "100.64.0.7", port: 4321 });

    expect(first).toEqual({ allowed: false, reason: "unavailable" });
    expect(tailscale.whoisCalls).toHaveLength(2);
    expect(tailscale.credentialReads()).toBe(2);

    const second = await resolve({ address: "100.64.0.7", port: 4322 });

    expect(second).toEqual({ allowed: false, reason: "unavailable" });
    expect(tailscale.whoisCalls).toHaveLength(4);
    expect(tailscale.credentialReads()).toBe(4);
  });

  it("whois が 404 でも認証でも接続の失敗でもない失敗を返すと、問い合わせ直さずに拒否する", async () => {
    const tailscale = createTailscaleFake({ whois: async () => err("invalid_response") });
    const resolve = createResolveIdentity({
      login: LOGIN,
      devIdentity: undefined,
      tailscale: tailscale.api,
      clock: createClockFake(),
    });

    const decision = await resolve({ address: "100.64.0.7", port: 4321 });

    expect(decision).toEqual({ allowed: false, reason: "unavailable" });
    expect(tailscale.whoisCalls).toHaveLength(1);
    expect(tailscale.credentialReads()).toBe(1);
  });

  it("ポートとパスワードを読めないときは、whois を呼ばずに拒否する", async () => {
    const tailscale = createTailscaleFake({
      readCredentials: async () => err("credentials"),
    });
    const resolve = createResolveIdentity({
      login: LOGIN,
      devIdentity: undefined,
      tailscale: tailscale.api,
      clock: createClockFake(),
    });

    const decision = await resolve({ address: "100.64.0.7", port: 4321 });

    expect(decision).toEqual({ allowed: false, reason: "unavailable" });
    expect(tailscale.whoisCalls).toEqual([]);
    expect(tailscale.credentialReads()).toBe(1);
  });

  it.each(["auth", "connection"] as const)(
    "%s の失敗では資格情報を読み直して 1 回だけ問い合わせ直す",
    async (failure) => {
      const whoisResults = [err(failure), ok({ loginName: LOGIN, deviceName: "macbook-air" })];
      const tailscale = createTailscaleFake({
        whois: async () => whoisResults.shift() ?? err(failure),
      });
      const resolve = createResolveIdentity({
        login: LOGIN,
        devIdentity: undefined,
        tailscale: tailscale.api,
        clock: createClockFake(),
      });

      const decision = await resolve({ address: "100.64.0.7", port: 4321 });

      expect(decision).toEqual({
        allowed: true,
        identity: { login: LOGIN, device: "macbook-air" },
      });
      expect(tailscale.whoisCalls).toHaveLength(2);
      expect(tailscale.credentialReads()).toBe(2);
    },
  );

  it.each([60_000, 61_000])(
    "成功した結果は 59,999ms まで使い、%i ms では問い合わせ直して持ち主の変更を反映する",
    async (refreshAt) => {
      const owner = { loginName: LOGIN, deviceName: "macbook-air" };
      const nextOwner = { loginName: "other@example.com", deviceName: "macbook-air" };
      const whoisResults = [ok(owner), ok(nextOwner)];
      const tailscale = createTailscaleFake({
        whois: async () => whoisResults.shift() ?? ok(nextOwner),
      });
      const clock = createClockFake(0);
      const resolve = createResolveIdentity({
        login: LOGIN,
        devIdentity: undefined,
        tailscale: tailscale.api,
        clock,
      });

      const first = await resolve({ address: "100.64.0.7", port: 4321 });

      expect(first).toEqual({ allowed: true, identity: { login: LOGIN, device: "macbook-air" } });
      expect(tailscale.whoisCalls).toHaveLength(1);

      clock.set(59_999);
      const cached = await resolve({ address: "100.64.0.7", port: 4321 });

      expect(cached).toEqual(first);
      expect(tailscale.whoisCalls).toHaveLength(1);

      clock.set(refreshAt);
      const refreshed = await resolve({ address: "100.64.0.7", port: 4321 });

      expect(refreshed).toEqual({ allowed: false, reason: "identity" });
      expect(tailscale.whoisCalls).toHaveLength(2);
    },
  );

  it("一致しなかった whois の結果も 60 秒覚える", async () => {
    const tailscale = createTailscaleFake({
      whois: async () => ok({ loginName: "other@example.com", deviceName: "macbook-air" }),
    });
    const resolve = createResolveIdentity({
      login: LOGIN,
      devIdentity: undefined,
      tailscale: tailscale.api,
      clock: createClockFake(),
    });

    await resolve({ address: "100.64.0.7", port: 4321 });
    await resolve({ address: "100.64.0.7", port: 4322 });

    expect(tailscale.whoisCalls).toHaveLength(1);
  });
});
