import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { App } from "./App";
import { SWRConfig } from "swr";

describe("App", () => {
  it("独自の見出しを持つ会話でも、切断時は表示済みの会話と再読み込みの案内を出す", async () => {
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <App
          connection={{ snapshot: () => false, subscribe: () => () => {} }}
          loadScreen={async () => ({
            kind: "ready",
            title: "会話",
            fullWindow: true,
            content: (
              <section aria-label="会話">
                <p>保存済みの会話</p>
              </section>
            ),
          })}
        />
      </SWRConfig>,
    );
    expect(await screen.findByText("保存済みの会話", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("alert").textContent).toBe(
      "サーバーにつながりません。最後に取得した内容を表示しています。",
    );
    expect(screen.getByRole("button", { name: "再読み込み" })).toBeEnabled();
  });
  it("アプリを開くと見出し sukuna と空の一覧が出る", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "sukuna" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "sukuna" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "一覧" })).toBeInTheDocument();
  });

  it("会話を開いていない初期状態には、架空の会話や末尾の区画を足さない", () => {
    const { container } = render(<App />);

    expect(
      [...container.querySelectorAll<HTMLElement>(".cm-editor")].map((editor) =>
        EditorView.findFromDOM(editor)?.state.doc.toString(),
      ),
    ).toEqual(["", "表示する項目はありません。"]);
  });
});
