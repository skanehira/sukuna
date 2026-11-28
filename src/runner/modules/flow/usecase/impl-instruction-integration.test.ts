import { existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import {
  previousPr,
  newPr,
  prepareGit,
  issue,
  implementation,
  request,
  uploadImage,
  send,
  messages,
  tool,
  github,
  startImplementation,
  waitIdle,
  ready,
  merged,
  events,
  useAgent,
  addStock,
  failNextAgentOpen,
  sendStock,
  threadOf,
  draft,
  addParent,
  parent,
  parentEvents,
  sameIssueConversations,
  git,
} from "../impl-instruction-test-support";

it("merge 確認中の実装で質問を先に送っても停止を保ち、指示でだけ戻って再確認する", async () => {
  const path = prepareGit(true);
  const head = git(path, "rev-parse", "HEAD");
  github(head, "sukuna/issue-42");
  useAgent({
    rules: [
      { match: "^#42", steps: [{ text: "色を変更しました。" }, ready(head), { end: "success" }] },
      { match: "^祝日の色を直す$", steps: [ready(head), { end: "success" }] },
    ],
    fallback: [{ hold: true }],
  });
  await startImplementation(true);
  await waitIdle("merge_confirm");
  const c = implementation();
  const before = events().filter(({ type }) => type === "state_changed");
  addStock(c.id, "question", "なぜこの色ですか");
  const asked = await sendStock(c.id, "questions");
  expect(asked.status, await asked.text()).toBe(200);
  expect(threadOf(c.id)?.kind).toBe("thread");
  expect(events().filter(({ type }) => type === "state_changed")).toEqual(before);
  expect((await send("祝日の色を直す")).status).toBe(202);
  await expect.poll(() => events().filter(({ type }) => type === "ready_for_merge").length).toBe(2);
  await waitIdle("merge_confirm");
  expect(issue().confirmBeforeMerge).toBe(true);
  expect(implementation().worktreeId).toBe(c.worktreeId);
  expect(messages().at(-1)).toMatchObject({ origin: "developer", text: "祝日の色を直す" });
  expect(
    events()
      .filter(({ type }) => type === "state_changed")
      .slice(-2)
      .map(({ payload }) => payload),
  ).toMatchObject([
    { to: "implementing", cause: "impl_instruction" },
    { to: "stopped", stopReason: "merge_confirm" },
  ]);
});

it("許可後の CI 失敗に指示を送ると、同じ PR の rebase 報告にも再確認する", async () => {
  const path = prepareGit(true);
  const head = git(path, "rev-parse", "HEAD");
  github(head, "sukuna/issue-42");
  useAgent({
    rules: [
      { match: "^#42", steps: [ready(head), { end: "success" }] },
      {
        match: "merge を許可",
        steps: [
          tool("report_ci_failed", {
            number: 42,
            checks: [{ name: "検査", bucket: "fail" }],
            timed_out: false,
            summary: "CI 失敗",
          }),
          { end: "success" },
        ],
      },
      {
        match: "^CI を確かめ直す$",
        steps: [
          tool("report_ready_for_merge", {
            number: 42,
            pr_url: previousPr,
            head_sha: head,
            rebased: true,
            summary: "確認",
          }),
          { end: "success" },
        ],
      },
    ],
    fallback: [{ hold: true }],
  });
  await startImplementation(true);
  await waitIdle("merge_confirm");
  expect((await request("/api/issues/i/pr/allow-merge", "POST", { headSha: head })).status).toBe(
    202,
  );
  await waitIdle("ci_failed");
  expect((await send("CI を確かめ直す")).status).toBe(202);
  await waitIdle("merge_confirm");
  expect(events().filter(({ type }) => type === "ready_for_merge")).toHaveLength(2);
  expect(issue().confirmBeforeMerge).toBe(true);
});

it("CI 失敗の止まった会話へ指示を送ると実装中に戻り、作業中の次の指示は預ける", async () => {
  const path = prepareGit();
  const head = git(path, "rev-parse", "HEAD");
  useAgent({
    rules: [
      {
        match: "^#42",
        steps: [
          tool("report_ci_failed", {
            number: 42,
            checks: [{ name: "検査", bucket: "fail" }],
            timed_out: false,
            summary: "失敗",
          }),
          { end: "success" },
        ],
      },
    ],
    fallback: [{ hold: true }],
  });
  await startImplementation();
  await waitIdle("ci_failed");
  addStock(implementation().id, "instruction", "CI の失敗を直す", head);
  const delivered = await sendStock(implementation().id, "instructions");
  expect(delivered.status).toBe(200);
  expect(await delivered.json()).toMatchObject({
    instructions: { count: 1, delivery: "delivered" },
  });
  expect(issue().state).toBe("implementing");
  expect(implementation().runState).toBe("working");
  const queued = await send("終了後にログも直す", "next");
  expect(queued.status).toBe(202);
  expect(await queued.json()).toMatchObject({
    result: "queued",
    queueItem: { text: "終了後にログも直す" },
  });
  expect(messages().at(-1)).toMatchObject({
    origin: "stock",
    text: expect.stringContaining("CI の失敗を直す"),
  });
  expect(messages().at(-1)?.text).toContain("calendar.ts");
});

it("確認の報告を終える前に届いた修正指示は預け、旧版への許可を受け付けない", async () => {
  const path = prepareGit(true);
  const head = git(path, "rev-parse", "HEAD");
  github(head, "sukuna/issue-42");
  useAgent({ rules: [{ match: "^#42", steps: [ready(head), { hold: true }] }] });
  await startImplementation(true);
  await expect.poll(() => issue().stopReason).toBe("merge_confirm");
  expect(implementation().runState).toBe("working");
  const queued = await send("確認前に修正してください");
  expect(queued.status).toBe(202);
  expect(await queued.json()).toMatchObject({
    result: "queued",
    queueItem: { text: "確認前に修正してください" },
  });
  expect(issue()).toMatchObject({ state: "implementing", confirmBeforeMerge: true });
  expect((await request("/api/issues/i/pr/allow-merge", "POST", { headSha: head })).status).toBe(
    409,
  );
});

it.each([
  { source: "message", report: "ready_for_merge", reason: "merge_confirm" },
  { source: "stock", report: "ci_failed", reason: "ci_failed" },
] as const)(
  "修正を $source で預けた旧番の $report を拒み、配達した番の報告でだけ止まる",
  async ({ source, report, reason }) => {
    const path = prepareGit(true);
    const head = git(path, "rev-parse", "HEAD");
    github(head, "sukuna/issue-42");
    const gate = join(path, "release-old-revision");
    const update = (summary: string) =>
      report === "ready_for_merge"
        ? tool("report_ready_for_merge", {
            number: 42,
            pr_url: previousPr,
            head_sha: head,
            summary,
          })
        : tool("report_ci_failed", {
            number: 42,
            checks: [{ name: "build", bucket: "fail" }],
            timed_out: false,
            summary,
          });
    useAgent({
      rules: [
        {
          match: "^#42",
          steps: [
            { text: "修正を受け付ける見通しです" },
            ready(head),
            {
              shell: `for attempt in $(seq 1 250); do test -f '${gate}' && exit 0; sleep 0.02; done; exit 1`,
            },
            update("旧番からの報告"),
            { end: "success" },
          ],
        },
        { match: "祝日の色を直す", steps: [update("配達後の報告"), { end: "success" }] },
      ],
      fallback: [{ hold: true }],
    });
    await startImplementation(true);
    await expect.poll(() => issue().stopReason).toBe("merge_confirm");
    const active = implementation();
    expect(active.runState).toBe("working");
    const delivered = messages();
    if (source === "stock") {
      addStock(active.id, "instruction", "祝日の色を直す", head);
      const response = await sendStock(active.id, "instructions");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ instructions: { delivery: "queued" } });
    } else {
      const response = await send("祝日の色を直す");
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ result: "queued" });
    }
    expect(issue().state).toBe("implementing");
    expect(messages()).toEqual(delivered);
    writeFileSync(gate, "");
    await waitIdle(reason);
    expect(messages()).toHaveLength(delivered.length + 1);
    expect(messages().at(-1)?.text).toContain("祝日の色を直す");
    const reported = events().filter(({ type }) => type === report);
    expect(reported).toHaveLength(report === "ready_for_merge" ? 2 : 1);
    expect(reported.at(-1)?.payload).toMatchObject({ summary: "配達後の報告" });
    expect(implementation().worktreeId).toBe(active.worktreeId);
  },
);

