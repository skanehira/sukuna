import { createInboxRepository, formatResetTime } from "./modules/inbox/adapter/inbox-repository";
import { createApp } from "./app";
import { buildId } from "./build-id";
import { createIssueDependencies } from "./modules/issue/adapter/dependencies";
import {
  getDatabase,
  getRunnerLink,
  getWsHub,
  writeRuntimeLog,
  getProgressDependencies,
  getMessageDependencies,
} from "./runtime";
import { createWorktreeDependencies } from "./modules/workspace/adapter/worktree-dependencies";
import { createWorkspaceDependencies } from "./modules/workspace/adapter/dependencies";
import { ulid } from "ulid";
import { createStockDependencies } from "./modules/stock/adapter/dependencies";

const workspace = createWorkspaceDependencies(() => getDatabase().db);

export default createApp({
  build: buildId,
  workspace,
  inbox: { repository: createInboxRepository(() => getDatabase().db), resetTime: formatResetTime },
  progress: getProgressDependencies(),
  messages: getMessageDependencies(),
  stock: createStockDependencies({
    database: () => getDatabase().db,
    workspace,
    runner: getRunnerLink,
    changed: (id, parts) =>
      getWsHub().notice({ kind: "conversation_parts", conversation_id: id, parts }),
    id: ulid,
    now: () => Date.now(),
  }),

  issues: createIssueDependencies(
    () => getDatabase().db,
    getRunnerLink,
    writeRuntimeLog,
    undefined,
    (issueId, projectId) =>
      getWsHub().notice({ kind: "issue", issue_id: issueId, project_id: projectId, seq: 0 }),
  ),
  worktrees: createWorktreeDependencies(() => getDatabase().db),
});
