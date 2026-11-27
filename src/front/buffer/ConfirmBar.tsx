export function ConfirmBar({ text, choicesInText }: { text: string; choicesInText?: boolean }) {
  return (
    <div
      aria-label="操作の確認"
      className="flex min-h-7 shrink-0 items-center gap-2 border-t border-line bg-surface px-4 text-[13px] font-bold"
    >
      {text} {!choicesInText && <span className="font-mono">(y / n)</span>}
    </div>
  );
}
