export const MAX_FILE_BYTES = 1_048_576;

export function decodeFile(
  bytes: Uint8Array,
): { kind: "text"; content: string } | { kind: "binary" } {
  if (bytes.subarray(0, 8_000).includes(0) || !isUtf8(bytes)) return { kind: "binary" };
  return { kind: "text", content: new TextDecoder("utf-8").decode(bytes).replace(/\r\n/g, "\n") };
}
import { isUtf8 } from "node:buffer";
