import { describe, expect, it } from "vite-plus/test";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { designFixture, git } from "../design-test-support";
import { designResponseSchema } from "../../../../shared/api/design";

describe("直接反映で確かめた版の内容を保つ", () => {
  const f = designFixture();
  const commit = (cwd: string, file: string, contents: string, message: string) => {
    writeFileSync(join(cwd, file), contents);
    git(cwd, "add", "--", file);
    git(cwd, "commit", "-qm", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  const approveReviewed = async (headCommit: string, reviewed: string) => {
    const get = await f.request();
    expect(get.status).toBe(200);
    const design = designResponseSchema.parse(await get.json());
    expect(design.headCommit).toBe(headCommit);
    expect(
      design.files.find((file) => file.path === "design.md")?.hunks.flatMap((h) => h.lines),
    ).toContainEqual({
      kind: "add",
      newNo: 2,
      oldNo: null,
      text: reviewed,
    });
    expect(
      (await f.request("/api/issues/issue/design/approve", "POST", { headCommit })).status,
    ).toBe(202);
    await f.runner.design.drain();
    expect(f.events().at(-1)?.type).toBe("worktree_kept");
    expect(f.state()).toBe("ready");
  };

  it.each([false, true])(
    "merge 中に加えた承認内容を保持する (既定ブランチが進んだ: %s)",
    async (mainAdvances) => {
      const tree = (await f.worktree())._unsafeUnwrap();
      git(f.repository, "switch", "-q", "-c", "research-notes");
      const reference = commit(f.repository, "facts.md", "reference\n", "research notes");
      git(f.repository, "switch", "-q", "main");
      commit(tree.path, "scope.md", "overview\n", "add design scope");
      git(tree.path, "merge", "--no-ff", "--no-commit", reference);
      const approvedHead = commit(
        tree.path,
        "design.md",
        "first\nreviewed merge refinement\nlast\n",
        "merge notes and refine design",
      );
      expect((await f.submit()).isOk()).toBe(true);
      if (mainAdvances) commit(f.repository, "main.md", "unrelated main change\n", "advance main");
      await approveReviewed(approvedHead, "reviewed merge refinement");
      expect(git(f.repository, "show", "main:scope.md")).toBe("overview");
      expect(git(f.repository, "show", "main:facts.md")).toBe("reference");
      expect(git(f.repository, "show", "main:design.md")).toBe(
        "first\nreviewed merge refinement\nlast",
      );
    },
  );

  it.each([false, true])(
    "取り消された承認内容も既定ブランチへ入れる (取り消しあり: %s)",
    async (appliedThenReverted) => {
      const tree = await f.prepare();
      if (appliedThenReverted) {
        commit(f.repository, "main.md", "unrelated main change\n", "advance main");
        git(f.repository, "cherry-pick", tree.head);
        git(f.repository, "revert", "--no-edit", "HEAD");
        expect(git(f.repository, "show", "main:design.md")).toBe("first\nold\nlast");
      }
      await approveReviewed(tree.head, "new");
      expect(git(f.repository, "show", "main:design.md")).toBe("first\nnew\nlast");
    },
  );
  it.each([false, true])(
    "未コミットの変更を片付けた後は同じ版を再承認できる（既定に別の変更あり: %s）",
    async (advance) => {
      const tree = await f.prepare();
      if (advance) {
        writeFileSync(join(f.repository, "notes.md"), "separate main change\n");
        git(f.repository, "add", "notes.md");
        git(f.repository, "commit", "-qm", "main notes");
      }
      const originalMain = git(f.repository, "rev-parse", "HEAD");
      writeFileSync(join(f.repository, "design.md"), "first\nlocal uncommitted\nlast\n");
      const first = await f.request("/api/issues/issue/design/approve", "POST", {
        headCommit: tree.head,
      });
      expect(first.status).toBe(202);
      await f.runner.design.drain();
      expect(f.state()).toBe("design_review");
      expect(git(f.repository, "rev-parse", "HEAD")).toBe(originalMain);
      const displayed = designResponseSchema.parse(await (await f.request()).json());
      expect(displayed.reflection.failure).toContain("未コミットの変更");
      expect(displayed.headCommit).toBe(tree.head);
      expect(git(tree.path, "rev-parse", "HEAD")).toBe(tree.head);
      git(f.repository, "restore", "--", "design.md");
      const retry = await f.request("/api/issues/issue/design/approve", "POST", {
        headCommit: displayed.headCommit,
      });
      expect(retry.status).toBe(202);
      await f.runner.design.drain();
      expect(f.state()).toBe("ready");
    },
  );

  it("リモートが push を拒否した後、拒否の原因を解消すると同じ版を再承認できる", async () => {
    f.options({ usesGithub: true });
    const tree = await f.prepare();
    writeFileSync(join(f.repository, "notes.md"), "separate remote main change\n");
    git(f.repository, "add", "notes.md");
    git(f.repository, "commit", "-qm", "main notes");
    git(f.repository, "push", "-q", "origin", "main");
    const main = git(f.remote, "rev-parse", "refs/heads/main");
    const hook = join(f.remote, "hooks", "pre-receive");
    writeFileSync(hook, '#!/bin/sh\nprintf "%s\\n" "branch is protected" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const response = await f.request("/api/issues/issue/design/approve", "POST", {
      headCommit: tree.head,
    });
    expect(response.status).toBe(202);
    await f.runner.design.drain();
    expect(f.state()).toBe("design_review");
    expect(git(f.remote, "rev-parse", "refs/heads/main")).toBe(main);
    const displayed = designResponseSchema.parse(await (await f.request()).json());
    expect(displayed.reflection.failure).toContain("既定ブランチへ push できませんでした");
    expect(displayed.headCommit).toBe(tree.head);
    expect(git(tree.path, "rev-parse", "HEAD")).toBe(tree.head);
    rmSync(hook);
    const retry = await f.request("/api/issues/issue/design/approve", "POST", {
      headCommit: displayed.headCommit,
    });
    expect(retry.status).toBe(202);
    await f.runner.design.drain();
    expect(f.state()).toBe("ready");
  });

  it.each([false, true])(
    "別のブランチの参照を動かさずに反映する（rebase.updateRefs: %s）",
    async (updateRefs) => {
      git(f.repository, "config", "rebase.updateRefs", String(updateRefs));
      const tree = await f.prepare();
      git(f.repository, "branch", "developer-review-copy", tree.head);
      const previous = commit(f.repository, "notes.md", "main change\n", "advance main");
      expect(
        (await f.request("/api/issues/issue/design/approve", "POST", { headCommit: tree.head }))
          .status,
      ).toBe(202);
      await f.runner.design.drain();

      expect(f.state()).toBe("ready");
      expect(git(f.repository, "rev-parse", "main^")).toBe(previous);
      expect(git(f.repository, "rev-parse", "developer-review-copy")).toBe(tree.head);
      expect(git(f.repository, "rev-parse", tree.branch)).toBe(tree.head);
      expect(readFileSync(join(f.repository, "notes.md"), "utf8")).toBe("main change\n");
      expect(readFileSync(join(f.repository, "design.md"), "utf8")).toBe("first\nnew\nlast\n");
      expect(git(f.repository, "status", "--porcelain")).toBe("");
    },
  );

  it("既定ブランチの作業場所が確認後に切り替わると反映を保留する", async () => {
    const tree = await f.prepare();
    git(f.repository, "branch", "developer-lab");
    const developerBefore = git(f.repository, "rev-parse", "developer-lab");
    const mainBefore = commit(f.repository, "notes.md", "main change\n", "advance main");
    let switched = false;
    f.interceptGit(async (args) => {
      if (!switched && args.join(" ") === "rev-parse --git-path HEAD") {
        switched = true;
        git(f.repository, "switch", "-q", "developer-lab");
      }
    });
    expect(
      (await f.request("/api/issues/issue/design/approve", "POST", { headCommit: tree.head }))
        .status,
    ).toBe(202);
    await f.runner.design.drain();

    expect(switched).toBe(true);
    expect(f.state()).toBe("design_review");
    expect(git(f.repository, "rev-parse", "main")).toBe(mainBefore);
    expect(git(f.repository, "rev-parse", "HEAD")).toBe(developerBefore);
    expect(git(f.repository, "branch", "--show-current")).toBe("developer-lab");
    expect(git(f.repository, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(f.repository, "design.md"), "utf8")).toBe("first\nold\nlast\n");
  });

  it("反映中は別ブランチへの切り替えから既定ブランチの作業場所とインデックスを守る", async () => {
    const tree = await f.prepare();
    git(f.repository, "switch", "-qc", "developer-lab");
    const developer = commit(f.repository, "notes.md", "developer change\n", "developer notes");
    git(f.repository, "switch", "-q", "main");
    let blocked = false;
    f.interceptGit(async ([op]) => {
      if (op === "read-tree") {
        expect(() => git(f.repository, "switch", "-q", "developer-lab")).toThrow();
        blocked = true;
      }
    });
    expect(
      (await f.request("/api/issues/issue/design/approve", "POST", { headCommit: tree.head }))
        .status,
    ).toBe(202);
    await f.runner.design.drain();

    expect(blocked).toBe(true);
    expect(f.state()).toBe("ready");
    expect(git(f.repository, "branch", "--show-current")).toBe("main");
    expect(git(f.repository, "rev-parse", "developer-lab")).toBe(developer);
    expect(git(f.repository, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(f.repository, "design.md"), "utf8")).toBe("first\nnew\nlast\n");
  });

  it("片方の変更を落とすGitのmerge driverが設定されていれば反映失敗にする", async () => {
    commit(
      f.repository,
      ".gitattributes",
      "design.md merge=keepdefault\n",
      "configure merge driver",
    );
    git(f.repository, "config", "merge.keepdefault.driver", "true");
    const tree = await f.prepare();
    const main = commit(
      f.repository,
      "design.md",
      "first\nlocal incompatible\nlast\n",
      "edit default branch",
    );

    expect(
      (await f.request("/api/issues/issue/design/approve", "POST", { headCommit: tree.head }))
        .status,
    ).toBe(202);
    await f.runner.design.drain();

    expect(f.state()).toBe("design_review");
    expect(f.events().at(-1)?.type).toBe("design_reflect_failed");
    expect(git(f.repository, "rev-parse", "main")).toBe(main);
    expect(git(tree.path, "rev-parse", "HEAD")).toBe(tree.head);
  });

  it.each(["切り替えなし", "既存の作業場所で main を開く", "別の作業場所で main を開く"] as const)(
    "既定ブランチが未チェックアウトの場合に更新を保留する（%s）",
    async (scenario) => {
      const tree = await f.prepare();
      git(f.repository, "switch", "-qc", "developer");
      const mainBefore = git(f.repository, "rev-parse", "main");
      const additional = join(f.home, "opened-main");
      let switched = false;
      f.afterGit(async ([op, command]) => {
        if (op !== "worktree" || command !== "list" || switched || scenario === "切り替えなし")
          return;
        switched = true;
        if (scenario === "既存の作業場所で main を開く") git(f.repository, "switch", "main");
        else git(f.repository, "worktree", "add", additional, "main");
      });
      const approve = () =>
        f.request("/api/issues/issue/design/approve", "POST", { headCommit: tree.head });

      expect((await approve()).status).toBe(202);
      await f.runner.design.drain();

      expect(f.state()).toBe("design_review");
      const status = designResponseSchema.parse(await (await f.request()).json());
      expect(status.reflection.failure).toContain("既定ブランチを開き直して");
      expect(git(f.repository, "rev-parse", "main")).toBe(mainBefore);
      expect(git(f.repository, "rev-parse", "developer")).toBe(mainBefore);
      const checkout = scenario === "別の作業場所で main を開く" ? additional : f.repository;
      expect(readFileSync(join(checkout, "design.md"), "utf8")).toBe("first\nold\nlast\n");
      expect(git(checkout, "status", "--porcelain")).toBe("");
      if (!switched) git(f.repository, "switch", "main");

      expect((await approve()).status).toBe(202);
      await f.runner.design.drain();
      expect(f.state()).toBe("ready");
      expect(readFileSync(join(checkout, "design.md"), "utf8")).toBe("first\nnew\nlast\n");
      expect(git(checkout, "status", "--porcelain")).toBe("");
    },
  );

  it.each([
    { kind: "標準", github: false, conflict: true },
    { kind: "ファイル属性", github: false, conflict: true },
    { kind: "既定設定", github: false, conflict: true },
    { kind: "ファイル属性", github: true, conflict: true },
    { kind: "既定設定", github: true, conflict: true },
    { kind: "ファイル属性", github: false, conflict: false },
    { kind: "既定設定", github: true, conflict: false },
  ])(
    "$kind の合成（GitHub $github、競合 $conflict）で表示した設計を守る",
    async ({ kind, github, conflict }) => {
      if (kind === "ファイル属性")
        commit(f.repository, ".gitattributes", "design.md merge=union\n", "set union attribute");
      if (kind === "既定設定") git(f.repository, "config", "merge.default", "union");
      const base = "header\nold\nseparator\nfooter\n";
      commit(f.repository, "design.md", base, "separate changes");
      if (github) {
        git(f.repository, "push", "origin", "main");
        f.options({ usesGithub: true });
      }
      const tree = (await f.worktree())._unsafeUnwrap();
      const head = commit(
        tree.path,
        "design.md",
        base.replace("old", "approved"),
        "approved edits",
      );
      expect((await f.submit()).isOk()).toBe(true);
      const upstream = conflict
        ? base.replace("old", "upstream")
        : base.replace("footer", "upstream footer");
      const old = commit(f.repository, "design.md", upstream, "update default branch");
      if (github) git(f.repository, "push", "origin", "main");

      expect(
        (await f.request("/api/issues/issue/design/approve", "POST", { headCommit: head })).status,
      ).toBe(202);
      await f.runner.design.drain();

      const target = github ? f.remote : f.repository;
      expect(git(tree.path, "rev-parse", "HEAD")).toBe(head);
      if (conflict) {
        expect(f.state()).toBe("design_review");
        expect(git(target, "rev-parse", "main")).toBe(old);
        expect(f.events().at(-1)).toMatchObject({
          type: "design_reflect_failed",
          payload: { message: expect.stringContaining("design.md") },
        });
      } else {
        expect(f.state()).toBe("ready");
        expect(git(target, "show", "main:design.md")).toBe(
          upstream.replace("old", "approved").trim(),
        );
      }
    },
  );
});
