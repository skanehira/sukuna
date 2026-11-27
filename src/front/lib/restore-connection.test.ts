import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  initialRestoreGeneration,
  restoreGenerationCheckHeader,
  restoreGenerationHeader,
  restoreRequestHeader,
} from "../../shared/settings/restore-schema";
import { createRestoreConnection } from "./restore-connection";

const identity = (generation?: string, requestId?: string) =>
  Response.json(
    { login: "dev@example.com", device: "local", build: "test" },
    {
      headers: {
        ...(generation ? { [restoreGenerationHeader]: generation } : {}),
        ...(requestId ? { [restoreRequestHeader]: requestId } : {}),
      },
    },
  );

afterEach(() => window.sessionStorage.clear());

const origin = "https://sukuna.test";

it("再接続先が同じデータベースならそのまま使い、復元されたら受付番号を渡して一度だけ再読込する", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(identity())
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(identity())
    .mockResolvedValue(identity("replacement", "request"));
  const reload = vi.fn();
  const connection = createRestoreConnection({
    fetcher,
    origin,
    storage: window.sessionStorage,
    reload,
  });
  await connection.readIdentity("/api/me");
  expect(await connection.verify()).toBe(false);
  expect(await connection.verify()).toBe(true);
  expect(reload).not.toHaveBeenCalled();
  expect(await connection.verify()).toBe(false);
  expect(await connection.verify()).toBe(false);
  expect(reload).toHaveBeenCalledExactlyOnceWith("request");
});

it("復元されたデータベースで開き直すと、会話を開いたときの古い連番だけを捨てる", async () => {
  const storage = window.sessionStorage;
  const reload = vi.fn();
  const before = createRestoreConnection({
    fetcher: async () => identity(),
    origin,
    storage,
    reload,
  });
  await before.readIdentity("/api/me");
  storage.setItem("sukuna:recap:conversation", "saved");
  storage.setItem("sukuna:positions:v1", "history");
  const after = createRestoreConnection({
    fetcher: async () => identity("replacement"),
    origin,
    storage,
    reload,
  });
  await after.readIdentity("/api/me");
  expect(storage.getItem("sukuna:recap:conversation")).toBeNull();
  expect(storage.getItem("sukuna:positions:v1")).toBe("history");
  expect(reload).not.toHaveBeenCalled();
});

it("画面が取得した世代で書き込み、復元先に拒否された書き込みは再送しない", async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(identity())
    .mockResolvedValue(
      new Response(null, {
        status: 409,
        headers: {
          [restoreGenerationHeader]: "replacement",
          [restoreRequestHeader]: "request",
        },
      }),
    );
  const reload = vi.fn();
  const connection = createRestoreConnection({
    fetcher: transport,
    origin,
    storage: window.sessionStorage,
    reload,
  });
  await connection.readIdentity("/api/me");
  const headers = { "content-type": "application/json" };
  const result = await connection.request("/api/conversations/1/draft", {
    method: "PUT",
    headers,
    body: "{}",
  });
  expect(result.status).toBe(409);
  const written = new Headers(transport.mock.calls[1]?.[1]?.headers);
  expect(written.get(restoreGenerationCheckHeader)).toBe(initialRestoreGeneration);
  expect(written.get("content-type")).toBe("application/json");
  expect(reload).toHaveBeenCalledExactlyOnceWith("request");
  await expect(
    connection.request("/api/conversations/1/read", { method: "POST" }),
  ).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(2);
});

it("世代を確認していない画面の更新は止め、取得とアプリ外の通信は通す", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response());
  const connection = createRestoreConnection({
    fetcher: transport,
    origin,
    storage: window.sessionStorage,
    reload: vi.fn(),
  });
  await expect(connection.request("/api/settings/keymap", { method: "PUT" })).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
  await connection.request("/api/settings");
  await connection.request("https://other.test/api/settings", { method: "POST" });
  expect(transport.mock.calls).toEqual([
    ["/api/settings", undefined],
    ["https://other.test/api/settings", { method: "POST" }],
  ]);
});
