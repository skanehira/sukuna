import { useSyncExternalStore } from "react";

export type NoticeSnapshot = { error: string | null; info: string | null };
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
    dismissError: () => {
      update({ ...state, error: null });
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
      {state.error !== null ? (
        <div
          role="alert"
          aria-label="エラーのお知らせ"
          className="rounded-md border border-wait/30 bg-surface px-4 py-3 text-wait shadow-lg break-words"
        >
          {state.error}
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
