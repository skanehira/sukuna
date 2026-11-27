import { err, ok } from "neverthrow";
import type { ConversationDependencies } from "../domain/ports";
import { reopen } from "./reopen";

export async function resumeConversation(id: string, deps: ConversationDependencies) {
  const result = await deps.runner.call("POST", `/conversations/${encodeURIComponent(id)}/resume`);
  if (result.isErr()) return err(result.error);
  if (result.value.status >= 400) return ok(result.value);
  reopen(id, deps);
  return ok({ status: 202, body: { runState: "working" } });
}
