import { describe, expect, it } from "vite-plus/test";
import { err, ok } from "neverthrow";
import { parseWhoisResponse } from "./whois-response";

describe("parseWhoisResponse", () => {
  it("200 で UserProfile.LoginName と Node.ComputedName を返す応答から、持ち主と端末名を読む", () => {
    const body = JSON.stringify({
      UserProfile: { LoginName: "dev@example.com" },
      Node: { ComputedName: "macbook-air", Name: "macbook-air.tailnet" },
    });

    expect(parseWhoisResponse(200, body)).toEqual(
      ok({ loginName: "dev@example.com", deviceName: "macbook-air" }),
    );
  });

  it("Node.ComputedName が無いときは Node.Name を端末名にする", () => {
    const body = JSON.stringify({
      UserProfile: { LoginName: "dev@example.com" },
      Node: { Name: "macbook-air.tailnet" },
    });

    expect(parseWhoisResponse(200, body)).toEqual(
      ok({ loginName: "dev@example.com", deviceName: "macbook-air.tailnet" }),
    );
  });

  it.each([
    { status: 401, failure: "auth" },
    { status: 403, failure: "auth" },
    { status: 404, failure: "not_found" },
    { status: 204, failure: "invalid_response" },
    { status: 500, failure: "invalid_response" },
  ])("$status の応答は $failure として返す", ({ status, failure }) => {
    expect(parseWhoisResponse(status, "")).toEqual(err(failure));
  });

  it("本文が JSON ではない応答は invalid_response として返す", () => {
    expect(parseWhoisResponse(200, "not json")).toEqual(err("invalid_response"));
  });

  it("UserProfile が応答に無いときは invalid_response として返す", () => {
    expect(
      parseWhoisResponse(200, JSON.stringify({ Node: { ComputedName: "macbook-air" } })),
    ).toEqual(err("invalid_response"));
  });

  it("Node.ComputedName も Node.Name も応答に無いときは invalid_response として返す", () => {
    const body = JSON.stringify({ UserProfile: { LoginName: "dev@example.com" }, Node: {} });

    expect(parseWhoisResponse(200, body)).toEqual(err("invalid_response"));
  });
});
