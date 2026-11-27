import { err, ok, type Result } from "neverthrow";
import type { ConversationWorkspace } from "../domain/conversation-store";
import type { WorkspaceSwitchAttempt } from "../../../../shared/ipc";
import { activeStates, conflict, type ConversationRuntime, type OperationError } from "./runtime";

const unavailable: OperationError = {
  code: "runner_unavailable",
  message: "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
};

export function switchWorkspace(
  runtime: ConversationRuntime,
  id: string,
  target: ConversationWorkspace,
  cancelled: () => boolean,
  attempt?: WorkspaceSwitchAttempt,
): Promise<Result<{ cwd: string }, OperationError>> {
  return runtime.serial(id, async () => {
    if (cancelled()) return err(unavailable);
    if (runtime.closing) return err(conflict());
    const current = runtime.store.get(id);
    if (!current) return err({ code: "not_found", message: "会話が見つかりません。" });
    if (current.kind !== "chat")
      return err(conflict("worktree を切り替えられるのは、開発者が始めた会話です"));
    if (activeStates.includes(current.runState))
      return err(
        conflict("AI が動いているあいだは切り替えられません。止めてから切り替えてください"),
      );
    const execution = runtime.executions.get(id);
    if (execution) {
      execution.session.close();
      await execution.consuming;
      if (runtime.executions.get(id) === execution) runtime.executions.delete(id);
    }
    if (cancelled()) return err(unavailable);
    if (runtime.closing) return err(conflict());
    const expiredBeforeCommit = new Error(unavailable.message);
    try {
      const changed = runtime.store.withWorkspaceSwitch(id, target.worktreeId, (fromWorktreeIds) =>
        runtime.store.transaction(() => {
          if (attempt && runtime.store.workspaceSwitchSettled(attempt, runtime.options.clock.now()))
            throw expiredBeforeCommit;
          const changed = runtime.store.switchWorkspace(
            current,
            target,
            fromWorktreeIds,
            () => !cancelled() && !runtime.closing,
          );
          if (changed && attempt)
            runtime.store.recordWorkspaceSwitch(attempt, id, runtime.options.clock.now());
          if (changed && cancelled()) throw expiredBeforeCommit;
          return changed;
        }),
      );
      if (!changed) return err(cancelled() ? unavailable : conflict());
    } catch (error) {
      if (error !== expiredBeforeCommit) throw error;
      return err(unavailable);
    }
    runtime.partsChanged(id, []);
    return ok({ cwd: target.cwd });
  });
}
