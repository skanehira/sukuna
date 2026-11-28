import { err, ok, type Result } from "neverthrow";
import type { TerminalError } from "./terminal-ports";

const MAX_RUNNING = 20;

export function checkRunningTerminals(
  running: number,
  limit = MAX_RUNNING,
): Result<void, TerminalError> {
  if (running < limit) return ok(undefined);
  return err({
    code: "conflict",
    message: `ターミナルが ${limit} 個動いています。使わないシェルを exit で終えてください`,
  });
}
