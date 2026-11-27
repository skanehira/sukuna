import { WebSocket, type RawData } from "ws";
import {
  TERMINAL_INPUT_BYTES,
  terminalInputFrameSchema,
  type TerminalOutputFrame,
} from "../../../../shared/api/terminal";
import type { TerminalConnection } from "./pty-session";

const INVALID_FRAME = "端末の操作を読み取れませんでした。";
const MAX_BUFFERED_OUTPUT = 32 * 1024 * 1024;

function parseText(data: RawData) {
  const source = Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : data;
  try {
    return terminalInputFrameSchema.safeParse(JSON.parse(source.toString()) as unknown);
  } catch {
    return undefined;
  }
}

export function connectTerminal(client: WebSocket, terminal: TerminalConnection): void {
  client.pause();
  const send = (frame: TerminalOutputFrame) => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > MAX_BUFFERED_OUTPUT) {
      client.terminate();
      return;
    }
    client.send(JSON.stringify(frame));
    if (frame.type === "snapshot") client.resume();
  };
  const unsubscribe = terminal.subscribe(send);
  client.once("close", unsubscribe);
  client.on("error", () => {
    unsubscribe();
    client.terminate();
  });
  client.on("message", (data, binary) => {
    const frame = binary ? undefined : parseText(data);
    if (!frame?.success) {
      send({ type: "error", message: INVALID_FRAME });
      return;
    }
    const input = frame.data;
    if (input.type === "input" && Buffer.byteLength(input.data) > TERMINAL_INPUT_BYTES) {
      send({ type: "error", message: "入力は 64 KiB までです。分けて送ってください。" });
      return;
    }
    try {
      if (input.type === "input") terminal.input(input.data);
      else terminal.resize(input.cols, input.rows);
    } catch {
      send({ type: "error", message: "端末の操作に失敗しました。" });
    }
  });
}
