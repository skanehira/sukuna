import { createGithubImportDependencies } from "./modules/issue/adapter/github-import-routes";
import { createUsageDependencies } from "./modules/conversation/adapter/usage-routes";
import { createGhRunner } from "../shared/gh/gh-runner";
import { createSettingsDependencies } from "./modules/settings/adapter/dependencies";
import { createDesignDependencies } from "./modules/flow/adapter/design-dependencies";
import { createInboxRepository, formatResetTime } from "./modules/inbox/adapter/inbox-repository";
import { createRecapDependencies } from "./modules/recap/adapter/dependencies";
import { serve } from "@hono/node-server";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { rotateLog } from "../shared/log/rotate";
import { launchdEnvironment } from "./modules/settings/adapter/launchd-environment";
import { fileURLToPath } from "node:url";
import { readEnvironment } from "../shared/env";
import { createLogger } from "../shared/log";
import { createApp } from "./app";
import { buildId } from "./build-id";
import {
  attachUpgradeHandler,
  getPrDependencies,
  getDatabase,
  getRuntimeIdentity,
  getProgressDependencies,
  getConversationDependencies,
  getLifecycleDependencies,
  getRunnerLink,
  getWsHub,
  initializeRuntime,
  getPtySessions,
} from "./runtime";
import { ulid } from "ulid";
import { createStockDependencies } from "./modules/stock/adapter/dependencies";

import { createIssueDependencies } from "./modules/issue/adapter/dependencies";
import { createProjectDependencies } from "./modules/workspace/adapter/project-dependencies";
import { createWorktreeDependencies } from "./modules/workspace/adapter/worktree-dependencies";
import { createWorkspaceDependencies } from "./modules/workspace/adapter/dependencies";

const environment = readEnvironment("server", process.env, homedir(), (path) => {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
});
const log = createLogger({
  now: () => Date.now(),
  write: (line) => console.log(line),
  level: environment.isOk() ? environment.value.logLevel : "info",
});
if (environment.isErr()) {
  log({ level: "error", component: "server", message: environment.error.message });
  process.exit(1);
}
const env = environment.value;
try {
  rotateLog(join(env.home, "logs", "server.log"));
} catch (error) {
  log({ level: "warn", component: "server", message: "ログを整理できませんでした。", error });
}
const clientDir = fileURLToPath(new URL("../client", import.meta.url));
const restoreReceiptWarning = (error: unknown) =>
  log({
    level: "warn",
    component: "server.restore",
    message: "補助の復元結果ファイルを処理できませんでした。",
    error,
  });
const initialized = await initializeRuntime(
  { homeDir: env.home, restoreReceiptWarning },
  { socket: env.socket, log },
);
if (initialized.isErr()) {
  log({ level: "error", component: "db.migrate", message: initialized.error.message });
  process.exit(1);
}
const workspace = createWorkspaceDependencies(() => getDatabase().db);
const server = serve(
  {
    fetch: createApp({
      clientDir,
      build: buildId,
      resolveIdentity: getRuntimeIdentity(),
      settings: createSettingsDependencies(
        () => getDatabase().db,
        env.home,
        () => getWsHub().settingsChanged(),
        process.platform === "darwin" && process.env.NODE_ENV === "production"
          ? {
              launchd: launchdEnvironment(env.home).launchd,
              now: Date.now,
              receiptWarning: restoreReceiptWarning,
            }
          : undefined,
      ),
      workspace,
      inbox: {
        repository: createInboxRepository(() => getDatabase().db),
        resetTime: formatResetTime,
      },
      pr: getPrDependencies(),
      progress: getProgressDependencies(),
      conversations: getConversationDependencies(),
      lifecycle: getLifecycleDependencies(),
      stock: createStockDependencies({
        database: getDatabase,
        workspace,
        runner: getRunnerLink,
        changed: (id, parts) =>
          getWsHub().notice({ kind: "conversation_parts", conversation_id: id, parts }),
        id: ulid,
        now: () => Date.now(),
      }),

      design: createDesignDependencies(() => getDatabase().db, getRunnerLink, log),
      usage: createUsageDependencies(() => getDatabase().db),
      githubImport: createGithubImportDependencies(
        () => getDatabase().db,
        createGhRunner(process.env.SUKUNA_GH ?? null),
        {
          log: log,
          changed: (issueId, projectId) =>
            getWsHub().notice({ kind: "issue", issue_id: issueId, project_id: projectId, seq: 0 }),
        },
      ),
      issues: createIssueDependencies(
        () => getDatabase().db,
        getRunnerLink,
        log,
        undefined,
        (issueId, projectId) =>
          getWsHub().notice({ kind: "issue", issue_id: issueId, project_id: projectId, seq: 0 }),
      ),
      projects: createProjectDependencies(getDatabase, {
        runner: getRunnerLink,
        changed: (id) => getWsHub().notice({ kind: "project", project_id: id }),
        notifications: {
          dismissProject: (id, at) => getWsHub().projectRemoved(id, at),
          restoreProject: (id) => getWsHub().projectRestored(id),
        },
      }),
      worktrees: createWorktreeDependencies(getDatabase, { terminals: getPtySessions() }),
      recap: createRecapDependencies(
        () => getDatabase().db,
        { forward: (method, path) => getRunnerLink().forward(method, path) },
        (id) =>
          getWsHub().notice({ kind: "conversation_parts", conversation_id: id, parts: ["recap"] }),
      ),
    }).fetch,
    port: env.port,
    hostname: "0.0.0.0",
  },
  (info) =>
    log({
      level: "info",
      component: "server",
      message: `listening on http://${info.address}:${info.port}`,
    }),
);
server.on("error", (error) => {
  log({ level: "error", component: "server", message: "サーバーを起動できませんでした。", error });
  process.exit(1);
});
attachUpgradeHandler(server);

function shutdownTerminals() {
  void getPtySessions()
    .close()
    .finally(() => process.exit(0));
}
process.once("SIGINT", shutdownTerminals);
process.once("SIGTERM", shutdownTerminals);
