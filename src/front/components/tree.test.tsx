import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { EditorView } from "@codemirror/view";
import { Layout } from "../buffer/Layout";
import { BufferController } from "../buffer/controller";
import { bufferField } from "../buffer/state";
import { inboxFixture } from "../lib/inbox.test-support";
import { Tree, registerInboxNavigation } from "./tree";

describe("左のツリー", () => {
  it("プロジェクト・会話・issue・アプリの順に並び、現在の画面の印と停止中の表示を付ける", async () => {
    const { store, api } = inboxFixture();
    api.projects.mockResolvedValue({
      projects: [
        {
          id: "p",
          name: "shop-api",
          flowPaused: true,
          conversations: [{ id: "c", title: "" }],
          issues: [{ id: "i", number: 42, title: "在庫", state: "ready" }],
        },
      ],
    });
    const navigate = vi.fn();
    const controller = new BufferController({ navigate });
    const result = render(
      <Layout
        controller={controller}
        tree={<Tree store={store} route={{ kind: "project", id: "p" }} />}
        main={<p>主</p>}
      />,
    );
    await screen.findByText("shop-api (自動フロー停止中)", { exact: true });
    const view = EditorView.findFromDOM(
      result.container.querySelector<HTMLElement>(".cm-editor")!,
    )!;
    expect(view.state.field(bufferField).lines.map((line) => [line.text, line.mark ?? ""])).toEqual(
      [
        ["一覧", ""],
        ["shop-api (自動フロー停止中)", "›"],
        ["  会話: (題名なし)", ""],
        ["  #42 在庫", ""],
        ["アプリ", ""],
        ["設定", ""],
        ["ヘルプ", ""],
      ],
    );
    act(() => {
      controller.focus("tree");
      view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
    });
    fireEvent.keyDown(view.contentDOM, { key: "Enter" });
    expect(navigate.mock.calls).toEqual([["/projects/p"]]);
    api.projects.mockResolvedValue({ projects: [] });
    await act(() => store.reload());
    await waitFor(() => expect(controller.currentLine()?.text).toBe("設定"));
  });

  it("Space h・home・lsで一覧へ移り、projectは前方一致が一つのときだけ開く", async () => {
    const { store, api } = inboxFixture();
    const navigate = vi.fn();
    const notify = vi.fn();
    const controller = new BufferController({ navigate, notify });
    const unregister = registerInboxNavigation(controller, store);
    await controller.run("home");
    await controller.command("home");
    await controller.command("ls");
    await controller.command("project shop");
    api.projects.mockResolvedValue({ projects: [] });
    await controller.command("project absent");
    api.projects.mockResolvedValue({
      projects: [
        { id: "p", name: "shop-api", flowPaused: false, conversations: [], issues: [] },
        { id: "q", name: "shop-web", flowPaused: false, conversations: [], issues: [] },
      ],
    });
    await controller.command("project shop");
    expect(navigate.mock.calls).toEqual([["/"], ["/"], ["/"], ["/projects/p"]]);
    expect(notify.mock.calls).toEqual([
      ["プロジェクトが見つかりません", "info"],
      ["複数あります", "info"],
    ]);
    unregister();
  });
});
