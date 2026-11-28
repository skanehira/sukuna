import type { ReactNode } from "react";
import useSWR from "swr";
import { meResponseSchema } from "../../shared/api";
import { WindowError } from "./ShellBoundary";

const unavailable = "サーバーの状態を確認できませんでした。再読み込みしてください。";

export type ServerRecovery = { message: string; onReload: () => void };

export function createServerStateLoader(
  fetcher: (url: string) => Promise<Response>,
): () => Promise<true> {
  return async () => {
    const response = await fetcher("/api/me");
    if (!response.ok) throw new Error(unavailable);
    meResponseSchema.parse(await response.json());
    return true;
  };
}

export function ServerConnectionGate({
  load,
  onReload,
  children,
}: {
  load: () => Promise<true>;
  onReload: () => void;
  children: (recovery?: ServerRecovery) => ReactNode;
}) {
  const { data, error, mutate } = useSWR("/api/me", load, { shouldRetryOnError: false });
  if (error && !data) return <WindowError message={unavailable} onReload={onReload} />;
  if (!data)
    return (
      <div role="status" className="p-8 text-muted">
        サーバーにつないでいます
      </div>
    );
  return children(
    error
      ? {
          message: unavailable,
          onReload: () => {
            void mutate().catch(() => undefined);
          },
        }
      : undefined,
  );
}
