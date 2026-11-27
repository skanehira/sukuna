import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { BufferController } from "./controller";
import { CommandLine } from "./CommandLine";

describe("コマンドの履歴", () => {
  it.each(
    [false, true].flatMap((history) => ["ArrowUp", "ArrowDown"].map((key) => ({ history, key }))),
  )("履歴 $history の最初の $key と履歴往復で打ちかけを保つ", ({ history, key }) => {
    const controller = new BufferController();
    if (history) controller.positions.addCommand("home");
    render(<CommandLine controller={controller} initial="" />);
    const input = screen.getByRole("textbox", { name: "コマンド" });
    fireEvent.change(input, { target: { value: "project new" } });
    fireEvent.keyDown(input, { key });
    expect(input).toHaveValue(history && key === "ArrowUp" ? "home" : "project new");
    if (history) {
      fireEvent.keyDown(input, { key: "ArrowUp" });
      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(input).toHaveValue("home");
      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(input).toHaveValue("project new");
      fireEvent.change(input, { target: { value: "project other" } });
      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(input).toHaveValue("home");
      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(input).toHaveValue("project other");
    }
  });
});
