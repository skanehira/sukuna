import { Component, type ReactNode } from "react";
import { Buffer } from "../buffer/Buffer";

export function WindowError({
  message,
  onHome,
  onReload,
  keyboardBuffer = false,
}: {
  message: string;
  onHome?: () => void;
  onReload: () => void;
  keyboardBuffer?: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-start gap-5 overflow-auto px-4 py-8 text-[13px]">
      {keyboardBuffer ? (
        <div className="flex min-h-14 w-full flex-col" role="alert">
          <Buffer
            key={message}
            side="main"
            temporary
            lines={message.split(/\r\n?|\n/).map((text) => ({ kind: "note", text, tone: "wait" }))}
            onReady={() => {}}
          />
        </div>
      ) : (
        <p role="alert" className="text-wait">
          {message}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {onHome ? (
          <button
            type="button"
            className="rounded border border-line bg-ground px-3 py-1.5 font-medium"
            onClick={onHome}
          >
            一覧へ戻る
          </button>
        ) : null}
        <button
          type="button"
          className="rounded border border-line px-3 py-1.5 font-medium"
          onClick={onReload}
        >
          再読み込み
        </button>
      </div>
    </div>
  );
}

export class ShellBoundary extends Component<
  { children: ReactNode; onReload?: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <WindowError
        message="画面を表示できませんでした。再読み込みしてください。"
        onReload={() => {
          this.props.onReload?.();
          this.setState({ failed: false });
        }}
      />
    ) : (
      this.props.children
    );
  }
}