it("画面の merge 許可から実装会話が完了し、同じ会話へ指示すると別の PR になる", async () => {
  const path = prepareGit(true);
  const head = git(path, "rev-parse", "HEAD");
  const setPr = github(head, "sukuna/issue-42", true);
  useAgent({
    rules: [
      { match: "^#42", steps: [ready(head), { end: "success" }] },
      { match: "merge を許可", steps: [merged(head, previousPr), { end: "success" }] },
      { match: "^この issue の PR", steps: [ready(head, newPr), { end: "success" }] },
    ],
    fallback: [{ hold: true }],
  });
  await startImplementation(true);
  await waitIdle("merge_confirm");
  const old = implementation();
  const allowed = await request("/api/issues/i/pr/allow-merge", "POST", { headSha: head });
  expect(allowed.status).toBe(202);
  await waitIdle();
  expect(events().some(({ type }) => type === "merge_allowed")).toBe(true);
  setPr("OPEN", "sukuna/issue-42-2");
  const sent = await send("休日の表示を直す");
  expect(sent.status).toBe(202);
  expect(implementation().id).toBe(old.id);
  expect(implementation().worktreeId).not.toBe(old.worktreeId);
  expect(implementation().cwd).toBe(join(path, ".claude/worktrees/issue-42-2"));
  expect(issue().closedAt).toBeNull();
  expect(events().find(({ type }) => type === "reopened_for_fix")?.payload).toEqual({
    previousPrUrl: previousPr,
  });
  expect(messages().at(-1)).toMatchObject({
    text: `この issue の PR ${previousPr} は merge 済みです。既定ブランチの最新から作った worktree で、新しい PR を作って次の点を直してください\n\n休日の表示を直す`,
    origin: "developer",
  });
  await waitIdle("merge_confirm");
  expect(issue().prUrl).toBe(newPr);
  const response = await request("/api/issues/i/pr");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ earlierPrUrls: [previousPr], pr: { url: newPr } });
});

