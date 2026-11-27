import { z } from "zod";
const errorSchema = z.object({ error: z.object({ code: z.string() }) });
import { describe, it, expect } from "vite-plus/test";
import {
  prFixture,
  headSha,
  viewArgs,
  quote,
  reviewUrl,
  prUrl,
  reviewEndpoint,
} from "../pr-test-support";
import { prResponseSchema, publishResponseSchema } from "../../../../shared/api/pr";
import { runCommand } from "../../../../shared/command";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
describe("PR の API と SQLite・ランナー", () => {
  it("PR の取得を保存し、2 回目の失敗には保存した内容とエラーを返す", async () => {
    const f = prFixture();
    const first = await f.request();
    expect(first.status).toBe(200);
    const body = prResponseSchema.parse(await first.json());
    expect(body).toEqual({
      issueId: "i",
      source: "github",
      pr: {
        number: 128,
        title: "テスト",
        url: prUrl,
        state: "open",
        isDraft: false,
        headRefName: "impl",
        headSha,
        baseRefName: "main",
        mergeable: "mergeable",
        mergedAt: null,
      },
      checks: [],
      evidence: {
        markdown: "![画面](https://example.com/screen.png)",
        images: [{ alt: "画面", url: "https://example.com/screen.png" }],
      },
      files: [
        {
          path: "a.ts",
          status: "modified",
          binary: false,
          additions: 1,
          deletions: 1,
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] }],
        },
      ],
      local: null,
      diffTooLarge: false,
      earlierPrUrls: [],
      fetchedAt: 1000,
      fetchError: null,
      waitingMergeConfirm: true,
      implConversationId: "c",
      worktree: null,
      unsentInstructionCount: 0,
    });
    f.fail();
    const second = await f.request();
    expect([second.status, await second.json()]).toEqual([
      200,
      { ...body, fetchError: "GitHub から PR を取得できませんでした: GitHub is offline" },
    ]);
    expect(f.calls).toEqual([
      { args: viewArgs, cwd: f.home },
      { args: ["pr", "diff", prUrl], cwd: f.home },
      { args: viewArgs, cwd: f.home },
    ]);
  });
  it("保存した PR が無い取得の失敗は 502", async () => {
    const f = prFixture();
    f.fail();
    const r = await f.request();
    expect([r.status, await r.json()]).toEqual([
      502,
      {
        error: {
          code: "github_unavailable",
          message: "GitHub から PR を取得できませんでした: GitHub is offline",
        },
      },
    ]);
  });
  it("選択した指示だけを行と本文に分けて一件のレビューで送り、URLを保存してストックを残す", async () => {
    const f = prFixture();
    f.stock("right");
    f.stock("left", { quote: JSON.stringify(quote("old")), state: "sent" });
    f.stock("body", { quote: JSON.stringify({ kind: "terminal", mode: "line", text: "output" }) });
    f.stock("q", { kind: "question" });
    f.stock("done", { githubCommentUrl: "https://example.com/already" });
    f.stock("unselected");
    f.addConversation("other");
    f.stock("outside", { conversationId: "other" });
    const r = await f.request("/comments/publish", {
      stockIds: ["right", "left", "body", "q", "done", "outside"],
    });
    expect([r.status, await r.json()]).toEqual([
      200,
      {
        reviewUrl,
        published: [
          { stockId: "right", url: prUrl + "#discussion_r1", placement: "line" },
          { stockId: "left", url: prUrl + "#discussion_r2", placement: "line" },
          { stockId: "body", url: reviewUrl, placement: "body" },
        ],
        skipped: [
          { stockId: "q", reason: "question" },
          { stockId: "done", reason: "already_published" },
          { stockId: "outside", reason: "not_in_conversation" },
        ],
      },
    ]);
    expect(f.calls).toEqual([
      { args: viewArgs, cwd: f.home },
      { args: ["pr", "diff", prUrl], cwd: f.home },
      {
        args: ["api", reviewEndpoint, "--method", "POST", "--input", "-"],
        cwd: f.home,
        stdin: JSON.stringify({
          commit_id: headSha,
          event: "COMMENT",
          body: "> output\n\nbody",
          comments: [
            { path: "a.ts", line: 1, side: "RIGHT", body: "right" },
            { path: "a.ts", line: 1, side: "LEFT", body: "left" },
          ],
        }),
      },
      { args: ["api", reviewEndpoint + "/1/comments?per_page=100"], cwd: f.home },
    ]);
    expect(f.stockRows()).toEqual([
      { id: "body", state: "stocked", url: reviewUrl },
      { id: "done", state: "stocked", url: "https://example.com/already" },
      { id: "left", state: "sent", url: prUrl + "#discussion_r2" },
      { id: "outside", state: "stocked", url: null },
      { id: "q", state: "stocked", url: null },
      { id: "right", state: "stocked", url: prUrl + "#discussion_r1" },
      { id: "unselected", state: "stocked", url: null },
    ]);
  });
  it("行の拒否ならすべて本文にまとめて一回だけ投稿し直す", async () => {
    const f = prFixture();
    f.stock("line");
    f.stock("body", { quote: null });
    f.rejectLine();
    const r = await f.request("/comments/publish", { stockIds: ["line", "body"] });
    expect([r.status, await r.json()]).toEqual([
      200,
      {
        reviewUrl,
        published: [
          { stockId: "line", url: reviewUrl, placement: "body" },
          { stockId: "body", url: reviewUrl, placement: "body" },
        ],
        skipped: [],
      },
    ]);
    expect(f.calls.filter((c) => c.args.includes("POST"))).toEqual([
      {
        args: ["api", reviewEndpoint, "--method", "POST", "--input", "-"],
        cwd: f.home,
        stdin: JSON.stringify({
          commit_id: headSha,
          event: "COMMENT",
          body: "body",
          comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "line" }],
        }),
      },
      {
        args: ["api", reviewEndpoint, "--method", "POST", "--input", "-"],
        cwd: f.home,
        stdin: JSON.stringify({
          commit_id: headSha,
          event: "COMMENT",
          body: "> new\n\nline\n\n---\n\nbody",
          comments: [],
        }),
      },
    ]);
  });
  it("投稿の失敗はどの指示にも URL を記録せず再試行しない", async () => {
    const f = prFixture();
    f.stock("a");
    f.stock("b");
    f.rejectBody();
    const r = await f.request("/comments/publish", { stockIds: ["a", "b"] });
    expect([r.status, errorSchema.parse(await r.json()).error.code]).toEqual([
      502,
      "github_unavailable",
    ]);
    expect(f.calls.filter((c) => c.args.includes("POST")).length).toBe(1);
    expect(f.publishedUrls()).toEqual([{ url: null }, { url: null }]);
  });
  it("処理中の同じ指示は409、投稿済みは飛ばして外部へ送らない", async () => {
    const f = prFixture();
    f.stock("a");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    f.gate(gate);
    const first = f.request("/comments/publish", { stockIds: ["a"] });
    await expect.poll(() => f.calls.filter((c) => c.args.includes("POST")).length).toBe(1);
    const second = await f.request("/comments/publish", { stockIds: ["a"] });
    expect([second.status, errorSchema.parse(await second.json()).error.code]).toEqual([
      409,
      "conflict",
    ]);
    release();
    expect((await first).status).toBe(200);
    f.stock("b");
    const third = await f.request("/comments/publish", { stockIds: ["a", "b"] });
    expect(publishResponseSchema.parse(await third.json()).skipped).toEqual([
      { stockId: "a", reason: "already_published" },
    ]);
    expect(f.calls.filter((c) => c.args.includes("POST")).length).toBe(2);
  });
  it.each([[], Array(51).fill("a"), ["q"]])(
    "投稿できる指示や件数が不正なら400: %j",
    async (ids) => {
      const f = prFixture();
      f.stock("q", { kind: "question" });
      const r = await f.request("/comments/publish", { stockIds: ids });
      expect([r.status, errorSchema.parse(await r.json()).error.code]).toEqual([
        400,
        "invalid_input",
      ]);
      expect(f.calls.filter((c) => c.args.includes("POST"))).toEqual([]);
    },
  );
  it.each(["local", "absent", "MERGED", "CLOSED"])(
    "投稿できないプロジェクト/PRは409: %s",
    async (state) => {
      const f = prFixture();
      f.stock("a");
      if (state === "local") f.local();
      else if (state === "absent") f.issue({ prUrl: null });
      else f.setPr({ state });
      const r = await f.request("/comments/publish", { stockIds: ["a"] });
      expect([r.status, errorSchema.parse(await r.json()).error.code]).toEqual([409, "conflict"]);
      expect(f.calls.filter((c) => c.args.includes("POST"))).toEqual([]);
    },
  );
  it.each(["implementing", "done", "stopped-other", "MERGED", "CLOSED", "stale"])(
    "許可できない状態か古い版なら409: %s",
    async (state) => {
      const f = prFixture();
      if (state === "stale") {
      } else if (state === "MERGED" || state === "CLOSED") f.setPr({ state });
      else
        f.issue(
          state === "stopped-other"
            ? { stopReason: "failed" }
            : { state: state as "done" | "implementing", stopReason: null },
        );
      const r = await f.request("/allow-merge", {
        headSha: state === "stale" ? "b".repeat(40) : headSha,
      });
      expect([r.status, await r.json()]).toEqual([
        409,
        {
          error: {
            code: "conflict",
            message:
              state === "stale"
                ? "表示した後に変更が更新されました。読み直してから許可してください"
                : "issue の状態が変わりました。読み直してから操作してください。",
          },
        },
      ]);
      expect(f.eventRows()).toEqual([]);
    },
  );
  it.each(["gh", "runner"])("許可の %s 障害ではイベントを記録しない", async (target) => {
    const f = prFixture();
    if (target === "gh") f.fail();
    else f.runnerDown();
    const r = await f.request("/allow-merge", { headSha });
    expect([r.status, errorSchema.parse(await r.json()).error.code]).toEqual(
      target === "gh" ? [502, "github_unavailable"] : [503, "runner_unavailable"],
    );
    expect(f.eventRows()).toEqual([]);
  });
  it.each(["implementing", "stopped", "done", "ready"])(
    "MERGED の取得は実装に関係する状態だけnotifyする: %s",
    async (state) => {
      const f = prFixture();
      f.issue({ state: state as "implementing" | "stopped" | "done" | "ready" });
      if (state === "stopped")
        f.addEvent({
          issueId: "i",
          seq: 1,
          type: "state_changed",
          payload: {
            from: "implementing",
            to: "stopped",
            stopReason: "failed",
            cause: "agent_failed",
            detail: "failure",
          },
          createdAt: 1,
        });
      f.setPr({ state: "MERGED" });
      expect((await f.request()).status).toBe(200);
      expect(f.forwards).toEqual(
        ["implementing", "stopped"].includes(state)
          ? [{ method: "POST", path: "/flow/notify", input: { issue_id: "i" } }]
          : [],
      );
    },
  );
  it("GitHub が無いプロジェクトは本物のgitの差分と先頭を返し、その先頭で許可できる", async () => {
    const f = prFixture();
    f.local();
    const git = async (args: string[]) => {
      const r = await runCommand("git", args, { cwd: f.home });
      expect(r.exitCode).toBe(0);
      return r.stdout.trim();
    };
    await git(["init", "--initial-branch=main"]);
    await git(["init", "--bare", "remote.git"]);
    await git(["remote", "add", "origin", join(f.home, "remote.git")]);
    await git(["config", "user.name", "Fixture"]);
    await git(["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(join(f.home, "a.ts"), "old\n");
    await git(["add", "a.ts"]);
    await git(["commit", "-m", "base"]);
    await git(["push", "origin", "main"]);
    await git(["checkout", "-b", "impl"]);
    writeFileSync(join(f.home, "a.ts"), "new\n");
    await git(["commit", "-am", "change"]);
    const sha = await git(["rev-parse", "HEAD"]);
    f.addWorktree();
    const response = await f.request();
    const body = prResponseSchema.parse(await response.json());
    expect([body.source, body.local, body.files]).toEqual([
      "local",
      { branch: "impl", baseBranch: "main", headSha: sha },
      [
        {
          path: "a.ts",
          status: "modified",
          binary: false,
          additions: 1,
          deletions: 1,
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] }],
        },
      ],
    ]);
    const stale = await f.request("/allow-merge", { headSha });
    expect(stale.status).toBe(409);
    const allowed = await f.request("/allow-merge", { headSha: sha });
    expect([allowed.status, await allowed.json()]).toEqual([202, { state: "implementing" }]);
    expect(f.agent.sent).toEqual([
      {
        sessionId: "session",
        text: "merge を許可されました。merge の手順で既定ブランチへ入れてください",
      },
    ]);
    expect(f.calls).toEqual([]);
  });
  it("PR も実装ブランチも無ければ none と空の差分を返す", async () => {
    const f = prFixture();
    f.local();
    const r = await f.request();
    const b = prResponseSchema.parse(await r.json());
    expect([b.source, b.pr, b.files, b.local, f.calls]).toEqual(["none", null, [], null, []]);
  });
  it("GitHub の許可は202で記録と自動フローの指示を届け、二回目は409", async () => {
    const f = prFixture();
    const r = await f.request("/allow-merge", { headSha });
    expect([r.status, await r.json()]).toEqual([202, { state: "implementing" }]);
    expect(f.issueRows()).toEqual([{ state: "implementing", reason: null }]);
    expect(f.eventRows().map(({ type, payload }) => ({ type, payload }))).toEqual([
      { type: "merge_allowed", payload: { headSha } },
      {
        type: "state_changed",
        payload: {
          from: "stopped",
          to: "implementing",
          stopReason: null,
          detail: null,
          cause: "merge_allowed",
        },
      },
      { type: "stage_changed", payload: { stage: "ci" } },
    ]);
    expect(f.userMessages()).toEqual([
      {
        type: "user_message",
        payload: {
          text: "merge を許可されました。merge の手順で CI を待って merge してください",
          images: [],
          origin: "flow",
          client_ids: [],
          queued_ids: [],
          client_receipts: [],
        },
      },
    ]);
    expect(f.agent.sent).toEqual([
      {
        sessionId: "session",
        text: "merge を許可されました。merge の手順で CI を待って merge してください",
      },
    ]);
    const again = await f.request("/allow-merge", { headSha });
    expect([again.status, errorSchema.parse(await again.json()).error.code]).toEqual([
      409,
      "conflict",
    ]);
  });
});

