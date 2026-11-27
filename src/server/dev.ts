import { createApp } from "./app";
import { buildId } from "./build-id";
import { createWorkspaceDependencies } from "./modules/workspace/adapter/dependencies";
import { getDatabase, getProgressDependencies, getMessageDependencies } from "./runtime";

export default createApp({
  build: buildId,
  workspace: createWorkspaceDependencies(() => getDatabase().db),
  progress: getProgressDependencies(),
  messages: getMessageDependencies(),
});
