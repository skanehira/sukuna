import { defaultIdentityOptions } from "./modules/identity/adapter/options";
import { createUpgradeAuthorizer } from "./modules/identity/adapter/middleware";
import {
  createResolveIdentity,
  type ResolveIdentity,
} from "./modules/identity/usecase/resolve-identity";
import { deniedMessage, type DeniedReason } from "../shared/denied";
import { ulid } from "ulid";
import { createConversationDependencies } from "./modules/conversation/adapter/dependencies";
import type { ConversationDependencies } from "./modules/conversation/domain/ports";
import { createPrDependencies } from "./modules/flow/adapter/pr-dependencies";
import type { PrDependencies } from "./modules/flow/domain/pr-ports";
import { createGhRunner } from "../shared/gh/gh-runner";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createProgressRepository } from "./modules/conversation/adapter/progress-repository";
import { createMessageRepository } from "./modules/conversation/adapter/message-repository";
import type { MessageDependencies } from "./modules/conversation/domain/message-port";
import { createTimelineFilePort } from "./modules/conversation/adapter/timeline-file";
import type { ProgressDependencies } from "./modules/conversation/domain/progress-port";
import { WebSocketServer, type WebSocket } from "ws";
import { RunnerLink } from "./runner-link";
import { WsHub } from "./ws-hub";
import { createLogger, type Logger } from "../shared/log";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { err, ok, type Result } from "neverthrow";
import type { OpenedDatabase } from "../shared/db/open";
import { startDatabase, type StartupError, type StartupOptions } from "../shared/db/startup";
import { createPtySessions, type PtySessions } from "./modules/workspace/adapter/pty-session";
import { connectTerminal } from "./modules/workspace/adapter/terminal-ws";

export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

export type UpgradeCapableServer = {
  on(event: "upgrade", listener: UpgradeHandler): unknown;
};

const WS_PATH = "/ws";
const TERMINAL_PREFIX = "/ws/terminals/";

