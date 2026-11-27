import { err } from "neverthrow";
import type { RecapDependencies } from "../domain/ports";
import { getContext } from "./context";
export async function rebuild(id: string, deps: RecapDependencies) {
  const context = getContext(id, deps);
  if (context.isErr()) return err(context.error);
  if (context.value.lastTurnSeq <= context.value.recap.state.reflectedSeq)
    return err({
      code: "conflict" as const,
      message: "反映していない番がありません。次の応答を待ってください。",
    });
  return deps.runner.rebuild(id);
}
