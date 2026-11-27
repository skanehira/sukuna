import { getRequestListener } from "@hono/node-server";
import { once } from "node:events";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { ok } from "neverthrow";
import { afterEach, describe, expect, it } from "vite-plus/test";
import WebSocket from "ws";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
} from "../../../../shared/db/test-helpers";
import { conversations, projects, settings } from "../../../../shared/db/schema";
import type { ServerMessage } from "../../../../shared/ws";
import {
  initialRestoreGeneration,
  restoreGenerationCheckHeader,
  restoreGenerationHeader,
  restoreRequestHeader,
  type RestoreGeneration,
} from "../../../../shared/settings/restore-schema";
import { createApp } from "../../../app";
import { attachUpgradeHandler } from "../../../runtime";
import { WsHub } from "../../../ws-hub";
import { createClockFake, createTailscaleFake } from "../../identity/test-support";
import { createResolveIdentity } from "../../identity/usecase/resolve-identity";
import { createSettingsDependencies } from "./dependencies";

const keymap = {
  version: 1,
  entries: [{ keys: "<Space>T", context: "normal", to: { action: "timeline.open" } }],
};
const active = ["working", "waiting_answer", "waiting_permission"] as const;
const initial = {
  keymap: { version: 1, entries: [] },
  flowPaused: false,
  runningAiCount: 0,
  backup: { schedule: "03:00", lastAt: null, lastError: null, items: [] },
  lastRestore: null,
  push: { vapidPublicKey: null },
};

