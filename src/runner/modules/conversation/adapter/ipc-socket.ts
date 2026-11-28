import { TERMINAL_CLEANUP_HEADER } from "../../../../shared/ipc";
import { createServer, type RequestListener, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { getRequestListener } from "@hono/node-server";
import type { Hono } from "hono";
import { acquireLock } from "../../../../shared/db/startup";
import type { ChangeFeed } from "./change-feed";

export async function reserveRunnerSocket(path: string) {
  const locked = await acquireLock({ lockPath: `${path}.lock`, intervalMs: 10, timeoutMs: 5000 });
  if (locked.isErr()) throw new Error("ランナーのソケットのロックを取れませんでした。");
  try {
    return await bindRunnerSocket(path);
  } finally {
    locked.value.release();
  }
}
async function bindRunnerSocket(path: string) {
  if (existsSync(path)) {
    const active = await new Promise<boolean>((resolve, reject) => {
      const probe = connect(path);
      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
        else reject(error);
      });
    });
    if (active) throw new Error("別のランナーが動いています。");
    try {
      unlinkSync(path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  let accepting = false;
  let handler: RequestListener | undefined;
  const sockets = new Set<Socket>();
  const streams = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    if (!accepting || !handler) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: "runner_unavailable", message: "AI を動かすプロセスにつながりません" },
        }),
      );
      return;
    }
    handler(req, res);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  }).catch((error) => {
    throw new Error(
      error instanceof Error && "code" in error && error.code === "EADDRINUSE"
        ? "別のランナーが動いています。"
        : "ランナーのソケットを開けませんでした。",
    );
  });
  chmodSync(path, 0o600);
  return {
    activate(app: Hono, feed: ChangeFeed, onTerminalCleanupConnected?: () => void) {
      const listener = getRequestListener(app.fetch);
      handler = (req, res) => {
        if (req.method === "GET" && req.url === "/changes") {
          res.writeHead(200, {
            "content-type": "application/x-ndjson",
            "cache-control": "no-cache",
          });
          res.flushHeaders();
          streams.add(res);
          const terminalCleanup = req.headers[TERMINAL_CLEANUP_HEADER] === "1";
          const off = feed.subscribe((notice) => {
            if (!res.write(`${JSON.stringify(notice)}\n`)) res.destroy();
          }, terminalCleanup);
          res.once("close", () => {
            off();
            streams.delete(res);
          });
          if (terminalCleanup) onTerminalCleanupConnected?.();
          return;
        }
        void listener(req, res);
      };
      accepting = true;
    },
    stopAccepting() {
      accepting = false;
      server.close();
      for (const stream of streams) stream.destroy();
    },
    close() {
      accepting = false;
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
