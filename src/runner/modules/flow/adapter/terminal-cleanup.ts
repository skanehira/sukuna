import { Hono } from "hono";
import type { Clock } from "../../conversation/domain/clock";
import type { ImplementationTerminalCleanup } from "../domain/impl-ports";
import { terminalCleanupReplySchema, type TerminalCleanupRequest } from "../../../../shared/ipc";
import type { ChangeFeed } from "../../conversation/adapter/change-feed";

const ACK_TIMEOUT_MS = 8_000;

export function createImplementationTerminalCleanup(
  changes: Pick<ChangeFeed, "publish" | "terminalCleanupAvailable">,
  clock: Pick<Clock, "now" | "setTimeout">,
  id: () => string,
) {
  type Outcome = Awaited<ReturnType<ImplementationTerminalCleanup["close"]>>;
  const pending = new Map<
    string,
    {
      request: TerminalCleanupRequest;
      claimed: boolean;
      resolve(outcome: Outcome): void;
    }
  >();
  let closing = false;

  const close: ImplementationTerminalCleanup["close"] = (worktreeId, path, directoryKey) => {
    if (closing || !changes.terminalCleanupAvailable) return Promise.resolve("deferred");
    const request = {
      request_id: id(),
      worktree_id: worktreeId,
      path,
      directory_key: directoryKey,
      expires_at: clock.now() + ACK_TIMEOUT_MS,
    };
    return new Promise((finish) => {
      const cancel = clock.setTimeout(() => resolve("deferred"), ACK_TIMEOUT_MS);
      function resolve(outcome: Outcome) {
        cancel();
        pending.delete(request.request_id);
        finish(outcome);
      }
      pending.set(request.request_id, { request, claimed: false, resolve });
      changes.publish({ kind: "worktree_terminal_close", ...request });
    });
  };

  const app = new Hono();
  app.post("/terminal-cleanup", async (c) => {
    const parsed = terminalCleanupReplySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ accepted: false }, 400);
    const { request_id, worktree_id, directory_key, step } = parsed.data;
    const current = pending.get(request_id);
    if (
      !current ||
      current.request.worktree_id !== worktree_id ||
      current.request.directory_key !== directory_key ||
      clock.now() >= current.request.expires_at
    )
      return c.json({ accepted: false }, 409);
    if (step === "claim" && !current.claimed) {
      current.claimed = true;
      return c.json({ accepted: true });
    }
    if (current.claimed && step !== "claim") {
      current.resolve(step === "closed" ? "closed" : "deferred");
      return c.json({ accepted: true });
    }
    return c.json({ accepted: false }, 409);
  });
  return {
    app,
    close,
    reconnected() {
      for (const request of pending.values()) request.resolve("reconnected");
    },
    stop() {
      closing = true;
      for (const request of pending.values()) request.resolve("deferred");
    },
  };
}
