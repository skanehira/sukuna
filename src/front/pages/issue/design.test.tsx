import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { expect, it, vi } from "vite-plus/test";
import { emptyDesignRejection, type DesignResponse } from "../../../shared/api/design";
import { BufferController } from "../../buffer/controller";
import { Layout } from "../../buffer/Layout";
import { createConversationApi } from "../../lib/conversation/api";
import { stockMarks } from "../../lib/stock/marks";
import { createStockApi } from "../../lib/stock/api";
import { createStockWorkspace } from "../../lib/stock/workspace";
import { designSource, makeQuote } from "../../lib/stock/quote";
import type { DesignApi } from "./design-api";
import { approvalConfirmation, designLines } from "./design-lines";
import { DesignView } from "./design-view";

const design: DesignResponse = {
  issueId: "issue",
  state: "design_review",
  status: "reviewing",
  policy: "在庫を先に確保する。\n期限は 30 分。",
  checks: ["期限はよいですか?"],
  files: [
    {
      path: "docs/stock.md",
      status: "modified",
      binary: false,
      hunks: [
        {
          oldStart: 7,
          newStart: 8,
          oldLines: 1,
          newLines: 1,
          lines: [
            { kind: "del", text: "出荷時に減らす", oldNo: 7, newNo: null },
            { kind: "add", text: "予約時に確保する", oldNo: null, newNo: 8 },
          ],
        },
      ],
    },
  ],
  reflection: { mode: "direct", failure: null, prUrl: null, reflectedCommit: null },
  designConversationId: "design",
  submittedAt: 123,
  headCommit: "a".repeat(40),
  unsentInstructionCount: 0,
};

it("方針と確かめたい点、変更前後のファイルの行を表示する", () => {
  expect(designLines(design)).toEqual([
    { kind: "heading", text: "修正方針" },
    { kind: "text", text: "在庫を先に確保する。" },
    { kind: "text", text: "期限は 30 分。" },
    { kind: "heading", text: "AI が確かめたい点  1 件" },
    { kind: "text", text: "期限はよいですか?" },
    {
      kind: "heading",
      text: "設計書の差分  docs/stock.md",
      id: "design-file:docs/stock.md",
      designDiff: { path: "docs/stock.md" },
    },
    {
      kind: "del",
      text: "出荷時に減らす",
      lineNumber: 7,
      designDiff: { path: "docs/stock.md", newNo: 8, row: { side: "old", line: 7 } },
    },
    {
      kind: "add",
      text: "予約時に確保する",
      lineNumber: 8,
      designDiff: { path: "docs/stock.md", newNo: 8, row: { side: "new", line: 8 } },
    },
    { kind: "heading", text: "操作" },
    { kind: "menu", text: "承認して実装へ進める", action: "design.approve" },
    { kind: "menu", text: "指摘を書いて差し戻す", action: "design.reject" },
  ]);
});

it("変更がなければ空である理由を出し、差分の読み取り失敗はその文を表示する", () => {
  expect(designLines({ ...design, checks: [], files: [] }).map(({ text }) => text)).toEqual(
    expect.arrayContaining([
      "AI が確かめたい点  0 件",
      "ありません",
      "設計書の変更はありません。承認すると、何も反映せずに実装待ちになります",
    ]),
  );
  const diffError =
    "設計のコミットが見つかりません。差し戻して、AI に設計の完了を報告し直させてください";
  expect(designLines({ ...design, files: [], diffError }).map(({ text }) => text)).toContain(
    diffError,
  );
});

it.each([
  { status: "none", front: "設計はまだありません。設計の AI が作ると、ここに出ます" },
  { status: "designing", front: "設計を直しています" },
  { status: "reviewing", front: "修正方針" },
  { status: "reflecting", front: "設計書を既定ブランチへ反映しています" },
  {
    status: "merging_pr",
    front:
      "承認済み。設計書の PR https://github.com/example/design/pull/1 の CI を待って、AI が merge します",
  },
  {
    status: "merge_failed",
    front:
      "設計書の PR https://github.com/example/design/pull/1 を merge できませんでした: CI に失敗。設計の会話で指示を送ると、AI が merge を続けます",
  },
  {
    status: "approved",
    front: "承認済み (PR https://github.com/example/design/pull/1 で反映したコミット bbbbbbb)",
  },
] as const)("$status の先頭の案内と操作", ({ status, front }) => {
  const lines = designLines({
    ...design,
    status,
    reflection: {
      mode: "pr",
      prUrl: "https://github.com/example/design/pull/1",
      reflectedCommit: "b".repeat(40),
      failure: status === "merge_failed" ? "CI に失敗" : null,
    },
  });
  expect(lines[0].text).toBe(front);
  expect(lines.filter(({ kind }) => kind === "menu")).toHaveLength(status === "reviewing" ? 2 : 0);
});

