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
  startLine,
}: {
  view: "help" | "settings" | "backups";
  side?: "main" | "right";
  lines: LineInfo[];
  columns: ColumnDef[];
  startLine?: number;
}) {
  const handle = useRef<BufferHandle | null>(null);
  const previous = useRef(lines);
  useEffect(() => {
    if (previous.current === lines) return;
    handle.current?.replaceAll(lines, {
      missingCursorTarget: view === "settings" ? "settings.flow" : undefined,
    });
    previous.current = lines;
  }, [lines, view]);
  return (
    <Buffer
      side={side}
      viewName={view}
      lines={lines}
      columns={columns}
      startLine={startLine}
      onReady={(ready) => {
        handle.current = ready;
      }}
    />
  );
}
