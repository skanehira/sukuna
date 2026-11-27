import { createGithubImportDependencies } from "./modules/issue/adapter/github-import-routes";
import { createUsageDependencies } from "./modules/conversation/adapter/usage-routes";
import { createGhRunner } from "../shared/gh/gh-runner";
import { dirname } from "node:path";
import { createSettingsDependencies } from "./modules/settings/adapter/dependencies";
import { createDesignDependencies } from "./modules/flow/adapter/design-dependencies";
import { createInboxRepository, formatResetTime } from "./modules/inbox/adapter/inbox-repository";
import { createRecapDependencies } from "./modules/recap/adapter/dependencies";
import { createApp } from "./app";
import { buildId } from "./build-id";
import { createIssueDependencies } from "./modules/issue/adapter/dependencies";
import {
  getPrDependencies,
  getDatabase,
  getRuntimeIdentity,
  getRunnerLink,
  getWsHub,
  writeRuntimeLog,
  getProgressDependencies,
  getConversationDependencies,
  getPtySessions,
  getLifecycleDependencies,
} from "./runtime";
import { createProjectDependencies } from "./modules/workspace/adapter/project-dependencies";
import { createWorktreeDependencies } from "./modules/workspace/adapter/worktree-dependencies";
import { createWorkspaceDependencies } from "./modules/workspace/adapter/dependencies";
import { ulid } from "ulid";
import { createStockDependencies } from "./modules/stock/adapter/dependencies";

const workspace = createWorkspaceDependencies(() => getDatabase().db);

export default createApp({
  build: buildId,
  resolveIdentity: getRuntimeIdentity(),
  settings: createSettingsDependencies(
    () => getDatabase().db,
    dirname(getDatabase().sqlite.name),
    () => getWsHub().settingsChanged(),
  ),
  workspace,
  inbox: { repository: createInboxRepository(() => getDatabase().db), resetTime: formatResetTime },
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

  design: createDesignDependencies(() => getDatabase().db, getRunnerLink, writeRuntimeLog),
  usage: createUsageDependencies(() => getDatabase().db),
  githubImport: createGithubImportDependencies(
    () => getDatabase().db,
    createGhRunner(process.env.SUKUNA_GH ?? null),
    {
      log: writeRuntimeLog,
      changed: (issueId, projectId) =>
        getWsHub().notice({ kind: "issue", issue_id: issueId, project_id: projectId, seq: 0 }),
    },
  ),
  issues: createIssueDependencies(
    () => getDatabase().db,
    getRunnerLink,
    writeRuntimeLog,
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
});
