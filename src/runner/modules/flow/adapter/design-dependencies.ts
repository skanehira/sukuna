import type { OpenedDatabase } from "../../../../shared/db/open";
import type { GhRunner } from "../../../../shared/gh/gh-runner";
import { createWorktreeActivity } from "../../../../shared/workspace/sqlite-worktree-activity";
import { createWorktreeGit } from "../../../../server/modules/workspace/adapter/git-cli";
import type { ConversationRuntime } from "../../conversation/usecase/runtime";
import {
  createGitCli,
  createRunnerDesignGit,
  type GitRunner,
} from "../../workspace/adapter/git-cli";
import { createDesignGithub } from "./gh-cli";
import { createDesignRepository } from "./design-repository";
import type { DesignFlowDependencies } from "../domain/design-ports";
import { createDesignWorkspace } from "../usecase/design-workspace";
import { createReflectDesign } from "../usecase/reflect-design";
import { createRejectDesign } from "../usecase/reject-design";
import { createSubmitDesign } from "../usecase/submit-design";

export function createDesignFlow(
  database: OpenedDatabase,
  runtime: ConversationRuntime,
  gh: GhRunner,
  options: Pick<DesignFlowDependencies, "clock" | "notices" | "alert" | "log">,
  gitRunner: GitRunner = createGitCli(),
) {
  const activity = createWorktreeActivity(database.sqlite.name);
  const workspaceGit = createWorktreeGit(gitRunner, gh);
  const deps: DesignFlowDependencies = {
    ...options,
    activity,
    workspace: workspaceGit,
    git: createRunnerDesignGit(gitRunner, workspaceGit),
    gh: createDesignGithub(gh),
    repo: createDesignRepository(database.db),
    transaction(action, reservation) {
      const run = (lease: Parameters<typeof createDesignRepository>[1]) =>
        database.db.transaction((tx) => action(createDesignRepository(tx, lease)), {
          behavior: "immediate",
        });
      return reservation ? run(reservation) : activity.run(run);
    },
  };
  const { workspace, cleanup } = createDesignWorkspace(deps, runtime);
  const reflect = createReflectDesign(deps, runtime, cleanup);
  const withdrawnCleanup = new Set<Promise<void>>();
  return {
    workspace,
    submit: createSubmitDesign(deps),
    reject: createRejectDesign(deps, runtime, reflect.reflecting),
    approve: reflect.approve,
    completePr: reflect.completePr,
    sendPrInstruction: reflect.sendPrInstruction,
    drain: () =>
      Promise.all([reflect.drain(), runtime.drainAcceptedDeliveries(), ...withdrawnCleanup]),
    hasWorktree(id: string) {
      const record = deps.repo.read(id);
      return Boolean(record && deps.repo.findTree(id, record.project.id, record.issue.number));
    },
    finishWithdrawal(id: string, stop: () => Promise<void>) {
      const record = deps.repo.read(id);
      const job = Promise.resolve()
        .then(stop)
        .then(() => (record?.issue.state === "withdrawn" ? cleanup(record) : undefined))
        .catch((error: unknown) => {
          deps.log(error);
          deps.alert(
            id,
            "取り下げは保存しましたが、AI や作業場所を片付けられませんでした。会話の状態を確認してください。",
          );
        })
        .finally(() => withdrawnCleanup.delete(job));
      withdrawnCleanup.add(job);
    },
  };
}

export type DesignFlow = ReturnType<typeof createDesignFlow>;
