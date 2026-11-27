import { useRef } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部システムとの同期: CodeMirror の既存バッファへ行と表示拡張を dispatch する
import { useEffect } from "react";
import type { Extension } from "@codemirror/state";
import { Buffer, type BufferHandle } from "../../buffer/Buffer";
import type { LineInfo } from "../../buffer/line";

export function FileBuffer({
  lines,
  viewName,
  side = "main",
  posKey,
  startLine,
  display,
  placement,
  ready = true,
}: {
  lines: LineInfo[];
  viewName: string;
  side?: "main" | "right" | "table";
  posKey?: string;
  startLine?: number;
  display?: Extension;
  placement?: { id: string };
  ready?: boolean;
}) {
  const buffer = useRef<BufferHandle | null>(null);
  const previous = useRef(lines);
  const previousReady = useRef(ready);
  const previousDisplay = useRef(display);
  const placed = useRef<typeof placement>(undefined);
  useEffect(() => {
    const handle = buffer.current;
    if (!handle) return;
    const target =
      placement && placed.current !== placement
        ? lines.findIndex((line) => line.id === placement.id)
        : -1;
    if (previous.current === lines && previousReady.current === ready && target === -1) return;
    if (target !== -1) placed.current = placement;
    previous.current = lines;
    previousReady.current = ready;
    handle.replaceAll(lines, { ready, ...(target === -1 ? {} : { position: { line: target } }) });
  }, [lines, placement, ready]);
  useEffect(() => {
    if (display === previousDisplay.current) return;
    previousDisplay.current = display;
    buffer.current?.setDisplay?.(display ?? []);
  }, [display]);
  return (
    <Buffer
      lines={lines}
      side={side}
      viewName={viewName}
      posKey={posKey}
      startLine={startLine}
      display={display}
      ready={ready}
      onReady={(handle) => {
        buffer.current = handle;
        previous.current = lines;
        previousReady.current = ready;
        previousDisplay.current = display;
        placed.current = undefined;
      }}
    />
  );
}
