import { WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

export type UpgradeCapableServer = {
  on(event: "upgrade", listener: UpgradeHandler): unknown;
};

const WS_PATH = "/ws";

const wss = new WebSocketServer({ noServer: true });

export const handleUpgrade: UpgradeHandler = (request, socket, head) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  // Vite の HMR も同じ httpServer の upgrade を受けるので、/ws 以外は何もしない (socket を閉じると HMR が壊れる)
  if (path !== WS_PATH) return;
  wss.handleUpgrade(request, socket, head, (client) => {
    wss.emit("connection", client, request);
  });
};

export function attachUpgradeHandler(server: UpgradeCapableServer): void {
  server.on("upgrade", handleUpgrade);
}