describe("設定と配信", () => {
  const cleanup: (() => void | Promise<void>)[] = [];
  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  });

  async function fixture(restoreGeneration?: RestoreGeneration) {
    const home = createTempHome();
    const database = openMigratedDatabase(home);
    cleanup.push(
      () => removeTempHome(home),
      () => database.close(),
    );
    const hub = new WsHub(database.sqlite);
    const tailscale = createTailscaleFake({
      whois: async ({ address }) =>
        ok({
          loginName: address === "100.64.0.2" ? "dev@example.com" : "other@example.com",
          deviceName: "test",
        }),
    });
    const resolve = createResolveIdentity({
      login: "dev@example.com",
      devIdentity: undefined,
      tailscale: tailscale.api,
      clock: createClockFake(),
    });
    const app = createApp({
      build: "settings-test",
      restoreGeneration,
      resolveIdentity: resolve,
      settings: createSettingsDependencies(
        () => database.db,
        home,
        () => hub.settingsChanged(),
      ),
    });
    const serve = async (address: string) => {
      const server = createServer(getRequestListener(app.fetch));
      server.on("connection", (socket) => {
        Object.defineProperty(socket, "remoteAddress", { value: address });
      });
      attachUpgradeHandler(server, { resolve, hub: () => hub });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      cleanup.push(() => close(server));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    const owner = await serve("100.64.0.2");
    const other = await serve("100.64.0.3");
    const connect = (url: string) => {
      const ws = new WebSocket(url.replace(/^http/, "ws") + "/ws");
      cleanup.push(() => ws.terminate());
      return ws;
    };
    const read = async () => {
      const response = await fetch(owner + "/api/settings");
      expect(response.status).toBe(200);
      return response.json();
    };
    const save = (body: unknown, revision?: string, generation?: string) =>
      fetch(owner + "/api/settings/keymap", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          ...(revision ? { "if-match": revision } : {}),
          ...(generation ? { [restoreGenerationCheckHeader]: generation } : {}),
        },
        body: JSON.stringify(body),
      });
    return { home, database, hub, tailscale, owner, other, connect, read, save };
  }

  it("初期値と、保存済み設定・稼働中の件数・新しい順のバックアップ・公開鍵を返す", async () => {
    const f = await fixture();
    expect(await f.read()).toEqual(initial);
    const lastRestore = { backupId: "2026-11-25", at: 100, status: "done", message: null };
    f.database.db
      .insert(settings)
      .values([
        { key: "flow_paused", value: true },
        { key: "backup_status", value: { lastAt: 200, lastError: "空き容量がありません" } },
        { key: "last_restore", value: lastRestore },
      ])
      .run();
    f.database.db
      .insert(projects)
      .values([
        { id: "active", path: "/active", name: "active", defaultBranch: "main" },
        { id: "removed", path: "/removed", name: "removed", defaultBranch: "main", removedAt: 1 },
      ])
      .run();
    f.database.db
      .insert(conversations)
      .values([
        ...active.map((runState) => ({
          id: runState,
          projectId: "active",
          kind: "chat" as const,
          cwd: "/active",
          runState,
        })),
        { id: "idle", projectId: "active", kind: "chat", cwd: "/active", runState: "idle" },
        {
          id: "removed-working",
          projectId: "removed",
          kind: "chat",
          cwd: "/removed",
          runState: "working",
        },
      ])
      .run();
    mkdirSync(join(f.home, "backups"));
    for (const [name, at, size] of [
      ["sukuna-2026-11-26.db", 3000, 3],
      ["before-restore-20261125-101500.db", 2000, 2],
      ["unfinished.tmp", 4000, 9],
    ] as const) {
      const path = join(f.home, "backups", name);
      writeFileSync(path, "x".repeat(size));
      utimesSync(path, at / 1000, at / 1000);
    }
    writeFileSync(
      join(f.home, "vapid.json"),
      JSON.stringify({ publicKey: "public-only", privateKey: "test-private" }),
    );
    expect(await f.read()).toEqual({
      ...initial,
      flowPaused: true,
      runningAiCount: 3,
      lastRestore,
      backup: {
        schedule: "03:00",
        lastAt: 200,
        lastError: "空き容量がありません",
        items: [
          { id: "2026-11-26", kind: "daily", createdAt: 3000, sizeBytes: 3 },
          {
            id: "before-restore-20261125-101500",
            kind: "before_restore",
            createdAt: 2000,
            sizeBytes: 2,
          },
        ],
      },
      push: { vapidPublicKey: "public-only" },
    });
  });

  it("PUT の後、別の本人物理接続へ設定変更が届き、GET で最後に保存した割り当てを読める", async () => {
    const f = await fixture();
    expect(await f.read()).toEqual(initial);
    const ws = f.connect(f.owner);
    await once(ws, "open");
    const event = nextMessage(ws);
    const response = await f.save({ entries: keymap.entries });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(keymap);
    await expect(event).resolves.toMatchObject({ topic: "app", type: "settings_changed" });
    expect(await f.read()).toEqual({ ...initial, keymap });
    const reset = await f.save({ entries: [] });
    expect(await reset.json()).toEqual(initial.keymap);
    expect(await f.read()).toEqual(initial);
  });

  it("取得後に別の保存があれば古い版の置き換えを拒み、最新の版では保存する", async () => {
    const f = await fixture();
    const readRevision = async () =>
      (await fetch(f.owner + "/api/settings")).headers.get("x-keymap-revision");
    const revision = await readRevision();
    const other = await f.save({ entries: keymap.entries });
    expect(other.status).toBe(200);

    const stale = await f.save({ entries: [] }, revision ?? undefined);
    expect(stale.status).toBe(412);
    expect(await stale.json()).toEqual({
      error: { code: "keymap_changed", message: "キーの割り当てが変更されました。" },
    });
    expect(await f.read()).toEqual({ ...initial, keymap });
    const latest = await readRevision();
    expect(latest).not.toBe(revision);
    const matched = await f.save({ entries: [] }, latest ?? undefined);
    expect(matched.status).toBe(200);
    expect(await matched.json()).toEqual(initial.keymap);
    expect(await f.read()).toEqual(initial);
  });

  it("復元前の画面の設定変更を拒み、復元を読み直した画面と従来のAPIからは保存できる", async () => {
    const generation = { id: "new-generation", requestId: "restore-request" };
    const f = await fixture(generation);

    const blocked = await f.save({ entries: keymap.entries }, undefined, initialRestoreGeneration);
    expect(blocked.status).toBe(409);
    expect(blocked.headers.get(restoreGenerationHeader)).toBe(generation.id);
    expect(blocked.headers.get(restoreRequestHeader)).toBe(generation.requestId);
    expect(await f.read()).toEqual(initial);

    const current = await f.save({ entries: keymap.entries }, undefined, generation.id);
    expect(current.status).toBe(200);
    expect(await f.read()).toEqual({ ...initial, keymap });

    expect((await f.save({ entries: [] })).status).toBe(200);
    expect(await f.read()).toEqual(initial);
  });

  it.each([
    { keys: "", context: "normal", to: null },
    { keys: " ", context: "normal", to: null },
    { keys: "g", context: "other", to: null },
    { keys: "g", context: "normal", to: { action: "open", keys: "j" } },
  ])("無効な entry は 400 で、保存した割り当てを保持する ($keys, $context)", async (entry) => {
    const f = await fixture();
    expect((await f.save({ entries: keymap.entries })).status).toBe(200);
    const response = await f.save({ entries: [entry] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_input" } });
    expect(await f.read()).toEqual({ ...initial, keymap });
  });

  it("本物の /ws upgrade で本人には記録を再送し、別の端末の接続には 401 を返す", async () => {
    const f = await fixture();
    f.database.db
      .insert(conversations)
      .values({ id: "c", projectId: "p", cwd: "/", kind: "chat", lastSeq: 1 })
      .run();
    f.database.sqlite
      .prepare(
        "INSERT INTO conversation_events (conversation_id,seq,type,payload,created_at) VALUES ('c',1,'assistant_text',?,100)",
      )
      .run(JSON.stringify({ text: "saved reply" }));

    const allowed = f.connect(f.owner);
    await once(allowed, "open");
    const replay = nextMessage(allowed);
    allowed.send(JSON.stringify({ op: "subscribe", topic: "conversation:c", after: 0 }));
    await expect(replay).resolves.toMatchObject({
      topic: "conversation:c",
      type: "event",
      payload: { payload: { text: "saved reply" } },
    });

    const denied = f.connect(f.other);
    denied.on("error", () => undefined);
    const messages: unknown[] = [];
    denied.on("open", () =>
      denied.send(JSON.stringify({ op: "subscribe", topic: "conversation:c", after: 0 })),
    );
    denied.on("message", (message) => messages.push(message));
    const rejection = new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        denied.once("unexpected-response", (_request, response) => {
          response.setEncoding("utf8");
          let body = "";
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () => resolve({ status: response.statusCode, body }));
        });
        denied.once("open", () => reject(new Error("本人でない接続が切り替わりました")));
      },
    );
    const response = await rejection;
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: "unauthorized" } });
    expect(messages).toEqual([]);
    expect(f.tailscale.whoisCalls.map(({ address }) => address)).toEqual([
      "100.64.0.2",
      "100.64.0.3",
    ]);
  });
});

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function nextMessage(socket: WebSocket): Promise<ServerMessage> {
  const [message] = await once(socket, "message");
  return JSON.parse(String(message)) as ServerMessage;
}
