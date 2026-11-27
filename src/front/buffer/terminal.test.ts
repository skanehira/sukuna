import { describe, expect, it, vi } from "vite-plus/test";
import { BufferController } from "./controller";
import { TerminalInput } from "./terminal";

describe("ターミナルの入力", () => {
  it("割り当てたキーだけ Normal へ戻し、ほかのキーと Ctrl+[ はターミナルへ送る", () => {
    const controller = new BufferController();
    const send = vi.fn();
    const terminal = new TerminalInput(controller, send);
    terminal.enter();
    for (const event of [
      new KeyboardEvent("keydown", { key: "i" }),
      new KeyboardEvent("keydown", { key: "[", ctrlKey: true }),
      new KeyboardEvent("keydown", { key: "]", ctrlKey: true }),
    ])
      terminal.receive(event);
    expect(send.mock.calls).toEqual([["i"], ["\u001b"]]);
    expect(controller.snapshot().mode).toBe("NORMAL");
  });
  it(":tmap の保存後は新しいキーで戻り、前のキーはターミナルへ送る", async () => {
    const save = vi.fn(async () => {});
    const controller = new BufferController({
      keymap: { load: async () => ({ version: 1, entries: [] }), save, subscribe: () => () => {} },
    });
    await controller.command("tmap <C-x> terminal.normal");
    const send = vi.fn();
    const terminal = new TerminalInput(controller, send);
    terminal.enter();
    terminal.receive(new KeyboardEvent("keydown", { key: "]", ctrlKey: true }));
    terminal.receive(new KeyboardEvent("keydown", { key: "x", ctrlKey: true }));
    expect(send.mock.calls).toEqual([["\u001d"]]);
    expect(controller.snapshot().mode).toBe("NORMAL");
    expect(save.mock.calls).toEqual([
      [{ keys: "<C-]>", context: "terminal", to: null }],
      [{ keys: "<C-x>", context: "terminal", to: { action: "terminal.normal" } }],
    ]);
  });
});

describe("ターミナルの複数キー", () => {
  it.each(
    [
      { mapping: "jk", first: { key: "j" }, text: "j", last: "k" },
      { mapping: "<C-w>x", first: { key: "w", ctrlKey: true }, text: "\u0017", last: "x" },
    ].flatMap((entry) =>
      ["complete", "mismatch", "restart", "ime"].map((outcome) => ({ ...entry, outcome })),
    ),
  )(
    "$mapping の $outcome で入力を失わず一致時だけ戻る",
    async ({ mapping, first, text, last, outcome }) => {
      const controller = new BufferController({
        keymap: {
          load: async () => ({ version: 1, entries: [] }),
          save: vi.fn(),
          subscribe: () => () => {},
        },
      });
      await controller.command(`tmap ${mapping} terminal.normal`);
      const send = vi.fn();
      const terminal = new TerminalInput(controller, send);
      terminal.enter();
      expect(terminal.receive(new KeyboardEvent("keydown", first))).toBe(true);
      expect(send.mock.calls).toEqual([]);
      if (outcome === "restart") terminal.receive(new KeyboardEvent("keydown", first));
      terminal.receive(
        new KeyboardEvent("keydown", {
          key: outcome === "mismatch" ? "z" : last,
          isComposing: outcome === "ime",
        }),
      );
      expect({
        sent: send.mock.calls.map(([value]) => value).join(""),
        mode: controller.snapshot().mode,
      }).toEqual({
        sent:
          outcome === "complete"
            ? ""
            : outcome === "restart"
              ? text
              : text + (outcome === "mismatch" ? "z" : last),
        mode: outcome === "complete" || outcome === "restart" ? "NORMAL" : "TERMINAL",
      });
    },
  );
});
