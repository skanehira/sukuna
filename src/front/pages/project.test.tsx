import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { EditorView } from "@codemirror/view";
import type { OverviewResponse } from "../../shared/inbox/schema";
import { BufferController } from "../buffer/controller";
import { Layout } from "../buffer/Layout";
import { bufferField } from "../buffer/state";
import { inboxFixture } from "../lib/inbox.test-support";
import { ProjectPage } from "./project";

function issue(id: string, number: number) {
  return {
    key: `issue:${id}`,
    id,
    number,
    title: `項目 ${number}`,
    status: "—",
    lastActivityAt: 60000,
    unread: false,
    activity: null,
  };
}
function fixture(data?: Partial<OverviewResponse>) {
  const f = inboxFixture();
  f.api.overview.mockResolvedValue({
    project: { id: "p", name: "shop-api", flowPaused: false },
    issueSections: [],
    conversations: [],
    ...data,
  });
  const navigate = vi.fn();
  const notify = vi.fn();
  const controller = new BufferController({ navigate, notify });
  const withdraw = vi.fn(async () => ({ stoppedDependents: [43, 45] }));
  const result = render(
    <Layout
      controller={controller}
      main={<ProjectPage store={f.store} id="p" controller={controller} withdraw={withdraw} />}
    />,
  );
  const view = () =>
    EditorView.findFromDOM(result.container.querySelector<HTMLElement>(".cm-editor")!)!;
  return { ...f, ...result, view, controller, navigate, notify, withdraw };
}
describe("プロジェクト", () => {
  it("issueを状態順に、会話を最後に表示し、列に題名・状況・経過を出す", async () => {
    const { view } = fixture({
      issueSections: [
        { state: "draft", total: 1, rows: [issue("d", 9)] },
        { state: "stopped", total: 1, rows: [issue("s", 2)] },
      ],
      conversations: [{ ...issue("c", 0), key: "conversation:c", title: "" }],
    });
    await screen.findByRole("heading", { name: "shop-api" });
    await screen.findByText("#2 項目 2", { exact: true });
    expect(
      view()
        .state.field(bufferField)
        .lines.map((line) => line.text),
    ).toEqual([
      "停止中  1",
      "#2 項目 2  —  1分前",
      "下書き  1",
      "#9 項目 9  —  1分前",
      "会話  1",
      "会話: (題名なし)  —  1分前",
    ]);
  });

  it("完了の残りをEnterで展開し、取り下げの畳みは維持する", async () => {
    const done = Array.from({ length: 11 }, (_, i) => issue(`d${i}`, i + 1));
    const withdrawn = Array.from({ length: 12 }, (_, i) => issue(`w${i}`, i + 20));
    const { store, api, controller, view } = fixture({
      issueSections: [
        { state: "done", total: 11, rows: done.slice(0, 10) },
        { state: "withdrawn", total: 12, rows: withdrawn.slice(0, 10) },
      ],
    });
    await screen.findByText("ほか 1 件を表示する", { exact: true });
    api.overview.mockResolvedValue({
      project: { id: "p", name: "shop-api", flowPaused: false },
      issueSections: [
        { state: "done", total: 11, rows: done },
        { state: "withdrawn", total: 12, rows: withdrawn },
      ],
      conversations: [],
    });
    act(() => {
      const index = view()
        .state.field(bufferField)
        .lines.findIndex((line) => line.action === "project.expand.done");
      view().dispatch({ selection: { anchor: view().state.doc.line(index + 1).from } });
    });
    fireEvent.keyDown(view().contentDOM, { key: "Enter" });
    await screen.findByText("#11 項目 11", { exact: true });
    expect(
      view()
        .state.field(bufferField)
        .lines.filter((line) => line.kind === "row"),
    ).toHaveLength(21);
    expect(store.isExpanded("p", "done")).toBe(true);
    expect(store.isExpanded("p", "withdrawn")).toBe(false);
    expect(controller.currentLine()?.id).toBe("issue:d10");
  });

  it("ccで編集へ移り、ddは確認し、nでは送らずyで取り下げる", async () => {
    const { controller, view, navigate, withdraw, notify } = fixture({
      issueSections: [{ state: "triage", total: 1, rows: [issue("i", 42)] }],
    });
    await screen.findByText("#42 項目 42", { exact: true });
    await act(() => controller.run("item.edit"));
    expect(navigate.mock.calls).toEqual([["/issues/i/edit"]]);
    await act(() => controller.run("item.delete"));
    expect(screen.getByLabelText("操作の確認").textContent).toBe(
      "#42 項目 42 を取り下げて閉じますか? (y / n)",
    );
    fireEvent.keyDown(view().contentDOM, { key: "n" });
    expect(withdraw.mock.calls).toEqual([]);
    await act(() => controller.run("item.delete"));
    fireEvent.keyDown(view().contentDOM, { key: "y" });
    await waitFor(() => expect(withdraw.mock.calls).toEqual([["i"]]));
    expect(notify.mock.calls).toEqual([
      ["やめました", "info"],
      ["issue を取り下げて閉じました。依存する #43、#45 を停止中にしました", "info"],
    ]);
  });

  it("何も無いときは作成を案内し、404では一覧に戻れる", async () => {
    const { store, api } = fixture();
    await screen.findByText("issue はまだありません。Space o で作ります。", { exact: true });
    const { InboxApiError } = await import("../lib/inbox-store");
    api.overview.mockRejectedValue(
      new InboxApiError("not_found", "プロジェクトが見つかりません。読み直してください。"),
    );
    await act(() => store.reload());
    expect(screen.getByRole("alert").textContent).toBe(
      "プロジェクトが見つかりません。読み直してください。",
    );
    expect(screen.getByRole("button", { name: "一覧へ戻る" })).toBeEnabled();
  });
});
