import { useState } from "react";
import type { BufferController } from "./controller";
export function CommandLine({
  controller,
  initial,
}: {
  controller: BufferController;
  initial: string;
}) {
  const [value, setValue] = useState(initial);
  const [index, setIndex] = useState(-1);
  const [draft, setDraft] = useState(initial);
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-t border-line bg-surface px-4 font-mono text-[13px]">
      <span>:</span>
      <input
        aria-label="コマンド"
        className="min-w-0 flex-1 outline-none"
        value={value}
        ref={(node) => {
          node?.focus();
        }}
        onChange={(event) => {
          setValue(event.target.value);
          setIndex(-1);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape" || (event.ctrlKey && event.key === "[")) {
            event.preventDefault();
            controller.closeCommand();
          } else if (event.key === "Enter") {
            event.preventDefault();
            void controller.command(value);
          } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const commands = controller.positions.commands();
            const next = Math.max(
              -1,
              Math.min(commands.length - 1, index + (event.key === "ArrowUp" ? 1 : -1)),
            );
            if (next === index) return;
            if (index === -1) setDraft(value);
            setIndex(next);
            setValue(next < 0 ? draft : (commands[next] ?? draft));
          }
        }}
      />
      <span className="shrink-0 text-xs text-muted">Enter 実行　Esc やめる　:h ヘルプ</span>
    </div>
  );
}
