import { Buffer } from "../buffer/Buffer";
import type { LineInfo } from "../buffer/line";
import type { BufferSide } from "../buffer/theme";

const skeletonLines: LineInfo[] = Array.from({ length: 6 }, () => ({
  kind: "skeleton",
  text: "                              ",
}));

export function Skeleton({ side }: { side: BufferSide }) {
  return (
    <div role="status" aria-label="読み込み中" className="flex min-h-0 flex-1 flex-col">
      <Buffer side={side} lines={skeletonLines} onReady={() => undefined} />
    </div>
  );
}

export function Spinner() {
  return (
    <div
      role="status"
      aria-label="操作中"
      className="flex items-center gap-2 px-4 py-3 text-[13px] text-muted"
    >
      <span
        aria-hidden="true"
        className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent"
      />
      操作中
    </div>
  );
}
