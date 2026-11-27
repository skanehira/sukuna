import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { BufferController } from "./controller";
import { Layout } from "./Layout";

describe("ステータス行のヒント", () => {
  it("ターミナルの入力中は、その context の復帰キーを表示する", () => {
    const controller = new BufferController();
    controller.update({ mode: "TERMINAL" });
    render(<Layout controller={controller} main={<div>ターミナル</div>} />);
    expect(screen.getByRole("status").textContent).toBe("TERMINALmainCtrl+] Normal へ:h ヘルプ");
  });
});
