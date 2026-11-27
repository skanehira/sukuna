import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ulid } from "ulid";
import type { OpenedDatabase } from "../shared/db/open";
import type { Environment } from "../shared/env";
import type { Logger } from "../shared/log";
import { agentScriptSchema } from "../shared/agent-script";
import { createGhRunner } from "../shared/gh/gh-runner";
import { ConversationRuntime } from "./modules/conversation/usecase/runtime";
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
import { registerIssueTools, unavailableIssueReports } from "./modules/issue/adapter/app-tools";
import type { IssueReportsPort } from "./modules/issue/domain/ports";
import { createIssueOpsHandler } from "./modules/flow/adapter/issue-ops-handler";

export async function startRunnerApp(options: {
  database: OpenedDatabase;
  environment: Environment;
  log: Logger;
  agent?: AgentPort;
  clock?: Clock;
  children?: ChildProcesses;
  ipc?: IpcExtensions;
  issueReports?: IssueReportsPort;
}) {
  const { environment: env, database, log } = options;
  const socket = await reserveRunnerSocket(env.socket);
  try {
    const clock = options.clock ?? systemClock;
    const changes = new ChangeFeed(clock);
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
    const runtime = new ConversationRuntime({
      store: new SqliteConversationStore(database.sqlite),
      agent,
      images: createImageFiles(env.home),
      clock,
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
      notice: (conversationId, message) => {
        const issueId = runtime.store.get(conversationId)?.issueId;
        changes.publish({
          kind: "notice",
          level: "info",
          conversation_id: conversationId,
          message,
        });
        log({
          level: "info",
          component: "runner.agent",
          conversation_id: conversationId,
          ...(issueId ? { issue_id: issueId } : {}),
          message,
        });
      },
    });
    runtime.subscribe((signal) => {
      const conversation = runtime.store.get(signal.conversationId);
      if (signal.type === "parts")
        changes.publish({
          kind: "conversation_parts",
          conversation_id: signal.conversationId,
          parts: signal.parts,
        });
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
    const issueOps = createIssueOperations(
      database.db,
      { now: () => clock.now(), id: ulid },
      { publish: (notice) => changes.publish(notice) },
      {
        stop: async (id) => {
          const result = await runtime.stop(id);
          if (result.isErr() && result.error.code !== "conflict")
            throw new Error(result.error.message);
        },
      },
    );
    registerIssueTools(runtime.tools, {
      data: createIssueDataUnitOfWork(database.db),
      flow: issueOps,
      reports: options.issueReports ?? unavailableIssueReports,
    });
    recover(runtime);
    const routes = createIpcRoutes(
      runtime,
      log,
      { pid: process.pid, started_at: clock.now(), version: "0.0.0" },
      { ...options.ipc, flow: createIssueOpsHandler(issueOps) },
    );
    socket.activate(routes, changes);
    return {
      runtime,
      changes,
      gh: createGhRunner(env.ghScript),
      shutdown: async () => {
        socket.stopAccepting();
        await runtime.shutdown();
        changes.close();
        await socket.close();
      },
    };
  } catch (error) {
    await socket.close();
    throw error;
  }
}
