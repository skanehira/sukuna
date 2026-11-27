import { useRef } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部ライブラリとの同期: CodeMirror の行を dispatch で書き換える
import { useEffect } from "react";
import { Buffer, type BufferHandle } from "../buffer/Buffer";
import type { BufferController } from "../buffer/controller";
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
}: {
  lines: LineInfo[];
  columns?: ColumnDef[];
  side: BufferSide;
  viewName: string;
  posKey: string;
  controller?: BufferController;
  status?: string;
  ready?: boolean;
}) {
  const handle = useRef<BufferHandle | null>(null);
  useEffect(() => {
    handle.current?.replaceAll(lines, { ready });
  }, [lines, ready]);
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
      onReady={(value) => {
        handle.current = value;
      }}
    />
  );
}
