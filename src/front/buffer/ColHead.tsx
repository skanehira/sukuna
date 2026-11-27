import type { ColumnDef } from "./line";
import { columnWidth } from "./line";
import { sideMetrics, type BufferSide } from "./theme";

export type ColHeadProps = {
  columns: ColumnDef[];
  side: BufferSide;
};

function leftInset(side: BufferSide): number {
  const metrics = sideMetrics(side);
  return (
    metrics.markWidth + (metrics.numbers ? 40 : 0) + (side === "tree" || side === "right" ? 4 : 8)
  );
}

export function ColHead({ columns, side }: ColHeadProps) {
  return (
    <div
      className="flex h-6 shrink-0 items-center overflow-hidden border-b border-line text-muted"
      style={{ paddingLeft: leftInset(side), fontSize: sideMetrics(side).fontSize }}
      aria-hidden="true"
    >
      {columns.flatMap((column) =>
        (column.heads ?? []).map((head, index) => (
          <span
            key={`${column.name}:${index}`}
            className="inline-block overflow-hidden whitespace-pre text-[12px] text-ellipsis"
            style={{
              width: columnWidth(column.widths, index) ?? undefined,
              textAlign: column.align?.[index] === "right" ? "right" : undefined,
              marginRight: index === (column.heads?.length ?? 0) - 1 ? undefined : "0.5rem",
            }}
          >
            {head}
          </span>
        )),
      )}
    </div>
  );
}
