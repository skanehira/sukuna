import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { terminalLines } from "./terminal-lines";
import type { CreateSurface } from "./terminal-client";

const terminalOptions = {
  cols: 120,
  rows: 40,
  fontFamily: '"JetBrains Mono", monospace',
  fontSize: 13,
  scrollback: 10_000,
  theme: {
    background: "#fff",
    foreground: "#252c33",
    cursor: "#252c33",
    selectionBackground: "#dce9f5",
  },
} as const;

export const createTerminalSurface: CreateSurface = (host, input) => {
  const term = new Terminal(terminalOptions);
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  const data = term.onData(input);
  const binary = term.onBinary(input);
  return {
    focus: () => term.focus(),
    fit: () => {
      const size = fit.proposeDimensions();
      if (size) {
        const cols = Math.max(2, Math.min(500, size.cols));
        const rows = Math.max(1, Math.min(200, size.rows));
        if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
      }
      return { cols: term.cols, rows: term.rows };
    },
    resize: (cols, rows) => term.resize(cols, rows),
    write: (text, done) => term.write(text, done),
    reset: () => term.reset(),
    scrollToBottom: () => term.scrollToBottom(),
    lines: () => terminalLines(term.buffer.active),
    observe(resize) {
      const observer = new ResizeObserver(resize);
      observer.observe(host);
      return () => observer.disconnect();
    },
    onKey: (handler) => term.attachCustomKeyEventHandler(handler),
    dispose: () => {
      binary.dispose();
      data.dispose();
      term.dispose();
    },
  };
};
