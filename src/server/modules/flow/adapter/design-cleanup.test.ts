import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { conversations, worktrees } from "../../../../shared/db/schema";
import { designFixture, git } from "../design-test-support";

describe("設計の作業場所の片付け", () => {
  const f = designFixture();
  const approve = (headCommit: string) =>
    f.request("/api/issues/issue/design/approve", "POST", { headCommit });

  it.each([
    "まだ登録とフォルダがある",
    "登録とフォルダを外部で削除",
    "フォルダのみ消失",
    "同じパスを別ブランチで再利用",
  ] as const)("%s の場合に該当する作業場所だけを処理する", async (scenario) => {
    const tree = await f.prepare(false);
    const spare = join(f.home, "other-worktree");
    git(f.repository, "worktree", "add", "-qb", "other-branch", spare, "main");
    rmSync(spare, { recursive: true });
    f.db
      .insert(worktrees)
      .values({
        id: "other-id",
        projectId: "project",
        path: spare,
        branch: "other-branch",
        origin: "user",
      })
      .run();
    f.db
      .insert(conversations)
      .values({
        id: "other-conversation",
        projectId: "project",
        kind: "chat",
        cwd: spare,
        worktreeId: "other-id",
        lastActivityAt: 1,
      })
      .run();

    f.db
      .insert(conversations)
      .values({
        id: "same-path-different-id",
        projectId: "project",
        kind: "chat",
        cwd: tree.path,
        worktreeId: "other-id",
      })
      .run();

    const replaced = scenario === "同じパスを別ブランチで再利用";
    if (scenario === "登録とフォルダを外部で削除" || replaced)
      git(f.repository, "worktree", "remove", tree.path);
    if (scenario === "フォルダのみ消失") rmSync(tree.path, { recursive: true });
    if (replaced)
      git(f.repository, "worktree", "add", "-qb", "developer-replacement", tree.path, "main");

    expect((await approve(tree.head)).status).toBe(202);
    await f.runner.design.drain();

    expect(f.state()).toBe("ready");
    const listed = git(f.repository, "worktree", "list", "--porcelain");
    expect(listed).toContain(spare);
    expect(f.runner.runtime.store.get("other-conversation")).toMatchObject({
      cwd: spare,
      worktreeId: "other-id",
    });
    expect(git(f.repository, "rev-parse", tree.branch)).toBe(tree.head);
    expect(f.runner.runtime.store.get("same-path-different-id")).toMatchObject({
      cwd: tree.path,
      worktreeId: "other-id",
    });
    if (scenario !== "登録とフォルダを外部で削除") {
      expect(existsSync(tree.path)).toBe(scenario !== "フォルダのみ消失");
      expect(listed).toContain(tree.path);
      if (replaced)
        expect(git(tree.path, "branch", "--show-current")).toBe("developer-replacement");
      expect(f.events().at(-1)).toMatchObject({
        type: "worktree_kept",
        payload: { worktreeId: tree.id },
      });
      expect(f.worktrees()).toMatchObject([{ id: tree.id, removedAt: null }]);
    } else {
      expect(existsSync(tree.path)).toBe(false);
      expect(listed).not.toContain(tree.path);
      expect(f.events().at(-1)).toMatchObject({
        type: "worktree_removed",
        payload: { worktreeId: tree.id, retainedBranch: tree.branch },
      });
      expect(f.worktrees()).toMatchObject([{ id: tree.id, removedAt: expect.any(Number) }]);
      expect(f.runner.runtime.store.get("design")).toMatchObject({
        cwd: f.repository,
        worktreeId: null,
      });
    }
  });

  it.each(["更新", "別のworktreeで開く"] as const)(
    "片付け後に設計ブランチを%s操作を守る",
    async (action) => {
      const tree = await f.prepare();
      git(f.repository, "switch", "-qc", "developer-change");
      writeFileSync(join(f.repository, "notes.md"), "reviewer work\n");
      git(f.repository, "add", "--", "notes.md");
      git(f.repository, "commit", "-qm", "developer notes");
      const developer = git(f.repository, "rev-parse", "HEAD");
      git(f.repository, "switch", "-q", "main");

      expect((await approve(tree.head)).status).toBe(202);
      await f.runner.design.drain();
      git(f.repository, "worktree", "remove", tree.path);

      if (action === "更新") {
        git(f.repository, "branch", "-f", tree.branch, developer);
        expect(git(f.repository, "rev-parse", tree.branch)).toBe(developer);
      } else {
        const other = join(f.home, "reused-design");
        git(f.repository, "worktree", "add", other, tree.branch);
        expect(git(other, "rev-parse", "HEAD")).toBe(tree.head);
      }
      expect(f.events().at(-1)).toMatchObject({
        type: "worktree_kept",
        payload: { worktreeId: tree.id },
      });
      expect(existsSync(tree.path)).toBe(false);
    },
  );

  it("Git 一覧の取得直後に同じパスを差し替えても新しい作業場所を保つ", async () => {
    const tree = await f.prepare(false);
    let replaced = false;
    f.afterGit(async ([op, command]) => {
      if (op !== "worktree" || command !== "list" || replaced) return;
      replaced = true;
      git(f.repository, "worktree", "remove", tree.path);
      git(f.repository, "worktree", "add", "-qb", "developer-replacement", tree.path, "main");
      writeFileSync(join(f.repository, ".git", "info", "exclude"), "local-scratch.txt\n");
      writeFileSync(join(tree.path, "local-scratch.txt"), "未追跡の開発者の作業");
    });

    expect((await approve(tree.head)).status).toBe(202);
    await f.runner.design.drain();

    expect(replaced).toBe(true);
    expect(f.state()).toBe("ready");
    expect(git(tree.path, "branch", "--show-current")).toBe("developer-replacement");
    expect(existsSync(join(tree.path, "local-scratch.txt"))).toBe(true);
    expect(f.events().at(-1)).toMatchObject({
      type: "worktree_kept",
      payload: { worktreeId: tree.id },
    });
  });

  it.each(["正常", "一覧", "状態", "未反映数"] as const)(
    "取り下げ後の Git 確認 %s の結果を記録し、失敗だけ知らせる",
    async (failure) => {
      const tree = (await f.worktree())._unsafeUnwrap();
      const metadata =
        failure === "一覧" ? join(f.repository, ".git", "config") : join(tree.path, ".git");
      const original = readFileSync(metadata, "utf8");
      try {
        if (failure === "状態") {
          writeFileSync(metadata, `gitdir: ${join(f.home, "missing-worktree-metadata")}\n`);
          expect(git(f.repository, "worktree", "list", "--porcelain")).toContain(tree.path);
          expect(() => git(tree.path, "status", "--porcelain")).toThrow();
        } else if (failure === "一覧") {
          writeFileSync(metadata, "[invalid git config\n");
          expect(() => git(f.repository, "worktree", "list", "--porcelain")).toThrow();
        } else if (failure === "未反映数") {
          git(f.repository, "switch", "-qc", "developer");
          git(f.repository, "branch", "-d", "main");
          expect(git(tree.path, "status", "--porcelain")).toBe("");
          expect(() =>
            git(
              f.repository,
              "rev-list",
              "--count",
              "HEAD",
              "--not",
              "--remotes",
              "refs/heads/main",
            ),
          ).toThrow();
        }
        expect((await f.request("/api/issues/issue/withdraw", "POST")).status).toBe(200);
        await f.runner.design.drain();

        expect(f.state()).toBe("withdrawn");
        expect(existsSync(tree.path)).toBe(true);
        expect(f.events().at(-1)).toMatchObject({
          type: "worktree_kept",
          payload: { worktreeId: tree.id },
        });
        const errors = () =>
          f.changes.filter((entry) => entry.kind === "notice" && entry.level === "error");
        if (failure !== "正常") {
          await expect.poll(errors).toEqual([
            expect.objectContaining({
              issue_id: "issue",
              message: expect.stringContaining("作業場所を確認できませんでした"),
            }),
          ]);
          expect(f.errorLogs).toHaveLength(1);
        } else {
          expect(errors()).toEqual([]);
          expect(f.errorLogs).toEqual([]);
        }
      } finally {
        if (failure === "状態" || failure === "一覧") writeFileSync(metadata, original);
        if (failure === "未反映数") git(f.repository, "branch", "main", "HEAD");
      }
    },
  );
});
