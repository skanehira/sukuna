import { err, ok, Result } from "neverthrow";
import { isProjectStopTarget } from "../../../../shared/project/stop-targets";
import {
  activeStates,
  type ConversationRuntime,
  type OperationError,
} from "../../conversation/usecase/runtime";

const unavailable: OperationError = {
  code: "runner_unavailable",
  message: "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
};

export async function stopProject(
  runtime: ConversationRuntime,
  projectId: string,
  callerCancelled: () => boolean,
): Promise<Result<{ stoppedConversationIds: string[] }, OperationError>> {
  if (callerCancelled()) return err(unavailable);
  const targetIds = runtime.store
    .list()
    .filter(
      (conversation) => conversation.projectId === projectId && isProjectStopTarget(conversation),
    )
    .map(({ id }) => id)
    .sort();
  const stopped = await Promise.all(
    targetIds.map((id) =>
      runtime.serial(id, async () => {
        if (callerCancelled() || runtime.closing) return err(unavailable);
        const current = runtime.store.get(id);
        if (!current || !isProjectStopTarget(current)) return ok(null);
        if (activeStates.includes(current.runState)) await runtime.interrupt(id, "user");
        const remaining = runtime.store.get(id);
        if (!remaining) return ok(null);
        if (remaining.runState !== "stopped" || remaining.stopReason !== "user") {
          const recorded = runtime.record(id, [{ type: "stopped", payload: { reason: "user" } }]);
          if (recorded.length === 0) return ok(null);
        }
        runtime.timers.cancel(id);
        return ok(id);
      }),
    ),
  );
  if (callerCancelled() || runtime.closing) return err(unavailable);
  return Result.combine(stopped).map((ids) => ({
    stoppedConversationIds: ids.filter((id) => id !== null),
  }));
}