it("完了した実装に存在しない添付を送っても書きかけと完了のまま残す", async () => {
  const path = prepareGit();
  const head = git(path, "rev-parse", "HEAD");
  useAgent({ rules: [{ match: "^#42", steps: [merged(head), { end: "success" }] }] });
  await startImplementation();
  await waitIdle();
  const c = implementation();
  const before = { issue: issue(), events: events(), messages: messages() };
  const text = "修正したい内容";
  expect(
    (
      await request(`/api/conversations/${c.id}/draft`, "PUT", {
        text,
        images: [],
        clientId: "review",
        editedAt: 1_000_000,
      })
    ).status,
  ).toBe(200);
  const response = await request(`/api/conversations/${c.id}/messages`, "POST", {
    text,
    images: ["missing-attachment"],
    mode: "send",
    clientMessageId: "missing-image",
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "invalid_input" } });
  expect(issue()).toEqual(before.issue);
  expect(events()).toEqual(before.events);
  expect(messages()).toEqual(before.messages);
  expect(draft(c.id)).toMatchObject({ text });
  expect(existsSync(join(path, ".claude/worktrees/issue-42-2"))).toBe(false);

  const image = await uploadImage(c.id);
  const sent = await request(`/api/conversations/${c.id}/messages`, "POST", {
    text,
    images: [image],
    mode: "send",
    clientMessageId: "valid-image",
  });
  expect(sent.status).toBe(202);
  expect(messages()).toHaveLength(before.messages.length + 1);
  expect(messages().at(-1)).toMatchObject({
    text: `${localPrefix}\n\n${text}`,
    images: [{ path: `images/${c.id}/${image}.png`, media_type: "image/png" }],
  });
});

