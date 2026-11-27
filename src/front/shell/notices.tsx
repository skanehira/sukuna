import { useSyncExternalStore } from "react";

export type NoticeSnapshot = {
  error: string | null;
  info: string | null;
  result?: string;
  update?: string;
};
export type TimerPort = { schedule(callback: () => void, ms: number): () => void };
export type NoticePort = ReturnType<typeof createNotices>;

export function createNotices(timer: TimerPort) {
  let state: NoticeSnapshot = { error: null, info: null };
  let cancel: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const update = (next: NoticeSnapshot) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify: (message: string, kind: "error" | "info" = "info") => {
      update({ ...state, [kind]: message });
      if (kind === "info") {
        cancel?.();
        cancel = timer.schedule(() => update({ ...state, info: null }), 4000);
      }
    },
    replaceInfoWithResult(previous: string, message: string, kind: "info" | "error") {
      const info = state.info === previous ? null : state.info;
      if (info === null) cancel?.();
      const next = { ...state, info };
      if (kind === "error") {
        next.error = message;
        delete next.result;
      } else {
        next.result = message;
      }
      update(next);
    },
    showUpdate: (message: string) => update({ ...state, update: message }),
    dismissError: () => {
      update({ error: null, info: state.info });
    },
    dispose: () => {
      cancel?.();
    },
  };
}

export function Notices({ notices }: { notices: NoticePort }) {
  const state = useSyncExternalStore(notices.subscribe, notices.snapshot);
  return (
    <div className="pointer-events-none absolute bottom-9 right-2 z-20 flex max-w-[calc(100%-1rem)] flex-col gap-2 text-[13px]">
      {state.update !== undefined ? (
        <div
          role="alert"
          aria-label="アプリの更新"
          className="rounded-md border border-wait/30 bg-surface px-4 py-3 text-wait shadow-lg break-words"
        >
          {state.update}
        </div>
      ) : null}
      {state.error !== null ? (
        <div
          role="alert"
          aria-label="エラーのお知らせ"
          className="rounded-md border border-wait/30 bg-surface px-4 py-3 text-wait shadow-lg break-words"
        >
          {state.error}
        </div>
      ) : null}
      {state.result !== undefined ? (
        <div
          role="status"
          aria-label="操作の結果"
          className="rounded-md border border-line bg-surface px-4 py-3 text-ink shadow-lg break-words"
        >
          {state.result}
        </div>
      ) : null}
      {state.info !== null ? (
        <div
          role="status"
          aria-label="お知らせ"
          className="rounded-md border border-line bg-surface px-4 py-3 text-ink shadow-lg break-words"
        >
          {state.info}
        </div>
      ) : null}
    </div>
  );
}
