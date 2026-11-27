import type { ReactNode } from "react";

export type LayoutProps = {
  tree?: ReactNode;
  main: ReactNode;
  right?: ReactNode;
};

export function Layout({ tree, main, right }: LayoutProps) {
  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-surface">
      {tree === undefined ? null : (
        <div className="flex w-60 min-h-0 shrink-0 flex-col bg-ground">{tree}</div>
      )}
      <div className="flex min-w-0 min-h-0 flex-1 flex-col border-l border-line">{main}</div>
      {right === undefined ? null : (
        <div className="flex w-[23rem] min-h-0 shrink-0 flex-col border-l border-line">{right}</div>
      )}
    </div>
  );
}
