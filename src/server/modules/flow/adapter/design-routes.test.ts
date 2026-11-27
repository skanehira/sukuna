import { ScriptedAgent } from "../../../../runner/modules/conversation/adapter/scripted-agent";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { existsSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { designResponseSchema } from "../../../../shared/api/design";
import { designFixture, git } from "../design-test-support";
import { issues, stockItems } from "../../../../shared/db/schema";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

describe("設計のAPIとランナー", () => {
  const f = designFixture();
  const path = "/api/issues/issue/design";
  const approve = (headCommit: string) => f.request(`${path}/approve`, "POST", { headCommit });
  const reject = (text: string) => f.request(`${path}/reject`, "POST", { text });
  const read = async () => {
    const response = await f.request();
    expect(response.status).toBe(200);
    return designResponseSchema.parse(await response.json());
  };

  it("設計のworktreeを予約し衝突時は別名を使い、同じ会話には使い直す", async () => {
    git(f.repository, "branch", "sukuna/design-42");
    const first = (await f.worktree())._unsafeUnwrap();
    expect(first).toMatchObject({
      branch: "sukuna/design-42-2",
      path: join(f.repository, ".claude", "worktrees", "design-42-2"),
    });
    expect((await f.worktree())._unsafeUnwrap()).toEqual(first);
    expect(f.worktrees()).toEqual([
      expect.objectContaining({
        id: first.id,
        branchCreated: true,
        origin: "flow",
        removedAt: null,
      }),
    ]);
    expect(f.runner.runtime.store.get("design")).toMatchObject({
      cwd: first.path,
      worktreeId: first.id,
      sessionId: "design-session",
    });
  });

  it("完了時のコミットと差分を返し、コミットが無ければ差分のエラーを返す", async () => {
    expect(await read()).toMatchObject({
      status: "none",
      submittedAt: null,
      headCommit: null,
      files: [],
    });
    const tree = await f.prepare();
    f.db
      .insert(stockItems)
      .values({
        id: "stock",
        conversationId: "design",
        kind: "instruction",
        state: "stocked",
        text: "確かめる",
      })
      .run();
    expect(await read()).toMatchObject({
      status: "reviewing",
      designConversationId: "design",
      policy: "在庫を先に確保する",
      checks: ["期限は30分?"],
      headCommit: tree.head,
      unsentInstructionCount: 1,
      files: [
        {
          path: "design.md",
          status: "modified",
          binary: false,
          hunks: [
            {
              oldStart: 1,
              newStart: 1,
              oldLines: 3,
              newLines: 3,
              lines: [
                { kind: "ctx", oldNo: 1, newNo: 1, text: "first" },
                { kind: "del", oldNo: 2, newNo: null, text: "old" },
                { kind: "add", oldNo: null, newNo: 2, text: "new" },
                { kind: "ctx", oldNo: 3, newNo: 3, text: "last" },
              ],
            },
          ],
        },
      ],
    });
    expect(f.events().find((event) => event.type === "design_submitted")?.payload).toMatchObject({
      baseCommit: tree.base,
      branch: tree.branch,
      headCommit: tree.head,
    });
    git(tree.path, "reset", "--hard", tree.base);
    git(f.repository, "reflog", "expire", "--expire=now", "--all");
    git(f.repository, "prune", "--expire=now");
    expect(await read()).toMatchObject({
      files: [],
      diffError: expect.stringContaining("コミットが見つかりません"),
    });
  });

  it("改行を含む改名とバイナリを1件ずつ返す", async () => {
    const tree = (await f.worktree())._unsafeUnwrap();
    const name = "設計\nの改名.md";
    git(tree.path, "mv", "design.md", name);
    writeFileSync(join(tree.path, "binary.bin"), Buffer.from([0, 1, 2]));
    git(tree.path, "add", "binary.bin");
    git(tree.path, "commit", "-qm", "rename and binary");
    expect((await f.submit()).isOk()).toBe(true);
    expect((await read()).files).toEqual([
      { path: "binary.bin", status: "added", binary: true, hunks: [] },
      { path: name, status: "renamed", binary: false, hunks: [] },
    ]);
  });

  it("diffの設定にかかわらず空の共通行と元の行番号を返す", async () => {
    git(f.repository, "config", "diff.suppressBlankEmpty", "true");
    writeFileSync(join(f.repository, "design.md"), "first\n\nold\n\nlast\n");
    git(f.repository, "add", "design.md");
    git(f.repository, "commit", "-qm", "add blank context");
    const tree = (await f.worktree())._unsafeUnwrap();
    writeFileSync(join(tree.path, "design.md"), "first\n\nnew\n\nlast\n");
    git(tree.path, "add", "design.md");
    git(tree.path, "commit", "-qm", "edit design");
    expect((await f.submit()).isOk()).toBe(true);
    expect((await read()).files[0]?.hunks[0]?.lines).toEqual([
      { kind: "ctx", oldNo: 1, newNo: 1, text: "first" },
      { kind: "ctx", oldNo: 2, newNo: 2, text: "" },
      { kind: "del", oldNo: 3, newNo: null, text: "old" },
      { kind: "add", oldNo: null, newNo: 3, text: "new" },
      { kind: "ctx", oldNo: 4, newNo: 4, text: "" },
      { kind: "ctx", oldNo: 5, newNo: 5, text: "last" },
    ]);
  });

  it("Gitが引用しないUnicodeの区切り記号を含むパスをそのまま返す", async () => {
    git(f.repository, "config", "core.quotePath", "false");
    const tree = (await f.worktree())._unsafeUnwrap();
    const name = "設計\u2028資料.md";
    writeFileSync(join(tree.path, name), "sample\n");
    git(tree.path, "add", "--", name);
    git(tree.path, "commit", "-qm", "add unicode design");
    expect((await f.submit()).isOk()).toBe(true);
    expect((await read()).files).toEqual([
      {
        path: name,
        status: "added",
        binary: false,
        hunks: [
          {
            oldStart: 0,
            newStart: 1,
            oldLines: 0,
            newLines: 1,
            lines: [{ kind: "add", oldNo: null, newNo: 1, text: "sample" }],
          },
        ],
      },
    ]);
  });

  it("ファイルの種類の変更を1ファイルにまとめ、削除と追加の両方を返す", async () => {
    const tree = (await f.worktree())._unsafeUnwrap();
    unlinkSync(join(tree.path, "design.md"));
    symlinkSync("target.md", join(tree.path, "design.md"));
    git(tree.path, "add", ".");
    git(tree.path, "commit", "-qm", "a symlink");
    expect((await f.submit()).isOk()).toBe(true);
    expect((await read()).files).toEqual([
      expect.objectContaining({
        path: "design.md",
        status: "modified",
        binary: false,
        hunks: [
          {
            oldStart: 1,
            oldLines: 3,
            newStart: 0,
            newLines: 0,
            lines: [
              { kind: "del", oldNo: 1, newNo: null, text: "first" },
              { kind: "del", oldNo: 2, newNo: null, text: "old" },
              { kind: "del", oldNo: 3, newNo: null, text: "last" },
            ],
          },
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            lines: [{ kind: "add", oldNo: null, newNo: 1, text: "target.md" }],
          },
        ],
      }),
    ]);
  });

  it.each([
    { usesGithub: false, children: false },
    { usesGithub: true, children: true },
  ])(
    "直接承認で実装待ちにし GitHub $usesGithub の既定ブランチへ反映し片付ける",
    async ({ usesGithub, children }) => {
      f.options({ usesGithub });
      const tree = await f.prepare();
      if (children)
        f.db
          .insert(issues)
          .values({
            id: "child",
            projectId: "project",
            number: 43,
            title: "子",
            state: "design",
            parentId: "issue",
            createdAt: 1,
            updatedAt: 1,
          })
          .run();
      const response = await approve(tree.head);
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ status: "reflecting" });
      await expect.poll(() => f.events().at(-1)?.type).toBe("worktree_kept");
      expect(f.state()).toBe("ready");
      if (children) {
        const issue = (await (await f.request("/api/issues/issue")).json()) as {
          issue: { state: string; children: unknown[] };
        };
        expect(issue.issue).toMatchObject({
          state: "ready",
          children: [expect.objectContaining({ id: "child" })],
        });
      }
      expect(git(usesGithub ? f.remote : f.repository, "rev-parse", "refs/heads/main")).toBe(
        tree.head,
      );
      expect(existsSync(tree.path)).toBe(true);
      expect(git(f.repository, "rev-parse", tree.branch)).toBe(tree.head);
      expect(f.events().at(-1)?.payload).toMatchObject({ worktreeId: tree.id });
      expect(f.runner.runtime.store.get("design")).toMatchObject({
        cwd: tree.path,
        worktreeId: tree.id,
        sessionId: "design-session",
      });
      expect(await read()).toMatchObject({
        status: "approved",
        reflection: { mode: "direct", reflectedCommit: tree.head },
      });
    },
  );

  it("差分が無ければPR設定でも反映せず実装待ちになる", async () => {
    f.options({ usesGithub: true, designMergeMode: "pr" });
    const tree = await f.prepare(false);
    expect((await approve(tree.head)).status).toBe(202);
    await expect.poll(() => f.events().at(-1)?.type).toBe("worktree_kept");
    expect(git(f.remote, "rev-parse", "main")).toBe(tree.base);
    expect(git(f.remote, "branch", "--list", tree.branch)).toBe("");
    expect(await read()).toMatchObject({
      status: "approved",
      files: [],
      reflection: { mode: "none", prUrl: null, reflectedCommit: null },
    });
  });

  it("既定ブランチと同じ行の変更が競合すると反映を中止して失敗を返す", async () => {
    const tree = await f.prepare();
    writeFileSync(join(f.repository, "design.md"), "first\nincompatible\nlast\n");
    git(f.repository, "add", ".");
    git(f.repository, "commit", "-qm", "advance main");
    const main = git(f.repository, "rev-parse", "HEAD");
    expect((await approve(tree.head)).status).toBe(202);
    await expect.poll(() => f.events().at(-1)?.type).toBe("design_reflect_failed");
    expect(await read()).toMatchObject({
      state: "design_review",
      status: "reviewing",
      reflection: { failure: expect.stringContaining("design.md") },
    });
    expect(git(tree.path, "status", "--porcelain")).toBe("");
    expect(git(tree.path, "rev-parse", "HEAD")).toBe(tree.head);
    expect(git(f.repository, "rev-parse", "HEAD")).toBe(main);
  });

  it("表示後に設計ブランチが更新されると承認しない", async () => {
    const tree = await f.prepare();
    writeFileSync(join(tree.path, "design.md"), "別の版\n");
    git(tree.path, "add", ".");
    git(tree.path, "commit", "-qm", "new revision");
    const response = await approve(tree.head);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "conflict",
        message: "表示した後に設計が変わりました。読み直してから承認してください",
      },
    });
    expect(f.events().map(({ type }) => type)).toEqual(["state_changed", "design_submitted"]);
  });

  it("承認と差し戻しはランナーが無ければ503で記録しない", async () => {
    const tree = await f.prepare();
    const before = f.events();
    f.link.stop();
    for (const response of [await approve(tree.head), await reject("直してください")]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "runner_unavailable" } });
    }
    expect(f.events()).toEqual(before);
  });

  it("差し戻しの全文を元のセッションへ1回届けて設計待ちに戻す", async () => {
    const tree = await f.prepare();
    const empty = await reject("  ");
    expect(empty.status).toBe(400);
    const response = await f.link.call("POST", "/flow/issues/issue/design/reject", {
      text: "期限を設定から変えたい",
      attachment: "在庫のテストも追加する",
    });
    expect(response._unsafeUnwrap()).toEqual({ status: 202, body: { delivered_stock_ids: [] } });
    expect(f.state()).toBe("design");
    expect(f.runner.runtime.store.get("design")).toMatchObject({
      cwd: tree.path,
      sessionId: "design-session",
    });
    expect(
      f.runner.runtime.store.events("design").filter(({ type }) => type === "user_message"),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          text: "設計レビューで差し戻されました。次の指摘に沿って設計を直し、コミットしてから report_design で報告してください\n\n在庫のテストも追加する\n\n期限を設定から変えたい",
          origin: "developer",
        }),
      }),
    ]);
    expect(await read()).toMatchObject({
      state: "design",
      status: "designing",
      headCommit: tree.head,
    });
    expect((await reject("二度目")).status).toBe(409);
  });

  it.each([
    { title: "在庫", pr: 1, merged: true },
    { title: "在庫 未merge", pr: 2, merged: false },
  ])(
    "PR #$pr を作って同じ会話に依頼し、merge 済みかで結果を分ける",
    async ({ title, pr, merged }) => {
      f.options({ usesGithub: true, designMergeMode: "pr" });
      f.db.update(issues).set({ title }).where(eq(issues.id, "issue")).run();
      const tree = await f.prepare();
      const response = await approve(tree.head);
      expect(response.status).toBe(202);
      await f.runner.design.drain();
      expect(f.state()).toBe("design");
      const url = `https://github.com/example/design/pull/${pr}`;
      const originLookup = {
        args: ["repo", "view", "--json", "nameWithOwner,url", "--", f.remote],
        cwd: f.repository,
      };
      expect(f.ghCalls()).toEqual([
        originLookup,
        originLookup,
        {
          args: [
            "pr",
            "create",
            "--repo",
            "github.com/example/design",
            "--base",
            "main",
            "--head",
            tree.branch,
            "--title",
            `設計: #42 ${title}`,
            "--body-file",
            "-",
          ],
          cwd: f.repository,
          stdin: "## 修正方針\n\n在庫を先に確保する\n\n## AI が確かめたい点\n\n- 期限は30分?",
        },
        {
          args: [
            "pr",
            "view",
            url,
            "--json",
            "url,state,baseRefName,headRefName,headRefOid,isCrossRepository,headRepository,mergeCommit",
          ],
          cwd: f.repository,
        },
      ]);
      expect(git(f.remote, "rev-parse", `refs/heads/${tree.branch}`)).toBe(tree.head);
      expect(await read()).toMatchObject({
        status: "merging_pr",
        reflection: { mode: "pr", prUrl: url },
      });
      expect(
        f.runner.runtime.store.events("design").filter(({ type }) => type === "user_message"),
      ).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            origin: "flow",
            text: `設計書の PR ${url} は承認済みです。CI が通るのを待ち、リポジトリで許された方法で merge してください。設計書の中身は変えないでください。merge できないときは理由を書いて終えてください`,
          }),
        }),
      ]);
      expect(f.events().at(-1)).toMatchObject({
        type: "ai_started",
        payload: { kind: "design", conversationId: "design", reason: "design_pr_merge" },
      });
      await expect.poll(() => f.runner.runtime.store.get("design")?.runState).toBe("idle");
      expect(
        (await f.runner.design.completePr("issue", "CIの失敗で止まりました\n追加の説明")).isOk(),
      ).toBe(true);
      if (merged) {
        expect(f.state()).toBe("ready");
        expect(existsSync(tree.path)).toBe(true);
        expect(await read()).toMatchObject({
          status: "approved",
          reflection: { mode: "pr", prUrl: url, reflectedCommit: "a".repeat(40) },
        });
      } else {
        expect(f.events().at(-1)).toMatchObject({
          type: "state_changed",
          payload: {
            to: "stopped",
            stopReason: "failed",
            cause: "design_pr_not_merged",
            detail: "CIの失敗で止まりました",
          },
        });
        expect(existsSync(tree.path)).toBe(true);
        expect(await read()).toMatchObject({
          state: "stopped",
          status: "merge_failed",
          reflection: { mode: "pr", prUrl: url },
        });
      }
    },
  );

  it("自動処理の一時停止中はPRを作ってもmergeの指示を保留する", async () => {
    f.options({ usesGithub: true, designMergeMode: "pr", flowPaused: true });
    const tree = await f.prepare();
    expect((await approve(tree.head)).status).toBe(202);
    await f.runner.design.drain();
    expect(await read()).toMatchObject({ status: "merging_pr" });
    expect(f.runner.runtime.store.events("design")).toEqual([]);
    expect(f.events().filter(({ type }) => type === "ai_started")).toEqual([]);
  });

  it("最初の承認が反映中は二度目の承認と差し戻しを拒否する", async () => {
    const tree = await f.prepare();
    const entered = deferred();
    const release = deferred();
    f.interceptGit(async ([op]) => {
      if (op === "read-tree") {
        entered.resolve();
        await release.promise;
      }
    });
    try {
      expect((await approve(tree.head)).status).toBe(202);
      await entered.promise;
      expect(await read()).toMatchObject({ state: "design_review", status: "reflecting" });
      expect((await approve(tree.head)).status).toBe(409);
      expect((await reject("差し戻す")).status).toBe(409);
      const direct = await f.link.call("POST", "/flow/issues/issue/design/reject", {
        text: "差し戻す",
      });
      expect(direct._unsafeUnwrap().status).toBe(409);
      expect(f.events().filter(({ type }) => type === "design_approved")).toHaveLength(1);
    } finally {
      release.resolve();
    }
    await f.runner.design.drain();
    expect(f.state()).toBe("ready");
    expect(f.runner.runtime.store.events("design")).toEqual([]);
  });

  it("設計を報告した番がまだ動いていても、承認で実行を閉じてから作業場所を片付ける", async () => {
    f.runner.runtime.options.agent = new ScriptedAgent({ rules: [], fallback: [{ hold: true }] });
    const tree = (await f.worktree())._unsafeUnwrap();
    expect(
      (
        await f.runner.runtime.send("design", { text: "設計を作る", images: [], origin: "flow" })
      ).isOk(),
    ).toBe(true);
    await expect.poll(() => f.runner.runtime.store.get("design")?.runState).toBe("working");
    expect((await f.submit()).isOk()).toBe(true);
    expect((await approve(git(tree.path, "rev-parse", "HEAD"))).status).toBe(202);
    await f.runner.design.drain();
    expect(f.runner.runtime.executions.has("design")).toBe(false);
    expect(f.runner.runtime.store.get("design")).toMatchObject({
      cwd: tree.path,
      worktreeId: tree.id,
    });
    expect(existsSync(tree.path)).toBe(true);
  });

  it("作業場所が汚れている場合は変更なしの承認後も残す", async () => {
    const tree = await f.prepare(false);
    writeFileSync(join(tree.path, "uncommitted.md"), "未コミット");
    expect((await approve(tree.head)).status).toBe(202);
    await f.runner.design.drain();
    expect(f.state()).toBe("ready");
    expect(existsSync(join(tree.path, "uncommitted.md"))).toBe(true);
    expect(f.events().at(-1)).toMatchObject({
      type: "worktree_kept",
      payload: { uncommittedFiles: 1, unpushedCommits: 0 },
    });
  });

  it("取り下げが成功すると設計のworktreeを残したことを記録する", async () => {
    const tree = await f.prepare(false);
    const response = await f.request("/api/issues/issue/withdraw", "POST");
    expect(response.status).toBe(200);
    expect(f.state()).toBe("withdrawn");
    await f.runner.design.drain();
    expect(existsSync(tree.path)).toBe(true);
    expect(f.events().at(-1)).toMatchObject({
      type: "worktree_kept",
      payload: { worktreeId: tree.id, path: tree.path },
    });
  });

  it("設計のworktreeを作れなければ会話とissueに停止を記録する", async () => {
    git(f.repository, "branch", "-m", "renamed");
    const result = await f.worktree();
    expect(result.isErr()).toBe(true);
    expect(f.state()).toBe("stopped");
    expect(f.worktrees()).toEqual([expect.objectContaining({ removedAt: expect.any(Number) })]);
    expect(f.events().at(-1)).toMatchObject({
      type: "state_changed",
      payload: { to: "stopped", stopReason: "failed", cause: "worktree_failed" },
    });
    expect(f.runner.runtime.store.events("design")).toEqual([
      expect.objectContaining({
        type: "stopped",
        payload: {
          reason: "error",
          detail: expect.stringContaining("設計の worktree を作れませんでした"),
        },
      }),
    ]);
  });

  it("他者は承認経路に入れない", async () => {
    const tree = await f.prepare();
    const before = f.events();
    expect(
      (await f.request(`${path}/approve`, "POST", { headCommit: tree.head }, "198.51.100.3"))
        .status,
    ).toBe(401);
    expect(f.events()).toEqual(before);
  });
});
