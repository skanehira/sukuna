import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部システムとの同期: 配信の購読と CodeMirror バッファに表示する行を同期する
import { useEffect } from "react";
import useSWR, { type Key } from "swr";
import type { BufferHandle } from "../../buffer/Buffer";
import type { LineInfo } from "../../buffer/line";
import type { ServerMessage } from "../../../shared/ws";

export type LifecycleFeed = (
  topic: string,
  receive: (message?: ServerMessage) => void,
  after?: number,
) => () => void;

export function useLifecycleData<T>(
  key: Key,
  load: () => Promise<T>,
  subscribe: LifecycleFeed,
  topic: string,
  accepts: (message: ServerMessage) => boolean,
  sequence?: (data: T) => number,
) {
  const { data, error, mutate } = useSWR(key, load, {
    dedupingInterval: 0,
    revalidateOnMount: true,
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  const enabled = key !== null && (!sequence || data !== undefined);
  const after = data === undefined ? undefined : sequence?.(data);
  useEffect(() => {
    if (!enabled) return;
    return subscribe(
      topic,
      (message) => {
        if (!message || accepts(message)) void mutate().catch(() => {});
      },
      after,
    );
  }, [enabled, after, mutate, subscribe, topic, accepts]);
  return { data, error: error as unknown, mutate };
}

export function useBufferLines(lines: LineInfo[], missingCursorTarget?: string) {
  const current = useRef<{ handle: BufferHandle; lines: LineInfo[] } | null>(null);
  useEffect(() => {
    if (current.current && current.current.lines !== lines) {
      current.current.handle.replaceAll(lines, missingCursorTarget);
      current.current.lines = lines;
    }
  }, [lines, missingCursorTarget]);
  return (handle: BufferHandle) => {
    current.current = { handle, lines };
  };
}

export type LifecycleClock = {
  now(): number;
  schedule(callback: () => void, delay: number): () => void;
};

const elapsedInterval = 30_000;

export function useElapsedClock(clock: LifecycleClock) {
  const subscribe = useCallback(
    (callback: () => void) => {
      let cancel = clock.schedule(tick, elapsedInterval);
      function tick() {
        cancel = clock.schedule(tick, elapsedInterval);
        callback();
      }
      return () => cancel();
    },
    [clock],
  );
  const bucket = useSyncExternalStore(subscribe, () => Math.floor(clock.now() / elapsedInterval));
  return useMemo(() => clock.now(), [clock, bucket]);
}

export function inboxChanged(message: ServerMessage) {
  return message.type === "changed";
}
