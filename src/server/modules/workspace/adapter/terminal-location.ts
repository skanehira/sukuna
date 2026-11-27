import { and, eq, isNull } from "drizzle-orm";
import { err, ok, Result } from "neverthrow";
import { basename } from "node:path";
import type { OpenedDatabase } from "../../../../shared/db/open";
import { conversations, projects, worktrees } from "../../../../shared/db/schema";
import type { TerminalDependencies } from "../domain/terminal-ports";

export function createTerminalLocation(
  database: () => OpenedDatabase["db"],
): TerminalDependencies["location"] {
  return (input) => {
    const outcome = Result.fromThrowable(
      () => {
        const db = database();
        const project = db
          .select({ path: projects.path })
          .from(projects)
          .where(and(eq(projects.id, input.projectId), isNull(projects.removedAt)))
          .get();
        if (!project)
          return err({ code: "not_found" as const, message: "プロジェクトがありません" });
        const conversation =
          input.conversationId === null
            ? null
            : db
                .select({ cwd: conversations.cwd })
                .from(conversations)
                .where(
                  and(
                    eq(conversations.id, input.conversationId),
                    eq(conversations.projectId, input.projectId),
                  ),
                )
                .get();
        if (conversation === undefined)
          return err({ code: "not_found" as const, message: "会話がありません" });
        const projectWorktree = and(
          eq(worktrees.projectId, input.projectId),
          isNull(worktrees.removedAt),
        );
        const worktree =
          input.worktreeId === null
            ? null
            : db
                .select({ id: worktrees.id, path: worktrees.path })
                .from(worktrees)
                .where(and(projectWorktree, eq(worktrees.id, input.worktreeId)))
                .get();
        if (worktree === undefined)
          return err({ code: "not_found" as const, message: "worktree がありません" });

        const path = worktree?.path ?? conversation?.cwd ?? project.path;
        const derivedWorktreeId =
          worktree?.id ??
          (conversation &&
            db
              .select({ id: worktrees.id })
              .from(worktrees)
              .where(and(projectWorktree, eq(worktrees.path, path)))
              .get()?.id) ??
          null;
        return ok({
          projectId: input.projectId,
          worktreeId: derivedWorktreeId,
          path,
          label:
            path === project.path ? "プロジェクトのディレクトリ" : `worktree: ${basename(path)}`,
        });
      },
      () => ({
        code: "internal" as const,
        message: "ターミナルの作業場所を読み取れませんでした。",
      }),
    )();
    return outcome.isOk() ? outcome.value : err(outcome.error);
  };
}
