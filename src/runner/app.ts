import { createStockSender } from "./modules/stock/adapter/dependencies";
import type { GitRunner } from "./modules/workspace/adapter/git-cli";
import { createDesignFlow } from "./modules/flow/adapter/design-dependencies";
import { createStageRepository } from "./modules/flow/adapter/stage-repository";
import { createFlowNotifyHandler } from "./modules/flow/adapter/notify-handler";
import { createImplementationTerminalCleanup } from "./modules/flow/adapter/terminal-cleanup";
import { createStageFlow } from "./modules/flow/adapter/stage-flow";
import { createFlowGate } from "./modules/flow/usecase/flow-gate";
import type { IssueNotice } from "./modules/flow/domain/ports";
import { createDesignIpc } from "./modules/flow/adapter/design-ipc";
import { CommandCache } from "./modules/conversation/adapter/command-cache";
import { issueInstructions } from "./modules/issue/domain/issue-instructions";
import { createRunnerAllowMerge } from "./modules/flow/adapter/allow-merge-dependencies";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ulid } from "ulid";
import type { OpenedDatabase } from "../shared/db/open";
import type { Environment } from "../shared/env";
import type { Logger } from "../shared/log";
import { agentScriptSchema } from "../shared/agent-script";
import { createGhRunner } from "../shared/gh/gh-runner";
import { ConversationRuntime } from "./modules/conversation/usecase/runtime";
import { switchWorkspace } from "./modules/conversation/usecase/switch-workspace";
import { recover } from "./modules/conversation/usecase/recover";
import { SqliteConversationStore } from "./modules/conversation/adapter/sqlite-conversation-store";
import { ScriptedAgent } from "./modules/conversation/adapter/scripted-agent";
import { ClaudeAgentSdk } from "./modules/conversation/adapter/claude-agent-sdk";
import { createImageFiles } from "./modules/conversation/adapter/image-files";
import { ChildProcesses } from "./modules/conversation/adapter/child-processes";
import { systemClock } from "./modules/conversation/adapter/system-clock";
import type { AgentPort } from "./modules/conversation/domain/agent-port";
import { ChangeFeed } from "./modules/conversation/adapter/change-feed";
import { createIpcRoutes, type IpcExtensions } from "./modules/conversation/adapter/ipc-routes";
import { reserveRunnerSocket } from "./modules/conversation/adapter/ipc-socket";
import type { Clock } from "./modules/conversation/domain/clock";
import { createIssueOperations } from "./modules/flow/adapter/issue-ops-dependencies";
import { createIssueDataUnitOfWork } from "../server/modules/issue/adapter/issue-repository";
import { registerIssueTools } from "./modules/issue/adapter/app-tools";
import type { IssueReportsPort } from "./modules/issue/domain/ports";
import { createIssueOpsHandler } from "./modules/flow/adapter/issue-ops-handler";
import { createDecisionFileStore } from "../shared/recap/decision-file-store";
import { pendingRecapFiles } from "./modules/recap/adapter/pending-recap-files";
import { createRunnerRecapRepository } from "./modules/recap/adapter/repository";
import { createSummarizer } from "./modules/recap/adapter/summarizer";
import { recapRead, registerRecapInstructions } from "./modules/recap/adapter/recap-tool";
import type { SummarizerPort } from "./modules/recap/domain/summarizer-port";
import { RecapUpdates } from "./modules/recap/usecase/update-recap";

