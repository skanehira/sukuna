import { useState, useSyncExternalStore, type ReactNode } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部システムとの同期: キー設定の配信購読を開始し、Layout の破棄時に解除する
import { useEffect } from "react";
import { BufferController, BufferControllerContext } from "./controller";
import type { RightView } from "./right-window";
import { WhichKey } from "./WhichKey";
import { ConfirmBar } from "./ConfirmBar";
import { CommandLine } from "./CommandLine";
import { StatusLine } from "./StatusLine";
import { PromptEditor } from "./PromptEditor";
export type LayoutProps = {
  tree?: ReactNode;
  main: ReactNode;
  right?: ReactNode;
  controller?: BufferController;
  renderRight?: (view: RightView) => ReactNode;
  disconnected?: boolean;
  notices?: ReactNode;
};
export function Layout({
  tree,
  main,
  right,
  controller: supplied,
  renderRight,
  disconnected,
  notices,
}: LayoutProps) {
  const [local] = useState(() => new BufferController());
  const controller = supplied ?? local;
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  useEffect(() => controller.start(), [controller]);
  const rightNode = controller.rightClosed
    ? null
    : controller.right.current && renderRight
      ? renderRight(controller.right.current)
      : right;
  return (
    <BufferControllerContext value={controller}>
      <div
        className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-surface"
        onKeyDownCapture={(event) => {
          if (controller.answer(event.nativeEvent)) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {tree === undefined ? null : (
            <div className="flex min-h-0 w-60 shrink-0 flex-col bg-ground">{tree}</div>
          )}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-line">{main}</div>
          {rightNode === undefined || rightNode === null ? null : (
            <div className="flex min-h-0 w-[23rem] shrink-0 flex-col border-l border-line">
              {rightNode}
            </div>
          )}
        </div>
        {state.prompt ? (
          <PromptEditor
            key={state.promptId}
            controller={controller}
            spec={state.prompt}
            active={state.active === "prompt"}
          />
        ) : null}
        {state.prefix ? <WhichKey controller={controller} prefix={state.prefix} /> : null}
        {state.command !== null ? (
          <CommandLine controller={controller} initial={state.command} />
        ) : null}
        {state.confirmation ? <ConfirmBar text={state.confirmation.text} /> : null}
        {state.notice && !controller.options.notify ? (
          <div
            role="alert"
            className={`mx-2 ml-auto max-w-[calc(100%-1rem)] rounded-md border border-line bg-surface px-4 py-2 text-[13px] shadow-lg ${state.notice.kind === "error" ? "text-wait" : "text-ink"}`}
          >
            {state.notice.message}
          </div>
        ) : null}
        {notices}
        <StatusLine controller={controller} state={state} disconnected={disconnected} />
      </div>
    </BufferControllerContext>
  );
}
