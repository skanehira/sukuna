import { WebSocketServer } from "ws";
import { homedir } from "node:os";
import { join } from "node:path";
import { RunnerLink } from "./runner-link";
import { WsHub } from "./ws-hub";
import { createLogger, type Logger } from "../shared/log";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { err, ok, type Result } from "neverthrow";
import type { OpenedDatabase } from "../shared/db/open";
import { startDatabase, type StartupError, type StartupOptions } from "../shared/db/startup";

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
    hub?.add(client);
    client.on("message", (data) => {
      try {
        hub?.receive(
          client,
          JSON.parse(
            (data instanceof ArrayBuffer
              ? Buffer.from(data)
              : Array.isArray(data)
                ? Buffer.concat(data)
                : data
            ).toString(),
          ),
        );
      } catch {
        log({
          level: "warn",
          component: "server.ws",
          message: "配信の要求を読み取れませんでした。",
        });
      }
    });
    client.on("close", () => hub?.remove(client));
    client.on("error", () => {
      hub?.remove(client);
      log({ level: "warn", component: "server.ws", message: "配信の接続が切れました。" });
    });
  });
};

export function attachUpgradeHandler(server: UpgradeCapableServer): void {
  server.on("upgrade", handleUpgrade);
}

let database: OpenedDatabase | undefined;
let hub: WsHub | undefined;
let runner: RunnerLink | undefined;
let initializing: Promise<Result<void, StartupError>> | undefined;
let log: Logger = createLogger({
  now: () => Date.now(),
  write: (line) => console.log(line),
  level: "info",
});
const heartbeat = setInterval(() => {
  hub?.ping();
}, 20_000);
heartbeat.unref();

export async function initializeRuntime(
  options?: StartupOptions,
  connection?: { socket?: string; log?: Logger },
): Promise<Result<void, StartupError>> {
  if (database !== undefined) return ok(undefined);
  if (initializing) return initializing;
  initializing = (async () => {
    const result = await startDatabase(options);
    if (result.isErr()) return err(result.error);
    database = result.value;
    if (connection?.log) log = connection.log;
    hub = new WsHub(database.sqlite);
    runner = new RunnerLink({
      socket:
        connection?.socket ??
        process.env.SUKUNA_RUNNER_SOCKET ??
        join(
          options?.homeDir ?? process.env.SUKUNA_HOME ?? join(homedir(), ".sukuna"),
          "runner.sock",
        ),
      log,
      notice: (notice) => hub?.notice(notice),
      connection: (connected) => hub?.connection(connected),
    });
    runner.start();
    return ok(undefined);
  })();
  const result = await initializing;
  initializing = undefined;
  return result;
}

export function getDatabase(): OpenedDatabase {
  if (database === undefined) throw new Error("データベースがまだ開かれていません");
  return database;
}

export function getRunnerLink(): RunnerLink {
  if (!runner) throw new Error("ランナーとの接続が初期化されていません");
  return runner;
}
export function getWsHub(): WsHub {
  if (!hub) throw new Error("配信が初期化されていません");
  return hub;
}
