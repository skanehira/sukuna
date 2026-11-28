import { fc, test } from "@fast-check/vitest";
import { expect, it } from "vite-plus/test";
import { allowsClientAddress, allowsRequestAuthority } from "./network-access";

const octet = fc.integer({ min: 0, max: 255 });

test.prop([fc.integer({ min: 64, max: 127 }), octet, octet])(
  "Tailscale IPv4 の範囲全体を通す",
  (second, third, fourth) => {
    const address = ["100", second, third, fourth].join(".");
    expect(allowsClientAddress(address)).toBe(true);
    expect(allowsClientAddress("::ffff:" + address)).toBe(true);
  },
);

test.prop([fc.constantFrom(10, 192), octet, octet])(
  "通常のプライベートネットワークからの接続を拒否する",
  (first, third, fourth) => {
    const address = [first, first === 192 ? 168 : 0, third, fourth].join(".");
    expect(allowsClientAddress(address)).toBe(false);
  },
);

it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])("ループバックの %s を通す", (address) => {
  expect(allowsClientAddress(address)).toBe(true);
});

it.each(["100.63.255.255", "100.128.0.0", "invalid", undefined])(
  "接続範囲に含まれない %s を拒否する",
  (address) => {
    expect(allowsClientAddress(address)).toBe(false);
  },
);

const names = new Set(["macstudio", "macstudio.local", "macstudio.tailnet.ts.net"]);

it.each([
  "localhost:5173",
  "127.0.0.1:5173",
  "[::1]:5173",
  "macstudio:5173",
  "macstudio.local",
  "macstudio.tailnet.ts.net",
])("端末の名前とリテラル IP で指定した %s は開ける", (authority) => {
  expect(allowsRequestAuthority(authority, names)).toBe(true);
});

it.each(["other.example.invalid:5173", "macstudio.other.invalid", "other@macstudio", undefined])(
  "端末と関係ないホスト %s は開けない",
  (authority) => {
    expect(allowsRequestAuthority(authority, names)).toBe(false);
  },
);