it("バイナリの差分にはファイルパスと表示できない理由を出す", () => {
  const file = { ...design.files[0], binary: true };
  expect(
    designLines({ ...design, files: [file] })
      .map(({ text }) => text)
      .slice(5, 7),
  ).toEqual(["設計書の差分  docs/stock.md", "バイナリのため差分を出しません"]);
});

it("承認するときに送っていない指示の件数を添える", () => {
  expect(approvalConfirmation(0)).toBe("設計を承認して、実装へ進めますか?");
  expect(approvalConfirmation(2)).toBe(
    "設計を承認して、実装へ進めますか? 送っていない指示が 2 件あります。承認しても送られずに残ります",
  );
});

it("同じ変更後の行に位置する削除行と追加行をどちらも引用する", () => {
  const lines = designLines(design);
  expect(
    makeQuote(
      designSource("docs/stock.md", lines),
      lines.map(({ text }) => text),
      {
        mode: "line",
        ranges: [
          { line: 6, from: 0, to: 8 },
          { line: 7, from: 0, to: 9 },
        ],
      },
    ),
  ).toEqual({
    kind: "design_diff",
    path: "docs/stock.md",
    text: "出荷時に減らす\n予約時に確保する",
    mode: "line",
    start: { line: 8, col: 0, row: { side: "old", line: 7 } },
    end: { line: 8, col: 8, row: { side: "new", line: 8 } },
  });
});

it("共通の一文字の引用も、実際に選んだ追加行に印を付ける", () => {
  const rows = designLines(design);
  const del = rows.find((line) => line.kind === "del")!;
  del.text = "予約時に減らす";
  const source = designSource("docs/stock.md", rows);
  const lines = rows.map(({ text }) => text);
  const addIndex = rows.findIndex((line) => line.kind === "add");
  const quote = makeQuote(source, lines, {
    mode: "char",
    ranges: [{ line: addIndex, from: 0, to: 1 }],
  });
  expect(quote?.text).toBe("予");
  expect([...stockMarks(source, lines, [], quote ?? undefined)]).toEqual([
    [addIndex, { symbol: "›" }],
  ]);
  rows.splice(addIndex, 1);
  expect([
    ...stockMarks(
      designSource("docs/stock.md", rows),
      rows.map(({ text }) => text),
      [],
      quote ?? undefined,
    ),
  ]).toEqual([]);
});

it("矩形内の UTF-16 サロゲートの後半を選んでも、完全な文字を持つ行に印を付ける", () => {
  const rows = designLines(design);
  const index = rows.findIndex((line) => line.kind === "add");
  rows[index].text = "a😀Z";
  const source = designSource("docs/stock.md", rows);
  const lines = rows.map(({ text }) => text);
  const quote = makeQuote(source, lines, {
    mode: "block",
    ranges: [{ line: index, from: 2, to: 3 }],
  });
  expect(quote?.text).toBe("😀");
  expect([...stockMarks(source, lines, [], quote ?? undefined)]).toEqual([
    [index, { symbol: "›" }],
  ]);
});

const noFeed = () => () => {};

async function renderReview(
  unsentInstructionCount: number,
  options?: { url: string; stockFetch: typeof fetch },
) {
  const notify = vi.fn();
  const controller = new BufferController({
    url: options?.url ?? "/issues/issue",
    navigate: vi.fn(),
    notify,
  });
  const stock =
    options &&
    createStockWorkspace({
      controller,
      api: createStockApi(options.stockFetch),
      conversations: createConversationApi(async () => new Response(null, { status: 404 })),
      env: { now: () => 0, id: () => "tab", clientId: "tab", schedule: noFeed },
      subscribe: noFeed,
      showConversation: noFeed,
      openFile: () => {},
      queuedId: () => undefined,
    });
  const stop = stock?.start();
  const approve = vi.fn<DesignApi["approve"]>(async () => ({ status: "reflecting" }));
  const reject = vi.fn<DesignApi["reject"]>(async () => ({ deliveredStockIds: [] }));
  const showConversation = vi.fn();
  const mounted = render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <Layout
        controller={controller}
        main={
          <DesignView
            id="issue"
            title="予約を確保する"
            positionKey="/issues/issue/design"
            controller={controller}
            design={{
              api: { get: async () => ({ ...design, unsentInstructionCount }), approve, reject },
              enterStock: stock?.enterIssue,
              stockSession: stock?.session,
            }}
            subscribe={noFeed}
            stopDetail={null}
            showConversation={showConversation}
          />
        }
      />
    </SWRConfig>,
  );
  await screen.findByText("修正方針", { exact: true });
  return {
    controller,
    notify,
    approve,
    reject,
    showConversation,
    dispose() {
      mounted.unmount();
      stop?.();
    },
  };
}

