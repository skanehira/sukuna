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
import { ChildProcesses } from "./modules/conversation/adapter/child-processes";
import { systemClock } from "./modules/conversation/adapter/system-clock";
import type { AgentPort } from "./modules/conversation/domain/agent-port";
import type { Clock } from "./modules/conversation/domain/clock";

export async function startRunnerApp(options: {
  database: OpenedDatabase;
  environment: Environment;
  log: Logger;
  agent?: AgentPort;
  clock?: Clock;
  children?: ChildProcesses;
}) {
  const { environment: env, database, log } = options;
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
    clock: options.clock ?? systemClock,
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
  recover(runtime);
  return { runtime, gh: createGhRunner(env.ghScript), shutdown: () => runtime.shutdown() };
}
