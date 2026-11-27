import { and, asc, eq, isNull } from "drizzle-orm";
import { err, ok, Result } from "neverthrow";
import { z } from "zod";
import type { OpenedDatabase } from "../../../../shared/db/open";
import {
  conversations,
  issueEvents,
  issues,
  projects,
  worktrees,
} from "../../../../shared/db/schema";
import {
  WORKTREE_CONFLICT,
  type WorktreeError,
  type WorktreeRepositoryPort,
} from "../domain/worktree-ports";

const prEvent = z.object({ prUrl: z.string().optional(), previousPrUrl: z.string().optional() });

export function createWorktreeRepository(
  database: () => Pick<OpenedDatabase["db"], "select" | "insert" | "update">,
): WorktreeRepositoryPort {
  const safe = <T>(operation: () => T) =>
    Result.fromThrowable(operation, (): WorktreeError => ({
      code: "internal",
      message: "worktree の記録を読み書きできませんでした",
    }))();
  return {
    snapshot(projectId) {
      const result = safe(() => {
        const db = database();
        const project = db
          .select({
            id: projects.id,
            path: projects.path,
            defaultBranch: projects.defaultBranch,
            usesGithub: projects.usesGithub,
          })
          .from(projects)
          .where(and(eq(projects.id, projectId), isNull(projects.removedAt)))
          .get();
        if (!project) return null;
        return {
          project,
          worktrees: db
            .select()
            .from(worktrees)
            .where(and(eq(worktrees.projectId, projectId), isNull(worktrees.removedAt)))
            .all(),
          conversations: db
            .select({
              id: conversations.id,
              cwd: conversations.cwd,
              title: conversations.title,
              runState: conversations.runState,
              closedAt: conversations.closedAt,
            })
            .from(conversations)
            .where(eq(conversations.projectId, projectId))
            .orderBy(asc(conversations.id))
            .all(),
          issues: db
            .select()
            .from(issues)
            .where(eq(issues.projectId, projectId))
            .all()
            .map((issue) => {
              const urls = issue.prUrl === null ? [] : [issue.prUrl];
              for (const event of db
                .select()
                .from(issueEvents)
                .where(eq(issueEvents.issueId, issue.id))
                .orderBy(asc(issueEvents.seq))
                .all()) {
                if (event.type !== "design_pr_created" && event.type !== "reopened_for_fix")
                  continue;
                const parsed = prEvent.safeParse(event.payload);
                if (!parsed.success) continue;
                const url =
                  event.type === "design_pr_created"
                    ? parsed.data.prUrl
                    : parsed.data.previousPrUrl;
                if (url) urls.push(url);
              }
              return {
                id: issue.id,
                number: issue.number,
                title: issue.title,
                state: issue.state,
                prUrls: [...new Set(urls)],
              };
            }),
        };
      });
      if (result.isErr()) return err(result.error);
      return result.value === null
        ? err({ code: "not_found", message: "プロジェクトがありません" })
        : ok(result.value);
    },
    find(id, includeRemoved = false) {
      const result = safe(() =>
        database()
          .select()
          .from(worktrees)
          .where(
            and(eq(worktrees.id, id), includeRemoved ? undefined : isNull(worktrees.removedAt)),
          )
          .get(),
      );
      if (result.isErr()) return err(result.error);
      return result.value
        ? ok(result.value)
        : err({ code: "not_found", message: "worktree がありません" });
    },
    discover(record) {
      return safe(() => {
        const db = database();
        db.insert(worktrees).values(record).onConflictDoNothing().run();
        return db
          .select()
          .from(worktrees)
          .where(
            and(
              eq(worktrees.projectId, record.projectId),
              eq(worktrees.path, record.path),
              isNull(worktrees.removedAt),
            ),
          )
          .get()!;
      });
    },
    reserve(record) {
      const result = safe(() =>
        database().insert(worktrees).values(record).onConflictDoNothing().run(),
      );
      if (result.isErr()) return err(result.error);
      return result.value.changes === 1 ? ok(undefined) : err(WORKTREE_CONFLICT);
    },
    abandon(id, now) {
      return safe(() => {
        database()
          .update(worktrees)
          .set({ removedAt: now })
          .where(and(eq(worktrees.id, id), isNull(worktrees.removedAt)))
          .run();
      });
    },
    remove(record, project, now) {
      return safe(() => {
        const tx = database();
        const removed = tx
          .update(worktrees)
          .set({ removedAt: now })
          .where(and(eq(worktrees.id, record.id), isNull(worktrees.removedAt)))
          .run();
        if (removed.changes === 0) return [];
        return tx
          .update(conversations)
          .set({ cwd: project.path, worktreeId: null })
          .where(and(eq(conversations.projectId, project.id), eq(conversations.cwd, record.path)))
          .returning({ id: conversations.id })
          .all()
          .map((row) => row.id)
          .sort();
      });
    },
  };
}
