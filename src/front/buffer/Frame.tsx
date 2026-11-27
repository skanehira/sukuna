import type { ReactNode } from "react";
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
  return (
    <section
      className="flex min-h-0 min-w-0 flex-col"
      style={{ containerType: "inline-size" }}
      aria-label={title}
    >
      <div
        className={`relative flex h-9 shrink-0 items-center justify-between gap-3 pl-4 pr-2 text-[13px] ${
          active ? "font-bold text-ink" : "font-medium text-muted"
        }`}
      >
        {active ? (
          <span
            className="absolute top-1/2 left-[5px] -mt-[3px] h-1.5 w-1.5 rounded-full bg-accent"
            aria-hidden="true"
          />
        ) : null}
        <span className="min-w-0 truncate">{title}</span>
      </div>
      {columns === undefined ? null : <ColHead columns={columns} side={side} />}
      {children}
    </section>
  );
}
