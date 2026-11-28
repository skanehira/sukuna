import {
  terminalOutputFrameSchema,
  TERMINAL_INPUT_BYTES,
  type TerminalOutputFrame,
} from "../../../shared/api/terminal";

type Size = { cols: number; rows: number };
export type InputFrame = { type: "input"; data: string } | ({ type: "resize" } & Size);
export type TerminalSurface = {
  focus(): void;
  fit(): Size;
  resize(cols: number, rows: number): void;
  write(text: string, done: () => void): void;
  reset(): void;
  scrollToBottom(): void;
  lines(): string[];
  observe(resize: () => void): () => void;
  onKey(handler: (event: KeyboardEvent) => boolean): void;
  dispose(): void;
};
export type CreateSurface = (
  host: HTMLDivElement,
  input: (text: string) => void,
) => TerminalSurface;
export type TerminalConnect = (
  id: string,
  handlers: { frame: (frame: TerminalOutputFrame) => void; close: () => void },
) => { send(frame: InputFrame): void; close(): void };

export function connectBrowserTerminal(browser: Window): TerminalConnect {
  return (id, handlers) => {
    const url = new URL(`/ws/terminals/${encodeURIComponent(id)}`, browser.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    const receive = ({ data }: MessageEvent<unknown>) => {
      if (typeof data !== "string") return;
      try {
        const frame = terminalOutputFrameSchema.safeParse(JSON.parse(data));
        if (frame.success) handlers.frame(frame.data);
      } catch {
        socket.close();
      }
    };
    socket.addEventListener("message", receive);
    socket.addEventListener("close", handlers.close);
    return {
      send(frame) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
      },
      close() {
        socket.removeEventListener("message", receive);
        socket.removeEventListener("close", handlers.close);
        socket.close();
      },
    };
  };
}

export function sendTerminalInput(send: (frame: InputFrame) => void, text: string) {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= TERMINAL_INPUT_BYTES) {
    if (text) send({ type: "input", data: text });
    return;
  }
  let start = 0;
  let bytes = 0;
  let end = 0;
  for (const point of text) {
    const size = encoder.encode(point).length;
    if (bytes + size > TERMINAL_INPUT_BYTES) {
      send({ type: "input", data: text.slice(start, end) });
      start = end;
      bytes = 0;
    }
    end += point.length;
    bytes += size;
  }
  if (end > start) send({ type: "input", data: text.slice(start, end) });
}
