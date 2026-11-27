import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { EditorView } from "@codemirror/view";
import { BufferController, BufferControllerContext } from "../buffer/controller";
import { bufferField } from "../buffer/state";
import { InboxPage } from "./inbox";
import { inboxFixture, response, row } from "../lib/inbox.test-support";

function mount(fixture = inboxFixture()) {
  const navigate = vi.fn();
  const controller = new BufferController({ navigate });
  const result = render(
    <BufferControllerContext value={controller}>
      <InboxPage store={fixture.store} controller={controller} />
    </BufferControllerContext>,
  );
  const view = () =>
    EditorView.findFromDOM(result.container.querySelector<HTMLElement>(".cm-editor")!)!;
  return { ...fixture, ...result, controller, navigate, view };
}

describe("一覧", () => {
  it("jで空のセクションの見出しと案内を飛ばして次の会話へ移る", async () => {
    const { controller, view } = mount(
      inboxFixture(
        response(
          row(),
          row({
            key: "conversation:work",
            id: "work",
            title: "会話: 作業",
            section: "working",
            reason: "working",
            unread: false,
          }),
        ),
      ),
    );
    await screen.findByText("会話: 予約 API の壁打ち", { exact: true });
    act(() => {
      controller.focus("main");
      view().dispatch({ selection: { anchor: view().state.doc.line(2).from } });
    });
    expect(controller.currentLine()?.id).toBe("conversation:c");
    fireEvent.keyDown(view().contentDOM, { key: "j" });
    expect(controller.currentLine()?.id).toBe("conversation:work");
  });
  it("列の幅を超える状況は折り返さず末尾を…にし、元の文は検索できる", async () => {
    const status = "長い状況の文".repeat(30);
    mount(inboxFixture(response(row({ status }))));
    const cell = await screen.findByText(status, { exact: true });
    const style = getComputedStyle(cell);
    expect({
      whiteSpace: style.whiteSpace,
      overflow: style.overflow,
      textOverflow: style.textOverflow,
    }).toEqual({ whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" });
  });
  it("全行の題名・状況・プロジェクト・経過と、作業中の工程・工程の経過・最後にしたことを表示する", async () => {
    const working = row({
      key: "issue:i",
      kind: "issue",
      id: "i",
      title: "#42 決済を追加",
      section: "working",
      reason: "working",
      status: "",
      unread: false,
      activity: {
        stage: "review",
        stageLabel: "レビュー",
        stageStartedAt: 0,
        lastAction: "Read(src/app.ts)",
        lastActionAt: 60000,
      },
      issue: { number: 42, state: "implementing", stopReason: null },
    });
    const { view, controller } = mount(inboxFixture(response(row(), working)));
    await screen.findByText("会話: 予約 API の壁打ち", { exact: true });
    expect(
      view()
        .state.field(bufferField)
        .lines.map(({ text }) => text),
    ).toEqual([
      "判断待ち  1",
      "会話: 予約 API の壁打ち  質問 1 件: 期限は?  shop-api  1分前",
      "指示待ち  0",
      "指示待ちはありません",
      "作業中  1",
      "#42 決済を追加  レビュー 2分 · Read(src/app.ts)  shop-api  1分前",
    ]);
    expect(controller.statusItems()).toEqual(["判断待ち 1", "指示待ち 0", "作業中 1"]);
    expect(
      view()
        .state.field(bufferField)
        .lines.filter((line) => line.mark === "●")
        .map((line) => line.id),
    ).toEqual(["conversation:c"]);
  });

  it.each([
    [row(), "/conversations/c"],
    [row({ key: "issue:i", kind: "issue", id: "i" }), "/issues/i"],
    [row({ section: "working", reason: "working", unread: false }), "/conversations/c?tail=1"],
    [
      row({ key: "issue:i", kind: "issue", id: "i", section: "working", reason: "flow_waiting" }),
      "/issues/i?tail=1",
    ],
  ])("行でEnterを押すと対応する画面へ移る %#", async (value, url) => {
    const { view, navigate, controller } = mount(inboxFixture(response(value)));
    await screen.findByText(value.title, { exact: true });
    act(() => {
      controller.focus("main");
      view().dispatch({
        selection: {
          anchor: view().state.doc.line(
            view()
              .state.field(bufferField)
              .lines.findIndex((line) => line.id === value.key) + 1,
          ).from,
        },
      });
    });
    fireEvent.keyDown(view().contentDOM, { key: "Enter" });
    expect(navigate.mock.calls).toEqual([[url]]);
  });

  it("読み直しでセクションが変わっても同じ行へ追従し、消えたら同じ行番号へ置く", async () => {
    const initial = response(
      row(),
      row({ key: "conversation:next", id: "next", title: "会話: 次", section: "instruction" }),
    );
    const { store, api, view, controller } = mount(inboxFixture(initial));
    await screen.findByText("会話: 予約 API の壁打ち", { exact: true });
    act(() => {
      view().dispatch({ selection: { anchor: view().state.doc.line(2).from } });
    });
    const editor = view();
    api.inbox.mockResolvedValue(
      response(row({ section: "working", reason: "working" }), initial.sections[1].rows[0]),
    );
    await act(() => store.reload());
    await waitFor(() => {
      expect(controller.currentLine()?.id).toBe("conversation:c");
      expect(view().state.doc.lineAt(view().state.selection.main.head).number).toBe(6);
    });
    expect(view()).toBe(editor);
    expect(view().state.doc.lineAt(view().state.selection.main.head).number).toBe(6);
    api.inbox.mockResolvedValue(
      response(
        initial.sections[1].rows[0],
        row({ key: "conversation:last", id: "last", title: "会話: 末尾", section: "working" }),
      ),
    );
    await act(() => store.reload());
    await waitFor(() => expect(controller.currentLine()?.id).toBe("conversation:last"));
    expect(view().state.doc.lineAt(view().state.selection.main.head).number).toBe(6);
  });

  it("判断待ちが無いときの案内を表示し、プロジェクトが無いときは登録を案内する", async () => {
    const { api, store, view } = mount(inboxFixture(response()));
    await screen.findByText("判断待ちはありません", { exact: true });
    api.projects.mockResolvedValue({ projects: [] });
    await act(() => store.reload());
    await waitFor(() =>
      expect(view().state.doc.toString()).toBe(
        "プロジェクトがありません。:set からプロジェクトを登録します。",
      ),
    );
  });

  it("取得失敗時も最後の一覧と再読み込みを表示し、再接続後は新しい一覧へ入れ替える", async () => {
    const { api, store } = mount();
    await screen.findByText("会話: 予約 API の壁打ち", { exact: true });
    api.inbox.mockRejectedValueOnce(new Error("サーバーにつながりません。"));
    await act(() => store.reload());
    expect(screen.getByRole("alert").textContent).toBe("サーバーにつながりません。");
    expect(screen.getByText("会話: 予約 API の壁打ち", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再読み込み" })).toBeEnabled();
    api.inbox.mockResolvedValue(response(row({ title: "会話: 再接続後" })));
    await act(() => store.reload());
    await screen.findByText("会話: 再接続後", { exact: true });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