it("n で取り消し、承認確認の y で表示した版だけを送る", async () => {
  const { controller, notify, approve, showConversation } = await renderReview(2);
  const keys = { isComposing: false, altKey: false, ctrlKey: false, metaKey: false };
  await act(() => controller.run("design.approve"));
  expect(controller.snapshot().confirmation?.text).toBe(approvalConfirmation(2));
  await act(() => controller.answer({ key: "n", ...keys }));
  expect(notify).toHaveBeenCalledWith("やめました", "info");
  expect(approve).not.toHaveBeenCalled();
  await act(() => controller.run("design.approve"));
  await act(async () => {
    controller.answer({ key: "y", ...keys });
    await vi.waitFor(() => expect(showConversation).toHaveBeenCalledOnce());
  });
  expect(approve).toHaveBeenCalledExactlyOnceWith("issue", design.headCommit);
});

it("空の差し戻しは送らずにお知らせを出して入力欄を残す", async () => {
  const { controller, notify, reject } = await renderReview(0);
  await act(() => controller.run("design.reject"));
  const input = await screen.findByRole("textbox", { name: "差し戻し" });
  await act(() => fireEvent.keyDown(input, { key: "Escape" }));
  await act(() => fireEvent.keyDown(input, { key: "Enter" }));
  expect(notify).toHaveBeenCalledWith(emptyDesignRejection.message, "error");
  expect(reject).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "差し戻し" })).toBeVisible();
});

it("引用の位置を開いて Space c を押すと追加行のパスと行を持つ指示をストックする", async () => {
  const added = vi.fn();
  let stored: object[] = [];
  const view = await renderReview(0, {
    url:
      "/issues/issue/design?path=docs%2Fstock.md&line=8&col=3&quoteSide=new&quoteRow=8&quote=" +
      encodeURIComponent("に確保する"),
    async stockFetch(_request, init) {
      if (init?.method !== "POST") return Response.json({ items: stored, threads: [] });
      if (typeof init.body !== "string") throw new Error("ストックの本文がありません");
      const body = JSON.parse(init.body) as object;
      added(body);
      const item = {
        ...body,
        id: "stock",
        conversationId: "design",
        stale: false,
        state: "stocked",
        sentAt: null,
        sentSeq: null,
        thread: null,
        githubCommentUrl: null,
      };
      stored = [item];
      return Response.json({ item });
    },
  });
  try {
    await waitFor(() => expect(view.controller.currentLine("main")?.text).toBe("予約時に確保する"));
    const editor = screen.getByRole("textbox", { name: "バッファ" });
    await act(async () => {
      editor.focus();
      fireEvent.keyDown(editor, { key: " " });
      fireEvent.keyDown(editor, { key: "c" });
    });
    expect(await screen.findByRole("textbox", { name: "指示" })).toBeVisible();
    await waitFor(() =>
      expect(document.querySelector(".cm-mark-gutter")?.textContent).toContain("›"),
    );
    await act(async () => {
      view.controller.setPromptDraft("在庫の確保を確認してください");
      await view.controller.submitPrompt("在庫の確保を確認してください");
    });
    await waitFor(() =>
      expect(document.querySelector(".cm-mark-gutter")?.textContent).toContain("!"),
    );
    expect(added).toHaveBeenCalledExactlyOnceWith({
      kind: "instruction",
      text: "在庫の確保を確認してください",
      quote: {
        kind: "design_diff",
        mode: "line",
        path: "docs/stock.md",
        text: "予約時に確保する",
        start: { line: 8, col: 0, row: { side: "new", line: 8 } },
        end: { line: 8, col: 8, row: { side: "new", line: 8 } },
      },
    });
  } finally {
    await act(() => view.dispose());
  }
});
