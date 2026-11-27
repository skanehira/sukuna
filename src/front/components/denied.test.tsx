import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { Denied } from "./denied";

const TITLE = "このアプリは使えません";
const IDENTITY_MESSAGE =
  "Tailscale の本人として確認できませんでした。自分のアカウントで Tailscale につないでから、再読み込みしてください。";
const UNAVAILABLE_MESSAGE =
  "Tailscale に問い合わせできませんでした。Mac Studio の Tailscale が動いているかを確かめてから、再読み込みしてください。";

describe("Denied", () => {
  it("本人として確認できないときは、その理由と再読み込みを出す", () => {
    render(<Denied reason="identity" />);

    expect(screen.getByText(TITLE)).toBeInTheDocument();
    expect(screen.getByText(IDENTITY_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(UNAVAILABLE_MESSAGE)).toBeNull();
    expect(screen.getByRole("button", { name: "再読み込み" })).toBeInTheDocument();
  });

  it("Tailscale に問い合わせできないときは、その理由と再読み込みを出す", () => {
    render(<Denied reason="unavailable" />);

    expect(screen.getByText(TITLE)).toBeInTheDocument();
    expect(screen.getByText(UNAVAILABLE_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(IDENTITY_MESSAGE)).toBeNull();
    expect(screen.getByRole("button", { name: "再読み込み" })).toBeInTheDocument();
  });
});
