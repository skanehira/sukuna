import { and, desc, eq, isNull } from "drizzle-orm";
import { readDesignRecord } from "../../../../shared/db/design-reader";
import type { OpenedDatabase } from "../../../../shared/db/open";
import { conversations, drafts, worktrees } from "../../../../shared/db/schema";
import type { WorktreeActivityReservation } from "../../../../shared/workspace/worktree-activity";
import { createIssueDataRepository } from "../../../../server/modules/issue/adapter/issue-repository";
import { createIssueRepository } from "./issue-repository";
import type { DesignRepository } from "../domain/design-ports";
import { moveStateWithin } from "../usecase/move-state";

export function createDesignRepository(
  db: Pick<OpenedDatabase["db"], "select" | "insert" | "update" | "delete">,
  reservation?: WorktreeActivityReservation,
): DesignRepository {
  const activeTree = (id: string) => and(eq(worktrees.id, id), isNull(worktrees.removedAt));
  const pathTaken = (projectId: string, path: string) =>
    Boolean(
      db
        .select({ id: worktrees.id })
        .from(worktrees)
        .where(
          and(
            eq(worktrees.projectId, projectId),
            eq(worktrees.path, path),
            isNull(worktrees.removedAt),
          ),
        )
        .get(),
    );

  return {
    read: (id) => readDesignRecord(db, id),
    findTree(issueId, projectId, number) {
      const prefix = `sukuna/design-${number}`;
      const suffix = /^-[2-9]\d*$|^-1\d+$/;
      const rows = db
        .select()
        .from(worktrees)
        .where(
          and(
            eq(worktrees.issueId, issueId),
            eq(worktrees.projectId, projectId),
            eq(worktrees.origin, "flow"),
            isNull(worktrees.removedAt),
          ),
        )
        .orderBy(desc(worktrees.id))
        .all();
      const row = rows.find(
        ({ branch }) =>
          branch === prefix ||
          (branch.startsWith(prefix) && suffix.test(branch.slice(prefix.length))),
      );
      return row
        ? { id: row.id, path: row.path, branch: row.branch, branchCreated: row.branchCreated }
        : null;
    },
    pathTaken,
    saveTree(record, tree) {
      db.insert(worktrees)
        .values({
          ...tree,
          branchCreated: true,
          origin: "flow",
          projectId: record.project.id,
          issueId: record.issue.id,
        })
        .run();
    },
    abandonTree(id, now) {
      db.update(worktrees).set({ removedAt: now }).where(activeTree(id)).run();
    },
    attachTree(record, id, tree) {
      return (
        db
          .update(conversations)
          .set({ cwd: tree.path, worktreeId: tree.id })
          .where(
            and(
              eq(conversations.id, id),
              eq(conversations.projectId, record.project.id),
              eq(conversations.issueId, record.issue.id),
              eq(conversations.kind, "design"),
              isNull(conversations.closedAt),
            ),
          )
          .run().changes === 1
      );
    },
    detachTree(record, tree, now) {
      const removed = db
        .update(worktrees)
        .set({ removedAt: now })
        .where(
          and(
            activeTree(tree.id),
            eq(worktrees.projectId, record.project.id),
            eq(worktrees.issueId, record.issue.id),
            eq(worktrees.path, tree.path),
            eq(worktrees.branch, tree.branch),
            eq(worktrees.origin, "flow"),
          ),
        )
        .run().changes;
      if (!removed) return;

      db.update(conversations)
        .set({ cwd: record.project.path, worktreeId: null })
        .where(
          and(
            eq(conversations.projectId, record.project.id),
            eq(conversations.worktreeId, tree.id),
          ),
        )
        .run();
    },
    clearDraft(id, sent, now) {
      const current = db.select().from(drafts).where(eq(drafts.conversationId, id)).get();
      if (
        !current ||
        current.text !== sent.text ||
        current.images.length ||
        sent.images.length ||
        current.updatedAt !== sent.updatedAt ||
        current.updatedBy !== sent.updatedBy
      )
        return false;
      return (
        db
          .update(drafts)
          .set({
            text: "",
            images: [],
            timelineAnchors: null,
            updatedAt: Math.max(now, current.updatedAt),
          })
          .where(eq(drafts.conversationId, id))
          .run().changes === 1
      );
    },
    append(record, type, payload, now) {
      const { seq } = createIssueDataRepository(db).append(record.issue.id, type, payload, now);
      return { kind: "issue", issue_id: record.issue.id, project_id: record.project.id, seq };
    },
    move(record, trigger, now, detail, worktreeReady) {
      if (!reservation) throw new Error("設計の状態更新に必要な worktree の予約がありません");
      return (
        moveStateWithin(
          createIssueRepository(db, reservation),
          {
            issueId: record.issue.id,
            trigger,
            ...(detail === undefined ? {} : { detail }),
            ...(worktreeReady === undefined ? {} : { facts: { worktreeReady } }),
          },
          now,
        ).kind === "moved"
      );
    },
  };
}
