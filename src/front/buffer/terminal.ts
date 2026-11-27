import type { BufferController } from "./controller";
import { eventKey } from "./keymap/notation";
export class TerminalInput {
  private controller: BufferController;
  private send: (text: string) => void;
  private prefix = "";
  private pending = "";
  constructor(controller: BufferController, send: (text: string) => void) {
    this.controller = controller;
    this.send = send;
  }
  enter(): void {
    this.controller.update({ mode: "TERMINAL" });
  }
  receive(event: KeyboardEvent): boolean {
    if (this.controller.snapshot().mode !== "TERMINAL") return false;
    const token = eventKey(event);
    if (!token) return false;
    const keys = `${this.prefix}${token}`;
    const entries = this.controller
      .entries()
      .filter(
        (entry) =>
          entry.context === "terminal" &&
          entry.to !== null &&
          "action" in entry.to &&
          entry.to.action === "terminal.normal",
      );
    const text = terminalText(event);
    const hold = (keys: string) => {
      if (event.isComposing || !entries.some((entry) => entry.keys.startsWith(keys))) return false;
      event.preventDefault();
      this.prefix = keys;
      this.pending += text;
      if (entries.some((entry) => entry.keys === keys)) {
        this.prefix = "";
        this.pending = "";
        this.controller.update({ mode: "NORMAL" });
      }
      return true;
    };
    if (hold(keys)) return true;
    if (this.pending) this.send(this.pending);
    this.prefix = "";
    this.pending = "";
    if (hold(token)) return true;
    this.send(text);
    return false;
  }
}

function terminalText(event: KeyboardEvent): string {
  if (event.ctrlKey && event.key === "[") return "\u001b";
  if (event.ctrlKey && event.key.length === 1)
    return String.fromCharCode(event.key.toUpperCase().charCodeAt(0) & 31);
  const controls: Record<string, string> = {
    Enter: "\r",
    Escape: "\u001b",
    Backspace: "\u007f",
    Tab: "\t",
    ArrowUp: "\u001b[A",
    ArrowDown: "\u001b[B",
    ArrowRight: "\u001b[C",
    ArrowLeft: "\u001b[D",
  };
  const text = controls[event.key] ?? event.key;
  return event.altKey ? `\u001b${text}` : text;
}
