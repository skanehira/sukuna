import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import { App } from "./App";

describe("App", () => {
  it("アプリを開くと、ツリー・主のウィンドウ・右のウィンドウが出る", () => {
    render(<App />);

    expect(screen.getByRole("region", { name: "sukuna" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "会話: バッファの土台" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "直近" })).toBeInTheDocument();
  });

  it("主のウィンドウに会話の行が出る", () => {
    render(<App />);

    expect(
      screen.getByText("line.ts の LineInfo を正本にして、state.ts に StateField を置きました。"),
    ).toBeInTheDocument();
  });
});
