import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { BufferControllerContext, windowId } from "./controller";

export const FrameContext = createContext<string | null>(null);
import { ColHead } from "./ColHead";
import type { ColumnDef } from "./line";
import type { BufferSide } from "./theme";

export type FrameProps = {
  title: string;
  side: BufferSide;
  active?: boolean;
  columns?: ColumnDef[];
  children: ReactNode;
};

export function Frame({ title, side, active = false, columns, children }: FrameProps) {
  const controller = useContext(BufferControllerContext);
  const state = useSyncExternalStore(
    controller?.subscribe ?? (() => () => {}),
    controller?.snapshot ?? (() => null),
  );
  const selected = state ? state.active === windowId(side) : active;
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      style={{ containerType: "inline-size" }}
      aria-label={title}
      onMouseDown={() => controller?.focus(windowId(side))}
    >
      <div
        className={`relative flex h-9 shrink-0 items-center justify-between gap-3 pl-4 pr-2 text-[13px] ${
          selected ? "font-bold text-ink" : "font-medium text-muted"
        }`}
      >
        {selected ? (
          <span
            className="absolute top-1/2 left-[5px] -mt-[3px] h-1.5 w-1.5 rounded-full bg-accent"
            aria-hidden="true"
          />
        ) : null}
        <h2 className="min-w-0 truncate">{title}</h2>
      </div>
      {columns === undefined ? null : <ColHead columns={columns} side={side} />}
      <FrameContext value={title}>{children}</FrameContext>
    </section>
  );
}
