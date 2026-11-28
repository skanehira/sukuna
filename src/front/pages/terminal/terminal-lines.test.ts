import { Terminal } from "@xterm/headless";

import { expect, it } from "vite-plus/test";
import { terminalLines } from "./terminal-lines";

it("折り返した行をつなぎ、行の途中の空白は残して行末を整える", () => {
  const rows = [
    { value: "abc  ", isWrapped: false },
    { value: "def  ", isWrapped: true },
    { value: "prompt ", isWrapped: false },
    { value: "    ", isWrapped: false },
  ];
  expect(
    terminalLines({
      length: rows.length,
      baseY: 0,
      cursorY: 2,
      getLine: (index) => ({
        length: rows[index].value.length,
        getCell: () => undefined,
        isWrapped: rows[index].isWrapped,
        translateToString: () => rows[index].value,
      }),
    }),
  ).toEqual(["abc  def", "prompt"]);
});

it.each(["abcあd", "abc あd", "abあZ", "abc d"])(
  "4 列で折り返した「%s」を出力どおりに読む",
  async (text) => {
    const terminal = new Terminal({ cols: 4, rows: 3, allowProposedApi: true });
    try {
      await new Promise<void>((written) => terminal.write(text, written));
      expect(terminalLines(terminal.buffer.active)).toEqual([text]);
    } finally {
      terminal.dispose();
    }
  },
);
