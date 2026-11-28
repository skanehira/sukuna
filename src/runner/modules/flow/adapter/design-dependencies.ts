import { createStockQuoteCheck } from "../../stock/adapter/dependencies";
import { createOutgoingStockRepository } from "../../stock/adapter/outgoing-stock-repository";
import type { OpenedDatabase } from "../../../../shared/db/open";
import type { GhRunner } from "../../../../shared/gh/gh-runner";
import { createWorktreeActivity } from "../../../../shared/workspace/sqlite-worktree-activity";
import { createWorktreeGit } from "../../../../server/modules/workspace/adapter/git-cli";
import type { ConversationRuntime } from "../../conversation/usecase/runtime";
import {
  createGitCli,
  createImplementationGit,
  createRunnerDesignGit,
  type GitRunner,
} from "../../workspace/adapter/git-cli";
import { createDesignGithub } from "./gh-cli";
import { createDesignRepository } from "./design-repository";
import { createImplementationTrees } from "./impl-repository";
import type { DesignFlowDependencies } from "../domain/design-ports";
import { createDesignWorkspace } from "../usecase/design-workspace";
import { createReflectDesign } from "../usecase/reflect-design";
import { createRejectDesign } from "../usecase/reject-design";
import { createSubmitDesign } from "../usecase/submit-design";

export function createDesignFlow(
  database: OpenedDatabase,
  runtime: ConversationRuntime,
  gh: GhRunner,
  options: Pick<
    DesignFlowDependencies,
    "clock" | "notices" | "alert" | "log" | "allowPrInstruction"
  >,
  gitRunner: GitRunner = createGitCli(),
) {
  const activity = createWorktreeActivity(database.directories.state);
  const workspaceGit = createWorktreeGit(gitRunner, gh);
  const ownedTrees = createImplementationTrees(database);
  const ownedGit = createImplementationGit(gitRunner, gh);
  const deps: DesignFlowDependencies = {
    ...options,
    activity,
    workspace: workspaceGit,
    async createOwnedTree(cwd, tree, start) {
      const created = await ownedGit.createOwned(cwd, tree.path, tree.branch, start);
      return created.map((identity) => ownedTrees.bindIdentity(tree.id, identity));
    },
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
  const { workspace, attachWorkspace, cleanup } = createDesignWorkspace(deps, runtime);
  const reflect = createReflectDesign(deps, runtime, cleanup);
  const withdrawnCleanup = new Set<Promise<void>>();
  function cleanupFailed(id: string, error: unknown) {
    deps.log(error);
    deps.alert(id, "取り下げは保存しましたが、設計の作業場所を確認できませんでした。");
  }
  return {
    workspace,
    attachWorkspace,
    submit: createSubmitDesign(deps),
    reject: createRejectDesign(
      deps,
      runtime,
      reflect.reflecting,
      createOutgoingStockRepository(database.db),
      createStockQuoteCheck(database.db),
    ),
    approve: reflect.approve,
    completePr: reflect.completePr,
    recoverApproval: reflect.recoverApproval,
    sendPrInstruction: reflect.sendPrInstruction,
    drain: () =>
      Promise.all([reflect.drain(), runtime.drainAcceptedDeliveries(), ...withdrawnCleanup]),
    hasWorktree(id: string) {
      const record = deps.repo.read(id);
      return Boolean(record && deps.repo.findTree(id, record.project.id, record.issue.number));
    },
    cleanupFailed,
    finishWithdrawal(
      id: string,
      stop: () => Promise<void>,
      cleanupOwned: (withdrawalSeq: number) => "owned" | "awaiting_terminal" | "legacy",
    ) {
      const record = deps.repo.read(id);
      const withdrawal = record?.events.findLast((event) => event.type === "state_changed");
      const job = Promise.resolve()
        .then(stop)
        .then(async () => {
          if (record?.issue.state !== "withdrawn" || !withdrawal) return;
          try {
            const outcome = cleanupOwned(withdrawal.seq);
            if (outcome !== "owned")
              await cleanup(record, undefined, outcome === "awaiting_terminal");
          } catch (error) {
            cleanupFailed(id, error);
          }
        })
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
