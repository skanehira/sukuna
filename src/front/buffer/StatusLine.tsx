import type { BufferController, BufferSnapshot } from "./controller";
import { resolveHints } from "./hints";
const colors = {
  NORMAL: "bg-muted",
  INSERT: "bg-done",
  REPLACE: "bg-done",
  VISUAL: "bg-accent",
  "VISUAL LINE": "bg-accent",
  "VISUAL BLOCK": "bg-accent",
  COMMAND: "bg-ink",
  TERMINAL: "bg-doing",
};
export function StatusLine({
  controller,
  state,
  disconnected = false,
}: {
  controller: BufferController;
  state: BufferSnapshot;
  disconnected?: boolean;
}) {
  const context =
    state.mode === "TERMINAL"
      ? "terminal"
      : state.active === "prompt"
        ? "prompt"
        : state.mode.startsWith("VISUAL")
          ? "visual"
          : "normal";
  const hints = resolveHints(
    controller.currentHints(),
    controller.entries(),
    controller.actions,
    context,
  );
  return (
    <div
      role="status"
      className="flex h-7 shrink-0 items-center gap-4 overflow-hidden border-t border-line bg-ground px-2 text-xs"
    >
      <span
        className={`shrink-0 rounded font-mono px-2 font-bold text-ground ${colors[state.mode]}`}
      >
        {state.mode}
      </span>
      {disconnected ? <span className="shrink-0 font-bold text-wait">つながりません</span> : null}
      <span className="max-w-80 truncate font-medium">{controller.windowName()}</span>
      <span className="flex min-w-0 flex-1 gap-4 overflow-hidden whitespace-nowrap">
        {hints.map(([key, label]) => (
          <span key={`${key}:${label}`}>
            <span className="font-mono">{key}</span> <span className="text-muted">{label}</span>
          </span>
        ))}
      </span>
      {controller.currentLine()?.status ? (
        <span className="truncate">{controller.currentLine()?.status}</span>
      ) : null}
      <span className="flex shrink-0 gap-4">
        {controller.statusItems().map((text) => (
          <span key={text}>{text}</span>
        ))}
      </span>
      <span className="shrink-0">
        <span className="font-mono">:h</span> <span className="text-muted">ヘルプ</span>
      </span>
    </div>
  );
}
