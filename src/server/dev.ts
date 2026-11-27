import { createApp } from "./app";
import { buildId } from "./build-id";
import { createWorkspaceDependencies } from "./modules/workspace/adapter/dependencies";
import {
  getDatabase,
  getProgressDependencies,
  getMessageDependencies,
  getRunnerLink,
  getWsHub,
} from "./runtime";
import { ulid } from "ulid";
import { createStockDependencies } from "./modules/stock/adapter/dependencies";

const workspace = createWorkspaceDependencies(() => getDatabase().db);

export default createApp({
  build: buildId,
  workspace,
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
});
