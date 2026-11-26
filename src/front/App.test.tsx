import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import { App } from "./App";

describe("App", () => {
  it("アプリを開くと見出し sukuna が出る", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "sukuna" })).toBeInTheDocument();
  });
});
