import { err, ok, type Result } from "neverthrow";
import type { ConversationRuntime, OperationError } from "./runtime";
import type { PermissionDecision } from "../domain/agent-port";
import { conflict } from "./runtime";
export function permission(
  this: ConversationRuntime,
  id: string,
  requestId: string,
  decision: PermissionDecision,
  callerCancelled?: () => boolean,
): Promise<Result<{ seq: number }, OperationError>> {
  const resolvePermission = () => {
    const execution = this.executions.get(id);
    const pending = execution?.permission;
    if (!pending || pending.request.requestId !== requestId)
      return Promise.resolve(
        err(
          conflict(
            "AI を動かすプロセスが再起動したため、この確認は無効になりました。指示を送って続けてください。",
          ),
        ),
      );
    const [record] = this.record(id, [
      { type: "permission_decision", payload: { request_id: requestId, ...decision } },
    ]);
    delete execution.permission;
    pending.resolve(decision);
    return Promise.resolve(ok({ seq: record?.seq ?? 0 }));
  };
  return this.serial(id, resolvePermission, callerCancelled);
}
