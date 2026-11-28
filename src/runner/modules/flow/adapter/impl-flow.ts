import type { OpenedDatabase } from "../../../../shared/db/open";
import type { GhRunner } from "../../../../shared/gh/gh-runner";
import type { ConversationRuntime } from "../../conversation/usecase/runtime";
import {
  createGitCli,
  createImplementationGit,
  type GitRunner,
} from "../../workspace/adapter/git-cli";
import { createImplementationGithub } from "./gh-cli";
import { createImplementationTrees } from "./impl-repository";
import { createImplementationStart } from "../usecase/start-implementation";
import { createImplementationCompletion } from "../usecase/complete-implementation";
import { createImplementationReports } from "../usecase/on-impl-report";
import type { ImplementationTerminalCleanup } from "../domain/impl-ports";
import type { StageRepository } from "../domain/stage-ports";
import type { IssueNoticePort } from "../domain/ports";
import type { createFlowGate } from "../usecase/flow-gate";

export function createImplementationFlow(
  database: OpenedDatabase,
  repo: StageRepository,
  runtime: ConversationRuntime,
  notices: IssueNoticePort,
  allows: ReturnType<typeof createFlowGate>,
  ghRunner: GhRunner,
  gitRunner: GitRunner = createGitCli(),
  logFailure: (error: unknown, id: string) => void,
  terminals: ImplementationTerminalCleanup,
  schedule: (projectId: string) => void,
  defer: (projectId: string) => void,
  designCleanupFailed: (id: string, error: unknown) => void,
) {
  const git = createImplementationGit(gitRunner, ghRunner);
  const gh = createImplementationGithub(ghRunner);
  const trees = createImplementationTrees(database);
  const start = createImplementationStart({ repo, runtime, notices, allows, git, gh, trees });
  const finish = createImplementationCompletion({
    repo,
    runtime,
    notices,
    git,
    gh,
    trees,
    start,
    logFailure,
    terminals,
    schedule,
    defer,
    designCleanupFailed,
  });
  return {
    ...start,
    ...finish,
    reports: createImplementationReports(repo, runtime, notices, start, finish.complete, gh),
  };
}
