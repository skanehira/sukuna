import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { App } from "./App";

describe("App", () => {
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