export async function startRunnerApp(options: {
  database: OpenedDatabase;
  environment: Environment;
  log: Logger;
  agent?: AgentPort;
  clock?: Clock;
  children?: ChildProcesses;
  ipc?: IpcExtensions;
  issueReports?: IssueReportsPort;
  summarizer?: SummarizerPort;
  designGit?: GitRunner;
}) {
  const { environment: env, database, log } = options;
  const socket = await reserveRunnerSocket(env.socket);
  try {
    const clock = options.clock ?? systemClock;
    const changes = new ChangeFeed(clock);
    const terminalCleanup = createImplementationTerminalCleanup(changes, systemClock, randomUUID);
    const children = options.children ?? new ChildProcesses(env.home);
    const stoppedChildren = await children.cleanup();
    if (stoppedChildren.length)
      log({
        level: "info",
        component: "runner.recovery",
        message: `子プロセスを停止しました: ${stoppedChildren.join(", ")}`,
      });
    const agent =
      options.agent ??
      (env.agent === "fake"
        ? new ScriptedAgent(
            agentScriptSchema.parse(JSON.parse(readFileSync(env.agentScript ?? "", "utf8"))),
          )
        : new ClaudeAgentSdk(undefined, children.spawn));
    const flowRepo = createStageRepository(database, () => clock.now());
    const allows = createFlowGate({
      globallyPaused: () => flowRepo.globallyPaused(),
      settings: (id) => {
        const project = flowRepo.project(id);
        return project?.removedAt === null ? project : undefined;
      },
    });
    const runtime = new ConversationRuntime({
      canResume: (conversation) =>
        Promise.resolve(
          (conversation.kind === "triage" ||
            conversation.kind === "design" ||
            conversation.kind === "impl") &&
            allows(conversation.projectId, conversation.kind),
        ),
      store: new SqliteConversationStore(database.sqlite),
      agent,
      images: createImageFiles(env.home),
      clock,
      commands: new CommandCache(),
      id: ulid,
      uuid: randomUUID,
      log: (context, message, error) =>
        log({
          level: error === undefined ? "info" : "error",
          component: "runner.agent",
          message,
          conversation_id: context.conversationId,
          ...(context.issueId === null ? {} : { issue_id: context.issueId }),
          ...(error === undefined ? {} : { error }),
        }),
      notice: (conversationId, message, level) => {
        const issueId = runtime.store.get(conversationId)?.issueId;
        changes.publish({
          kind: "notice",
          level,
          conversation_id: conversationId,
          message,
        });
        log({
          level,
          component: "runner.agent",
          conversation_id: conversationId,
          ...(issueId ? { issue_id: issueId } : {}),
          message,
        });
      },
    });
    const recapRepository = createRunnerRecapRepository(database.db);
    const files = createDecisionFileStore();
    const recap = new RecapUpdates({
      repository: recapRepository,
      files,
      pending: pendingRecapFiles(env.home),
      summarizer: options.summarizer ?? createSummarizer(agent),
      clock,
      id: ulid,
      uuid: randomUUID,
      changed: (id) =>
        changes.publish({ kind: "conversation_parts", conversation_id: id, parts: ["recap"] }),
      failure: (id, error) =>
        log({
          level: "warn",
          component: "runner.recap",
          conversation_id: id,
          message: "会話の目次と決まったことを更新できませんでした。",
          error,
        }),
    });
    runtime.runOptions.registerInstructions(issueInstructions);
    registerRecapInstructions(runtime.runOptions, recapRepository);
    runtime.subscribe((signal) => {
      const conversation = runtime.store.get(signal.conversationId);
      if (signal.type === "parts")
        changes.publish({
          kind: "conversation_parts",
          conversation_id: signal.conversationId,
          parts: signal.parts,
        });
      if (signal.type === "turnEnded") recap.enqueue(signal.conversationId, signal.endSeq);
      if (signal.type === "delta") changes.delta(signal.conversationId, signal.text);
      if (signal.type === "event" && conversation) {
        if (signal.event.type === "assistant_text" || signal.event.type === "turn_end")
          changes.discardDelta(conversation.id);
        changes.publish({
          kind: "conversation",
          conversation_id: conversation.id,
          seq: signal.event.seq,
          run_state: conversation.runState,
          project_id: conversation.projectId,
          issue_id: conversation.issueId,
        });
      }
      if (
        conversation?.kind === "thread" &&
        conversation.parentConversationId &&
        !runtime.releases.has(conversation.id) &&
        (signal.type === "runStateChanged" ||
          (signal.type === "event" &&
            signal.event.seq === 1 &&
            signal.event.type === "user_message" &&
            signal.event.payload.origin === "stock"))
      ) {
        runtime.partsChanged(conversation.parentConversationId, ["stock", "threads"]);
      }
      if (signal.type === "stopped")
        log({
          level: signal.reason === "restarted" ? "info" : "warn",
          component: signal.reason === "restarted" ? "runner.recovery" : "runner.agent",
          conversation_id: signal.conversationId,
          ...(runtime.store.get(signal.conversationId)?.issueId
            ? { issue_id: runtime.store.get(signal.conversationId)?.issueId ?? undefined }
            : {}),
          message: `会話が止まりました: ${signal.reason}`,
        });
    });
    const gh = createGhRunner(env.ghScript);
    let scheduleFlow: ((id: string) => void) | undefined;
    const notices = {
      publish: (notice: IssueNotice) => {
        changes.publish(notice);
        scheduleFlow?.(notice.project_id);
      },
    };
    const design = createDesignFlow(
      database,
      runtime,
      gh,
      {
        clock: { now: () => clock.now(), id: ulid },
        notices,
        allowPrInstruction: (projectId) => allows(projectId, "design"),
        alert: (issue_id, message) =>
          changes.publish({ kind: "notice", level: "error", issue_id, message }),
        log: (error) =>
          log({
            level: "error",
            component: "runner.design",
            message: "設計の反映に失敗しました。",
            error,
          }),
      },
      options.designGit,
    );
    const flow = createStageFlow(
      database,
      flowRepo,
      runtime,
      design,
      allows,
      notices,
      log,
      gh,
      terminalCleanup,
      options.designGit,
    );
    scheduleFlow = flow.schedule;
    const checkStop = async (stop: ReturnType<typeof runtime.prepareStop>) => {
      const result = await stop();
      if (result.isErr() && result.error.code !== "conflict") throw new Error(result.error.message);
    };
    const issueOps = createIssueOperations(
      database,
      { now: () => clock.now(), id: ulid },
      notices,
      {
        stop: (id, cause) =>
          checkStop(() => runtime.stop(id, undefined, undefined, undefined, cause)),
        prepareStop: (id, cause) => {
          const stop = runtime.prepareStop(id, cause);
          return () => checkStop(stop);
        },
      },
      (id) => design.hasWorktree(id),
    );
    registerIssueTools(runtime.tools, {
      data: createIssueDataUnitOfWork(database.db),
      flow: issueOps,
      reports: options.issueReports ?? flow.reports,
    });
    runtime.tools.register(recapRead(recapRepository, files));
    await flow.recoverBeforeConversations();
    recover(runtime);
    const routes = createIpcRoutes(
      runtime,
      log,
      { pid: process.pid, started_at: clock.now(), version: "0.0.0" },
      {
        workspace: (id, input, cancelled) =>
          switchWorkspace(
            runtime,
            id,
            { cwd: input.cwd, worktreeId: input.worktree_id ?? null },
            cancelled,
            input.attempt,
          ),
        sendStock: createStockSender(database.db, runtime),
        ...options.ipc,
        flow: createIssueOpsHandler(
          issueOps,
          (id, stop) =>
            design.finishWithdrawal(id, stop, (withdrawalSeq) =>
              flow.finishWithdrawal(id, withdrawalSeq),
            ),
          () => clock.now(),
        )
          .route(
            "/",
            createDesignIpc(design, () => clock.now()),
          )
          .route("/", createFlowNotifyHandler(flow.notify))
          .route("/", terminalCleanup.app),
        rebuildRecap: (id) => recap.rebuild(id),
        allowMerge: createRunnerAllowMerge(database.db, runtime, {
          publish: (notice) => changes.publish(notice),
        }),
      },
    );
    socket.activate(routes, changes, () => {
      terminalCleanup.reconnected();
      flow.notify({});
    });
    recap.recover();
    flow.recover();
    return {
      runtime,
      changes,
      gh,
      design,
      shutdown: async () => {
        socket.stopAccepting();
        terminalCleanup.stop();
        await flow.stop();
        await design.drain();
        await Promise.all([runtime.shutdown(), recap.stop()]);
        changes.close();
        await socket.close();
      },
    };
  } catch (error) {
    await socket.close();
    throw error;
  }
}
