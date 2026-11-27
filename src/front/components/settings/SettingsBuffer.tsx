import { useRef } from "react";
// oxlint-disable-next-line no-restricted-imports -- CodeMirror の既存 EditorView に外部の行データを dispatch する
import { useEffect } from "react";
import { Buffer, type BufferHandle } from "../../buffer/Buffer";
import type { ColumnDef, LineInfo } from "../../buffer/line";

export function SettingsBuffer({
  view,
  lines,
  columns,
  side = "main",
}: {
  view: "help" | "settings" | "backups";
  side?: "main" | "right";
  lines: LineInfo[];
  columns: ColumnDef[];
}) {
  const handle = useRef<BufferHandle | null>(null);
  const previous = useRef(lines);
  useEffect(() => {
    if (previous.current === lines) return;
    handle.current?.replaceAll(lines);
    previous.current = lines;
  }, [lines]);
  return (
    <Buffer
      side={side}
      viewName={view}
      lines={lines}
      columns={columns}
      onReady={(ready) => {
        handle.current = ready;
      }}
    />
  );
}
