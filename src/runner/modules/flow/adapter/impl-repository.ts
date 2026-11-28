import { and, eq, isNull } from "drizzle-orm";
import { worktrees, conversations, settings } from "../../../../shared/db/schema";
import type { OpenedDatabase } from "../../../../shared/db/open";
import { createWorktreeActivity } from "../../../../shared/workspace/sqlite-worktree-activity";
import { nextPortSlot } from "../domain/impl-worktree";
import { z } from "zod";
import type { ImplementationTree, ImplementationTrees } from "../domain/impl-ports";

const provenance = z.object({
  identity: z.object({ registration: z.string().min(1), directory: z.string().min(1) }),
  cleanupPath: z.string().nullable(),
  cleanupDetached: z.boolean().default(false),
  cleanupLocks: z
    .array(z.object({ path: z.string(), key: z.string(), stagedPath: z.string().optional() }))
    .default([]),
});
const provenanceKey = (id: string) => `implementation-worktree:${id}`;

export function createImplementationTrees(database: OpenedDatabase): ImplementationTrees {
  const { db } = database;
  const live = (id: string) => and(eq(worktrees.id, id), isNull(worktrees.removedAt));
  const read = (id: string) => {
    const row = db
      .select()
      .from(settings)
      .where(eq(settings.key, provenanceKey(id)))
      .get();
    const value = provenance.safeParse(row?.value);
    return value.success
      ? value.data
      : { identity: null, cleanupPath: null, cleanupDetached: false, cleanupLocks: [] };
  };
  const rows = (projectId?: string): ImplementationTree[] =>
    db
      .select()
      .from(worktrees)
      .where(
        and(
          projectId ? eq(worktrees.projectId, projectId) : undefined,
          eq(worktrees.origin, "flow"),
          isNull(worktrees.removedAt),
        ),
      )
      .all()
      .flatMap(({ id, projectId, path, branch, issueId, portSlot }) =>
        issueId && /^sukuna\/issue-\d+(?:-\d+)?$/.test(branch)
          ? [{ id, projectId, issueId, path, branch, portSlot: portSlot ?? 0, ...read(id) }]
          : [],
      );
  const list = (projectId: string) => rows(projectId);
  const resetLocation: ImplementationTrees["resetLocation"] = (tree, cwd) => {
    db.update(conversations)
      .set({ cwd, worktreeId: null })
      .where(
        and(
          eq(conversations.projectId, tree.projectId),
          eq(conversations.worktreeId, tree.id),
          eq(conversations.cwd, tree.path),
        ),
      )
      .run();
  };
  return {
    activity: createWorktreeActivity(database.sqlite.name),
    list,
    pending: () =>
      rows().filter((tree) => tree.cleanupPath !== null || tree.cleanupLocks.length > 0),
    resetLocation,
    reserve(tree) {
      const reserved = {
        ...tree,
        portSlot: nextPortSlot(list(tree.projectId).map(({ portSlot }) => portSlot)),
      };
      db.insert(worktrees)
        .values({ ...reserved, origin: "flow", branchCreated: true })
        .run();
      return {
        ...reserved,
        identity: null,
        cleanupPath: null,
        cleanupDetached: false,
        cleanupLocks: [],
      };
    },
    bindIdentity(id, identity) {
      db.insert(settings)
        .values({ key: provenanceKey(id), value: { identity, cleanupPath: null } })
        .run();
    },
    planCleanup(id, path, detached) {
      const current = read(id);
      if (!current.identity) return;
      db.update(settings)
        .set({
          value: {
            identity: current.identity,
            cleanupPath: path,
            cleanupDetached: detached,
            cleanupLocks: current.cleanupLocks,
          },
        })
        .where(eq(settings.key, provenanceKey(id)))
        .run();
    },
    lockObserver(id) {
      return {
        planned(file) {
          db.transaction(
            (tx) => {
              const current = read(id);
              if (!current.identity) throw new Error("Git ロックの所有を記録できませんでした");
              tx.update(settings)
                .set({ value: { ...current, cleanupLocks: [...current.cleanupLocks, file] } })
                .where(eq(settings.key, provenanceKey(id)))
                .run();
            },
            { behavior: "immediate" },
          );
        },
        released(file) {
          db.transaction(
            (tx) => {
              const current = read(id);
              if (!current.identity) return;
              const cleanupLocks = current.cleanupLocks.filter(
                (known) => known.path !== file.path || known.key !== file.key,
              );
              tx.update(settings)
                .set({ value: { ...current, cleanupLocks } })
                .where(eq(settings.key, provenanceKey(id)))
                .run();
            },
            { behavior: "immediate" },
          );
        },
      };
    },
    clearLocks(id) {
      const current = read(id);
      if (!current.identity) return;
      db.update(settings)
        .set({ value: { ...current, cleanupLocks: [] } })
        .where(eq(settings.key, provenanceKey(id)))
        .run();
    },
    abandon(id, now) {
      db.transaction((tx) => {
        tx.update(worktrees).set({ removedAt: now }).where(live(id)).run();
        tx.delete(settings)
          .where(eq(settings.key, provenanceKey(id)))
          .run();
      });
    },
    attach(id, tree) {
      const current = list(tree.projectId).find((entry) => entry.id === tree.id);
      if (
        current?.path !== tree.path ||
        current.branch !== tree.branch ||
        current.issueId !== tree.issueId ||
        !tree.identity ||
        current.identity?.registration !== tree.identity.registration ||
        current.identity.directory !== tree.identity.directory ||
        current.cleanupPath !== null
      )
        return false;
      return (
        db
          .update(conversations)
          .set({ cwd: tree.path, worktreeId: tree.id })
          .where(
            and(
              eq(conversations.id, id),
              eq(conversations.issueId, tree.issueId),
              eq(conversations.projectId, tree.projectId),
              eq(conversations.kind, "impl"),
              isNull(conversations.closedAt),
            ),
          )
          .run().changes === 1
      );
    },
    detach(tree, projectPath, now) {
      const removed =
        db
          .update(worktrees)
          .set({ removedAt: now })
          .where(
            and(
              live(tree.id),
              eq(worktrees.projectId, tree.projectId),
              eq(worktrees.issueId, tree.issueId),
              eq(worktrees.origin, "flow"),
              eq(worktrees.path, tree.path),
              eq(worktrees.branch, tree.branch),
            ),
          )
          .run().changes === 1;
      if (!removed) return false;
      db.delete(settings)
        .where(eq(settings.key, provenanceKey(tree.id)))
        .run();
      resetLocation(tree, projectPath);
      return true;
    },
  };
}
