import { afterEach, describe, expect, it } from "vite-plus/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import WebSocket from "ws";
import type { OpenedDatabase } from "../shared/db/open";
import { createTempHome, removeTempHome } from "../shared/db/test-helpers";
import { attachUpgradeHandler, getDatabase, initializeRuntime } from "./runtime";

function settle(socket: WebSocket): Promise<"open" | "error"> {
  return new Promise((resolve) => {
    socket.once("open", () => resolve("open"));
    socket.once("error", () => resolve("error"));
  });
}

describe("attachUpgradeHandler", () => {
  let server: Server | undefined;
  const clients: WebSocket[] = [];
  const rawSockets = new Set<Socket>();

  afterEach(async () => {
    for (const client of clients) client.terminate();
    clients.length = 0;
    for (const socket of rawSockets) socket.destroy();
    rawSockets.clear();
    if (server !== undefined) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  it("/ws への接続を受け付け、ほかのパスへの接続は受け付けない", async () => {
    const httpServer = createServer((_request, response) => {
      response.end("ok");
    });
    httpServer.on("connection", (socket) => {
      rawSockets.add(socket);
    });
    attachUpgradeHandler(httpServer);
    server = httpServer;
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const { port } = httpServer.address() as AddressInfo;

    const accepted = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    clients.push(accepted);
    expect(await settle(accepted)).toBe("open");
    expect(accepted.readyState).toBe(WebSocket.OPEN);

    const rejected = new WebSocket(`ws://127.0.0.1:${port}/other`, { handshakeTimeout: 500 });
    clients.push(rejected);
    expect(await settle(rejected)).toBe("error");
  });
});

describe("initializeRuntime", () => {
  it("2 回初期化しても、データベースの接続は 1 つのまま", async () => {
    const home = createTempHome();
    let database: OpenedDatabase | undefined;

    try {
      const first = await initializeRuntime({ homeDir: home });
      expect(first.isOk()).toBe(true);
      if (!first.isOk()) throw new Error("初期化に失敗しました");
      database = getDatabase();

      const second = await initializeRuntime({ homeDir: home });
      expect(second.isOk()).toBe(true);
      expect(getDatabase()).toBe(database);
    } finally {
      database?.close();
      removeTempHome(home);
    }
  });
});