function rejectUpgrade(
  socket: Duplex,
  status: 401 | 404,
  message: string,
  deniedReason?: DeniedReason,
): void {
  const body = JSON.stringify({
    error: {
      code: status === 401 ? "unauthorized" : "not_found",
      message,
      ...(deniedReason && { details: { reason: deniedReason } }),
    },
  });
  const reason = status === 401 ? "Unauthorized" : "Not Found";
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

export function createUpgradeHandler(options: {
  authorize: ReturnType<typeof createUpgradeAuthorizer>;
  terminals: Pick<PtySessions, "find">;
  connectHub?: (client: WebSocket) => void;
}): UpgradeHandler {
  const wss = new WebSocketServer({ noServer: true });
  return (request, socket, head) => {
    let path: string;
    try {
      path = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    // Vite の HMR も同じ httpServer の upgrade を受ける。対象外のパスは別のリスナーに任せる。
    const connectHub = path === WS_PATH ? options.connectHub : undefined;
    const isTerminal = path.startsWith(TERMINAL_PREFIX);
    if (!connectHub && !isTerminal) return;
    const abandon = () => socket.destroy();
    socket.once("error", abandon);
    void (async () => {
      const decision = await options.authorize(request);
      if (socket.destroyed || !socket.writable) return;
      if (!decision.allowed) {
        rejectUpgrade(
          socket,
          401,
          deniedMessage(decision.reason),
          connectHub ? decision.reason : undefined,
        );
        return;
      }
      if (connectHub) {
        socket.removeListener("error", abandon);
        wss.handleUpgrade(request, socket, head, connectHub);
        return;
      }
      const origin = request.headers.origin;
      const protocol = "encrypted" in request.socket && request.socket.encrypted ? "https" : "http";
      if (
        origin !== undefined &&
        origin !== new URL(`${protocol}://${request.headers.host}`).origin
      ) {
        rejectUpgrade(socket, 401, "アプリを開いた画面から接続してください。");
        return;
      }
      const terminal = options.terminals.find(path.slice(TERMINAL_PREFIX.length));
      if (!terminal) {
        rejectUpgrade(socket, 404, "ターミナルは終了しています。");
        return;
      }
      socket.removeListener("error", abandon);
      wss.handleUpgrade(request, socket, head, (client) => connectTerminal(client, terminal));
    })().catch(() => {
      if (socket.destroyed || !socket.writable) return;
      if (connectHub) rejectUpgrade(socket, 401, deniedMessage("unavailable"), "unavailable");
      else socket.destroy();
    });
  };
}

const terminalSessions = createPtySessions();
export function getPtySessions(): PtySessions {
  return terminalSessions;
}

function connectWsHub(client: WebSocket, target?: WsHub): void {
  target?.add(client);
  client.on("message", (data) => {
    try {
      target?.receive(
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
  client.on("close", () => target?.remove(client));
  client.on("error", () => {
    target?.remove(client);
    log({ level: "warn", component: "server.ws", message: "配信の接続が切れました。" });
  });
}

let runtimeIdentity: ResolveIdentity | undefined;
export function getRuntimeIdentity(): ResolveIdentity {
  runtimeIdentity ??= createResolveIdentity(defaultIdentityOptions());
  return runtimeIdentity;
}

type UpgradeDependencies = { resolve: ResolveIdentity; hub: () => WsHub | undefined };

function runtimeUpgradeHandler(deps: UpgradeDependencies): UpgradeHandler {
  return createUpgradeHandler({
    authorize: createUpgradeAuthorizer({ resolve: deps.resolve }),
    terminals: terminalSessions,
    connectHub: (client) => connectWsHub(client, deps.hub()),
  });
}

export const handleUpgrade = runtimeUpgradeHandler({
  resolve: (source) => getRuntimeIdentity()(source),
  hub: () => hub,
});

export function attachUpgradeHandler(
  server: UpgradeCapableServer,
  deps?: UpgradeDependencies,
): void {
  server.on("upgrade", deps === undefined ? handleUpgrade : runtimeUpgradeHandler(deps));
}

let database: OpenedDatabase | undefined;
let hub: WsHub | undefined;
let runner: RunnerLink | undefined;
let initializing: Promise<Result<void, StartupError>> | undefined;
const now = () => Date.now();
let log: Logger = createLogger({
  now: () => Date.now(),
  write: (line) => console.log(line),
  level: "info",
});
export const writeRuntimeLog: Logger = (entry) => log(entry);
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
      now,
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

let progressDependencies: ProgressDependencies | undefined;

export function getProgressDependencies(): ProgressDependencies {
  progressDependencies ??= {
    repository: createProgressRepository(getDatabase().db),
    timeline: createTimelineFilePort({
      configDir: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
      sleep,
    }),
  };
  return progressDependencies;
}

export function getRunnerLink(): RunnerLink {
  if (!runner) throw new Error("ランナーとの接続が初期化されていません");
  return runner;
}
export function getMessageDependencies(): MessageDependencies {
  return { runner: getRunnerLink(), repository: createMessageRepository(getDatabase().db) };
}
export function getWsHub(): WsHub {
  if (!hub) throw new Error("配信が初期化されていません");
  return hub;
}

export function getConversationDependencies(): ConversationDependencies {
  return createConversationDependencies({
    sqlite: getDatabase().sqlite,
    home: dirname(getDatabase().sqlite.name),
    runner: {
      call: async (method, path, input) => {
        const response = await getRunnerLink().forward(method, path, input);
        return ok({ status: response.status, body: (await response.json()) as unknown });
      },
    },
    id: ulid,
    now,
    notice: (id, message) =>
      getWsHub().notice({ kind: "notice", conversation_id: id, level: "info", message }),
    changed: (id, parts) =>
      getWsHub().notice({ kind: "conversation_parts", conversation_id: id, parts }),
    reopened: (ids) =>
      ids.forEach((id) =>
        getWsHub().notice({ kind: "conversation_parts", conversation_id: id, parts: [] }),
      ),
  });
}

let prDependencies: PrDependencies | undefined;
export function getPrDependencies(): PrDependencies {
  prDependencies ??= createPrDependencies({
    database: () => getDatabase().db,
    gh: createGhRunner(process.env.SUKUNA_GH ?? null),
    runner: getRunnerLink,
    now: Date.now,
    changed: (id) =>
      getWsHub().notice({ kind: "conversation_parts", conversation_id: id, parts: ["stock"] }),
  });
  return prDependencies;
}
