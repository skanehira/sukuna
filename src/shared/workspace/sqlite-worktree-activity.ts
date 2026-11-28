import { err, ok } from "neverthrow";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  WorktreeActivityBusy,
  type WorktreeActivity,
  type WorktreeActivityLease,
} from "./worktree-activity";

export function createWorktreeActivity(stateDirectory: string): WorktreeActivity {
  const acquire: WorktreeActivity["acquire"] = (ids) => {
    const held = new Map<string, Database.Database>();
    const lease: WorktreeActivityLease = {
      release() {
        for (const guard of held.values()) guard.close();
        held.clear();
      },
      acquire(ids) {
        for (const id of [...new Set(ids)].sort()) {
          if (held.has(id)) continue;
          const directory = join(stateDirectory, "worktree-leases");
          mkdirSync(directory, { recursive: true });
          const guard = new Database(join(directory, `${encodeURIComponent(id)}.db`), {
            timeout: 0,
          });
          try {
            guard.exec("BEGIN IMMEDIATE");
            held.set(id, guard);
          } catch (error) {
            guard.close();
            if (error instanceof Error && "code" in error && error.code === "SQLITE_BUSY")
              throw new WorktreeActivityBusy();
            throw error;
          }
        }
      },
    };
    try {
      lease.acquire(ids);
      return ok(lease);
    } catch (error) {
      lease.release();
      return err({
        code: error instanceof WorktreeActivityBusy ? "conflict" : "internal",
        message: error instanceof Error ? error.message : "worktree の排他を取得できませんでした",
      });
    }
  };
  return {
    acquire,
    run(action) {
      const lease = acquire([])._unsafeUnwrap();
      try {
        return action(lease);
      } finally {
        lease.release();
      }
    },
  };
}
