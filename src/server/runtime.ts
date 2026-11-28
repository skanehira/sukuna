import { allowsRequestAuthority } from "./network-access";
import { createLifecycleDependencies } from "./modules/conversation/adapter/lifecycle-dependencies";
import type { LifecycleDependencies } from "./modules/conversation/domain/lifecycle";
import { createWorkspaceDependencies } from "./modules/workspace/adapter/dependencies";
import { ulid } from "ulid";
import { createConversationDependencies } from "./modules/conversation/adapter/dependencies";
import type { ConversationDependencies } from "./modules/conversation/domain/ports";
import { createPrDependencies } from "./modules/flow/adapter/pr-dependencies";
import type { PrDependencies } from "./modules/flow/domain/pr-ports";
import { createGhRunner } from "../shared/gh/gh-runner";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createProgressRepository } from "./modules/conversation/adapter/progress-repository";
import { createMessageRepository } from "./modules/conversation/adapter/message-repository";
import type { MessageDependencies } from "./modules/conversation/domain/message-port";
import { createTimelineWatch } from "./modules/conversation/adapter/timeline-watch";
import { createTimelineFilePort } from "./modules/conversation/adapter/timeline-file";
import type { ProgressDependencies } from "./modules/conversation/domain/progress-port";
import { WebSocketServer, type WebSocket } from "ws";
import { RunnerLink } from "./runner-link";
import { prepareWorktreeTerminalCleanup } from "./modules/workspace/adapter/terminal-cleanup";
import { WsHub } from "./ws-hub";
import type { NotificationPush } from "./modules/inbox/domain/push-port";
import { createInboxRepository, formatResetTime } from "./modules/inbox/adapter/inbox-repository";
import { createLogger, type Logger } from "../shared/log";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { err, ok, type Result } from "neverthrow";
import type { OpenedDatabase } from "../shared/db/open";
import { startDatabase, type StartupError, type StartupOptions } from "../shared/db/startup";
import { resolveDirectories } from "../shared/env";
import { createPtySessions, type PtySessions } from "./modules/workspace/adapter/pty-session";
import { connectTerminal } from "./modules/workspace/adapter/terminal-ws";

export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

export type UpgradeCapableServer = {
  on(event: "upgrade", listener: UpgradeHandler): unknown;
};

const WS_PATH = "/ws";
const TERMINAL_PREFIX = "/ws/terminals/";

function rejectUpgrade(socket: Duplex, status: 401 | 404, message: string): void {
  const body = JSON.stringify({
    error: {
      code: status === 401 ? "unauthorized" : "not_found",
      message,
    },
  });
  const reason = status === 401 ? "Unauthorized" : "Not Found";
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

export function createUpgradeHandler(options: {
  terminals: Pick<PtySessions, "find">;
  hostnames?: ReadonlySet<string>;
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
    if (socket.destroyed || !socket.writable) return;
    try {
      if (options.hostnames && !allowsRequestAuthority(request.headers.host, options.hostnames)) {
        socket.destroy();
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
      if (connectHub) {
        wss.handleUpgrade(request, socket, head, connectHub);
        return;
      }
      const terminal = options.terminals.find(path.slice(TERMINAL_PREFIX.length));
      if (!terminal) {
        rejectUpgrade(socket, 404, "ターミナルは終了しています。");
        return;
      }
      wss.handleUpgrade(request, socket, head, (client) => connectTerminal(client, terminal));
    } catch {
      socket.destroy();
    }
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

type UpgradeDependencies = { hub?: () => WsHub | undefined; hostnames?: ReadonlySet<string> };

export function createRuntimeUpgradeHandler({
  hub: getHub = () => hub,
  hostnames,
}: UpgradeDependencies = {}): UpgradeHandler {
  return createUpgradeHandler({
    terminals: terminalSessions,
    hostnames,
    connectHub: (client) => connectWsHub(client, getHub()),
  });
}

export function attachUpgradeHandler(
  server: UpgradeCapableServer,
  deps?: UpgradeDependencies,
): void {
  server.on("upgrade", createRuntimeUpgradeHandler(deps));
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
  options?: Partial<StartupOptions>,
  connection?: { socket?: string; log?: Logger; notificationPush?: NotificationPush },
): Promise<Result<void, StartupError>> {
  if (database !== undefined) return ok(undefined);
  if (initializing) return initializing;
  initializing = (async () => {
    const directories = options?.directories ?? resolveDirectories(process.env, homedir());
    const result = await startDatabase({ ...options, directories });
    if (result.isErr()) return err(result.error);
    database = result.value;
    if (connection?.log) log = connection.log;
    hub = new WsHub(database.sqlite, {
      inbox: {
        repository: createInboxRepository(() => getDatabase().db),
        resetTime: formatResetTime,
      },
      now,
      id: ulid,
      notificationPush: connection?.notificationPush,
      onError: () =>
        log({
          level: "error",
          component: "server.inbox",
          message: "一覧のお知らせの記録を更新できませんでした。",
        }),
      timeline: createTimelineWatch({
        database: database.sqlite,
        configDir: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
        changed: (id, seq) =>
          hub?.publish({
            topic: `conversation:${id}`,
            seq,
            type: "changed",
            payload: { parts: ["timeline"] },
          }),
      }),
    });
    runner = new RunnerLink({
      socket:
        connection?.socket ??
        process.env.SUKUNA_RUNNER_SOCKET ??
        join(directories.runtime, "runner.sock"),
      log,
      now,
      notice: (notice) => hub?.notice(notice),
      terminalCleanup: (request) =>
        prepareWorktreeTerminalCleanup(getDatabase().db, terminalSessions, request),
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
    home: getDatabase().directories.data,
    runner: {
      call: async (...args: Parameters<RunnerLink["call"]>) => {
        const response = await getRunnerLink().forward(...args);
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

let lifecycleDependencies: LifecycleDependencies | undefined;

export function getLifecycleDependencies(): LifecycleDependencies {
  lifecycleDependencies ??= createLifecycleDependencies({
    database: getDatabase,
    home: getDatabase().directories.data,
    runner: getRunnerLink(),
    workspace: createWorkspaceDependencies(() => getDatabase().db),
    gh: createGhRunner(process.env.SUKUNA_GH ?? null),
    log: writeRuntimeLog,
    now,
    withdraw: (target) => getWsHub().withdrawNotifications(target),
    changed: (projectId, ids, parentId) => {
      const hub = getWsHub();
      const parent = parentId ? hub.conversationParts(parentId, ["stock", "threads"]) : undefined;
      hub.inbox(ids, parent?.issue_id ? [parent.issue_id] : [], [projectId]);
    },
  });
  return lifecycleDependencies;
}
