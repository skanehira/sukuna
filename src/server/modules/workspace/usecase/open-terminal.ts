import { err } from "neverthrow";
import type { OpenTerminalInput } from "../../../../shared/api/terminal";
import type { TerminalDependencies } from "../domain/terminal-ports";

export function openTerminal(input: OpenTerminalInput, deps: TerminalDependencies) {
  const initial = deps.location(input);
  if (initial.isErr()) return err(initial.error);
  if (initial.value.worktreeId === null) return deps.sessions.open(initial.value, input);

  const access = deps.activity.acquire([initial.value.worktreeId]);
  if (access.isErr()) return err(access.error);
  try {
    const current = deps.location(input);
    if (current.isErr()) return err(current.error);
    if (
      current.value.worktreeId !== initial.value.worktreeId ||
      current.value.path !== initial.value.path
    )
      return err({
        code: "conflict" as const,
        message: "作業場所が変わりました。画面を読み直してから開いてください。",
      });
    return deps.sessions.open(current.value, input);
  } finally {
    access.value.release();
  }
}