const localPrefix =
  "この issue の変更は既定ブランチに入っています。既定ブランチの最新から作った worktree で、次の点を直してください";

it.each(["message", "resume"] as const)(
  "完了後の作業場所が作れなければ書きかけを残し、%s で作り直す",
  async (mode) => {
    const path = prepareGit();
    const head = git(path, "rev-parse", "HEAD");
    useAgent({
      rules: [{ match: "^#42", steps: [merged(head), { end: "success" }] }],
      fallback: [{ hold: true }],
    });
    await startImplementation();
    await waitIdle();
    const c = implementation();
    const blocked = join(path, ".claude/worktrees/issue-42-2");
    writeFileSync(blocked, "使用中");
    const text = "予約時刻を直す";
    const savedDraft = await request(`/api/conversations/${c.id}/draft`, "PUT", {
      text,
      images: [],
      clientId: "review",
      editedAt: 1_000_000,
    });
    expect(savedDraft.status).toBe(200);
    const before = messages();
    const failed = await send(text);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: { code: "worktree_failed" } });
    expect(issue()).toMatchObject({ state: "stopped", stopReason: "failed", closedAt: null });
    expect(events().find(({ type }) => type === "reopened_for_fix")?.payload).toEqual({
      previousPrUrl: null,
    });
    expect(messages()).toEqual(before);
    expect(draft(c.id)).toMatchObject({ text });
    rmSync(blocked);
    const success =
      mode === "message"
        ? await send(text)
        : await request(`/api/conversations/${c.id}/resume`, "POST");
    expect(success.status).toBe(202);
    expect(issue().state).toBe("implementing");
    expect(implementation().cwd).toBe(blocked);
    expect(messages().at(-1)).toMatchObject(
      mode === "message"
        ? { origin: "developer", text: `${localPrefix}\n\n${text}` }
        : { origin: "flow", text: localPrefix },
    );
    expect(events().filter(({ type }) => type === "reopened_for_fix")).toHaveLength(1);
  },
);

it("完了した子へ修正の指示を送れば完了した親が実装待ちに戻る", async () => {
  const path = prepareGit();
  const head = git(path, "rev-parse", "HEAD");
  addParent();
  useAgent({
    rules: [{ match: "^#42", steps: [merged(head), { end: "success" }] }],
    fallback: [{ hold: true }],
  });
  await startImplementation(false, "parent");
  await waitIdle();
  const parentState = () => parent().state;
  await expect.poll(parentState).toBe("done");
  expect((await send("実装を直す")).status).toBe(202);
  await expect.poll(parentState).toBe("ready");
  expect(parentEvents().at(-1)?.payload).toMatchObject({ cause: "child_reopened" });
  expect(sameIssueConversations()).toHaveLength(1);
});

it("用意した worktree で AI を開けなければ、次の指示も同じ作業場所と前置きで届ける", async () => {
  const path = prepareGit();
  const head = git(path, "rev-parse", "HEAD");
  useAgent({
    rules: [{ match: "^#42", steps: [merged(head), { end: "success" }] }],
    fallback: [{ hold: true }],
  });
  await startImplementation();
  await waitIdle();
  const before = messages();
  failNextAgentOpen();
  const failure = await send("休日の表示を直す");
  expect(failure.status).toBe(500);
  expect(issue()).toMatchObject({ state: "stopped", stopReason: "failed" });
  expect(messages()).toEqual(before);
  expect((await send("休日の表示を直す")).status).toBe(202);
  expect(implementation().cwd).toBe(join(path, ".claude/worktrees/issue-42-2"));
  expect(messages().at(-1)).toMatchObject({
    text: `${localPrefix}\n\n休日の表示を直す`,
    origin: "developer",
  });
  expect(events().filter(({ type }) => type === "reopened_for_fix")).toHaveLength(1);
});
