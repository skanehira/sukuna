import { useRef } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部ライブラリとの同期: CodeMirror の行を dispatch で書き換える
import { useEffect } from "react";
import { Buffer, type BufferHandle } from "../buffer/Buffer";
import type { BufferController } from "../buffer/controller";
import type { BufferMarks } from "../buffer/marks";
import type { ColumnDef, LineInfo } from "../buffer/line";
import type { BufferSide } from "../buffer/theme";

export function ListingBuffer({
  lines,
  columns,
  side,
  viewName,
  posKey,
  controller,
  status = "",
  ready = true,
  marks,
  initialPosition,
}: {
  lines: LineInfo[];
  columns?: ColumnDef[];
  side: BufferSide;
  viewName: string;
  posKey: string;
  controller?: BufferController;
  status?: string;
  ready?: boolean;
  marks?: BufferMarks;
  initialPosition?: { line: number; column: number };
}) {
  const handle = useRef<BufferHandle | null>(null);
  const placed = useRef(false);
  useEffect(() => {
    const position = !placed.current ? initialPosition : undefined;
    if (position) placed.current = true;
    handle.current?.replaceAll(lines, { ready, position });
  }, [initialPosition, lines, ready]);
  useEffect(() => {
    const remove = status
      .split("|")
      .filter(Boolean)
      .map((text, index) => controller?.registerStatusItem(`inbox:${index}`, text));
    return () => remove.forEach((fn) => fn?.());
  }, [controller, status]);
  return (
    <Buffer
      ready={ready}
      side={side}
      viewName={viewName}
      posKey={posKey}
      lines={lines}
      columns={columns}
      marks={marks}
      onReady={(value) => {
        handle.current = value;
      }}
    />
  );
}
