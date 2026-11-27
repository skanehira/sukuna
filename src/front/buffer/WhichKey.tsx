import type { BufferController } from "./controller";
import { displayKeys, parseKeys } from "./keymap/notation";
export function WhichKey({ controller, prefix }: { controller: BufferController; prefix: string }) {
  if (!prefix.startsWith("<Space>")) return null;
  const choices = new Map<string, string>();
  for (const entry of controller.entries()) {
    if (
      entry.context !== (controller.snapshot().mode.startsWith("VISUAL") ? "visual" : "normal") ||
      !entry.keys.startsWith(prefix) ||
      !entry.to ||
      !("action" in entry.to)
    )
      continue;
    const action = controller.actions.get(entry.to.action);
    if (!action) continue;
    const rest = parseKeys(entry.keys.slice(prefix.length));
    if (!rest?.length) continue;
    const key = rest[0];
    choices.set(
      key,
      rest.length > 1
        ? key === "s"
          ? "+送る"
          : key === "w"
            ? "+ウィンドウ"
            : "+操作"
        : action.label,
    );
  }
  return (
    <div
      aria-label="続けて押せるキー"
      className="border-t border-line bg-surface px-4 py-3 text-xs"
    >
      <div className="mb-2 font-mono font-bold text-accent">{displayKeys(prefix)}</div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-x-4 gap-y-2">
        {[...choices].map(([key, label]) => (
          <span key={key}>
            <span className="font-mono text-ink">{displayKeys(key)}</span>{" "}
            <span className="text-muted">{label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