it("行コメントのURLはGitHubの返却順に依存せず選んだ指示に対応する", async () => {
  const f = prFixture();
  f.stock("right");
  f.stock("left", { quote: JSON.stringify(quote("old")) });
  f.reverseComments();
  const r = await f.request("/comments/publish", { stockIds: ["right", "left"] });
  expect([r.status, await r.json()]).toEqual([
    200,
    {
      reviewUrl,
      published: [
        { stockId: "right", url: prUrl + "#discussion_r1", placement: "line" },
        { stockId: "left", url: prUrl + "#discussion_r2", placement: "line" },
      ],
      skipped: [],
    },
  ]);
});
it("複数行の引用は開始側と終了側を行コメントに写し、消えた行は引用付きの本文に入れる", async () => {
  const f = prFixture();
  f.stock("range", {
    quote: JSON.stringify({
      ...quote("old"),
      start: { side: "old", line: 1, col: 0 },
      end: { side: "new", line: 2, col: 3 },
    }),
  });
  f.stock("gone", { quote: JSON.stringify({ ...quote(), commit: "b".repeat(40), text: "gone" }) });
  const r = await f.request("/comments/publish", { stockIds: ["range", "gone"] });
  expect(r.status).toBe(200);
  expect(f.calls.filter((c) => c.args.includes("POST"))).toEqual([
    {
      args: ["api", reviewEndpoint, "--method", "POST", "--input", "-"],
      cwd: f.home,
      stdin: JSON.stringify({
        commit_id: headSha,
        event: "COMMENT",
        body: "> gone\n\ngone",
        comments: [
          {
            path: "a.ts",
            line: 2,
            side: "RIGHT",
            body: "range",
            start_line: 1,
            start_side: "LEFT",
          },
        ],
      }),
    },
  ]);
});
it("差分が大きすぎる時はファイル一覧を返すが通常の取得障害は502にする", async () => {
  const f = prFixture();
  f.commandFailure("pr diff", {
    stdout: "",
    stderr: "diff exceeded the maximum number of lines",
    exitCode: 1,
  });
  const r = await f.request();
  const b = prResponseSchema.parse(await r.json());
  expect([r.status, b.files, b.diffTooLarge]).toEqual([
    200,
    [{ path: "a.ts", status: "modified", binary: false, additions: 1, deletions: 1, hunks: [] }],
    true,
  ]);
});
it("認証されていないghからはログイン方法を返す", async () => {
  const f = prFixture();
  f.commandFailure("pr view", {
    stdout: "",
    stderr: "To get started with GitHub CLI, please run: gh auth login",
    exitCode: 1,
  });
  const r = await f.request();
  expect([r.status, await r.json()]).toEqual([
    502,
    {
      error: {
        code: "github_unavailable",
        message: "gh にログインしていません。ターミナルで gh auth login を実行してください",
      },
    },
  ]);
});
it("PRのURLが変更された時は前のPRの保存内容を使わない", async () => {
  const f = prFixture();
  expect((await f.request()).status).toBe(200);
  f.issue({ prUrl: "https://github.com/example/review-fixture/pull/129" });
  f.fail();
  const r = await f.request();
  expect([r.status, errorSchema.parse(await r.json()).error.code]).toEqual([
    502,
    "github_unavailable",
  ]);
});
it("同じ指示を重複選択しても一件だけ投稿する", async () => {
  const f = prFixture();
  f.stock("right");
  const r = await f.request("/comments/publish", { stockIds: ["right", "right"] });
  expect([r.status, await r.json()]).toEqual([
    200,
    {
      reviewUrl,
      published: [{ stockId: "right", url: prUrl + "#discussion_r1", placement: "line" }],
      skipped: [],
    },
  ]);
});
it.each(["stocked", "sent", "cancelled"] as const)(
  "%s の指示の投稿可否を状態で決める",
  async (state) => {
    const f = prFixture();
    f.stock("selected", { state });
    const r = await f.request("/comments/publish", { stockIds: ["selected"] });
    expect([r.status, await r.json()]).toEqual(
      state === "cancelled"
        ? [400, { error: { code: "invalid_input", message: "投稿できる指示を選んでください。" } }]
        : [
            200,
            {
              reviewUrl,
              published: [{ stockId: "selected", url: reviewUrl, placement: "line" }],
              skipped: [],
            },
          ],
    );
    expect(f.calls.filter((c) => c.args.includes("POST"))).toEqual(
      state === "cancelled"
        ? []
        : [
            {
              args: ["api", reviewEndpoint, "--method", "POST", "--input", "-"],
              cwd: f.home,
              stdin: JSON.stringify({
                commit_id: headSha,
                event: "COMMENT",
                body: "",
                comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "selected" }],
              }),
            },
          ],
    );
    expect(f.stockRows()).toEqual([
      { id: "selected", state, url: state === "cancelled" ? null : reviewUrl },
    ]);
  },
);
it("取り消した指示と有効な指示を選ぶと有効な指示だけを一度投稿する", async () => {
  const f = prFixture();
  f.stock("cancelled", { state: "cancelled" });
  f.stock("right");
  const r = await f.request("/comments/publish", { stockIds: ["cancelled", "right"] });
  expect([r.status, await r.json()]).toEqual([
    200,
    {
      reviewUrl,
      published: [{ stockId: "right", url: prUrl + "#discussion_r1", placement: "line" }],
      skipped: [{ stockId: "cancelled", reason: "not_in_conversation" }],
    },
  ]);
  expect(f.calls.filter((c) => c.args.includes("POST"))).toEqual([
    {
      args: ["api", reviewEndpoint, "--method", "POST", "--input", "-"],
      cwd: f.home,
      stdin: JSON.stringify({
        commit_id: headSha,
        event: "COMMENT",
        body: "",
        comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "right" }],
      }),
    },
  ]);
  expect(f.stockRows()).toEqual([
    { id: "cancelled", state: "cancelled", url: null },
    { id: "right", state: "stocked", url: prUrl + "#discussion_r1" },
  ]);
});
it.each(
  (["old", "new"] as const).flatMap((startSide) =>
    (["old", "new"] as const).flatMap((endSide) =>
      [1, 2].map((endLine) => ({ startSide, endSide, endLine })),
    ),
  ),
)(
  "引用の開始 $startSide:1 と終了 $endSide:$endLine を行コメントへ写す",
  async ({ startSide, endSide, endLine }) => {
    const f = prFixture();
    f.stock("range", {
      quote: JSON.stringify({ ...quote(startSide), end: { side: endSide, line: endLine, col: 3 } }),
    });
    const r = await f.request("/comments/publish", { stockIds: ["range"] });
    expect(r.status).toBe(200);
    expect(f.calls.filter((c) => c.args.includes("POST"))).toEqual([
      {
        args: ["api", reviewEndpoint, "--method", "POST", "--input", "-"],
        cwd: f.home,
        stdin: JSON.stringify({
          commit_id: headSha,
          event: "COMMENT",
          body: "",
          comments: [
            {
              path: "a.ts",
              line: endLine,
              side: endSide === "old" ? "LEFT" : "RIGHT",
              body: "range",
              ...(startSide !== endSide || endLine !== 1
                ? { start_line: 1, start_side: startSide === "old" ? "LEFT" : "RIGHT" }
                : {}),
            },
          ],
        }),
      },
    ]);
  },
);
it("同じ番号で側をまたぐ引用を拒否された時も引用全体を本文に残して一度だけ投稿し直す", async () => {
  const f = prFixture();
  f.stock("range", {
    quote: JSON.stringify({
      ...quote("old"),
      text: "old\nnew",
      end: { side: "new", line: 1, col: 3 },
    }),
  });
  f.rejectLine();
  const r = await f.request("/comments/publish", { stockIds: ["range"] });
  expect(r.status).toBe(200);
  expect(f.calls.filter((c) => c.args.includes("POST"))).toEqual([
    {
      args: ["api", reviewEndpoint, "--method", "POST", "--input", "-"],
      cwd: f.home,
      stdin: JSON.stringify({
        commit_id: headSha,
        event: "COMMENT",
        body: "",
        comments: [
          {
            path: "a.ts",
            line: 1,
            side: "RIGHT",
            body: "range",
            start_line: 1,
            start_side: "LEFT",
          },
        ],
      }),
    },
    {
      args: ["api", reviewEndpoint, "--method", "POST", "--input", "-"],
      cwd: f.home,
      stdin: JSON.stringify({
        commit_id: headSha,
        event: "COMMENT",
        body: "> old\n> new\n\nrange",
        comments: [],
      }),
    },
  ]);
});
it("投稿済みURLの保存は全件をまとめ、保存失敗なら一件目も戻す", async () => {
  const f = prFixture();
  f.stock("right");
  f.stock("left", { quote: JSON.stringify(quote("old")) });
  f.database.sqlite.exec(
    "CREATE TRIGGER fail_publish BEFORE UPDATE OF github_comment_url ON stock_items WHEN NEW.id='left' BEGIN SELECT RAISE(ABORT,'reject second'); END",
  );
  const callsInTransaction: boolean[] = [];
  const github = f.deps.github;
  f.deps.github = {
    ...github,
    read: (...args) => {
      callsInTransaction.push(f.database.sqlite.inTransaction);
      return github.read(...args);
    },
    review: (...args) => {
      callsInTransaction.push(f.database.sqlite.inTransaction);
      return github.review(...args);
    },
  };
  const r = await f.request("/comments/publish", { stockIds: ["right", "left"] });
  expect([r.status, await r.json()]).toEqual([
    500,
    { error: { code: "internal", message: "PR の操作に失敗しました。もう一度操作してください。" } },
  ]);
  expect(f.stockRows()).toEqual([
    { id: "left", state: "stocked", url: null },
    { id: "right", state: "stocked", url: null },
  ]);
  expect(callsInTransaction).toEqual([false, false]);
});
