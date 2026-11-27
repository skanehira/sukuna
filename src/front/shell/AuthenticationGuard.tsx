import type { ReactNode } from "react";
import useSWR from "swr";
import { errorResponseSchema, meResponseSchema } from "../../shared/api";
import type { DeniedReason } from "../../shared/denied";
import { Denied } from "../components/denied";
import { WindowError } from "./ShellBoundary";

export type IdentityRecovery = { message: string; onReload: () => void };

export type IdentityResult = { allowed: true } | { allowed: false; reason: DeniedReason };

export function createIdentityLoader(
  fetcher: (url: string) => Promise<Response>,
): () => Promise<IdentityResult> {
  return async () => {
    const response = await fetcher("/api/me");
    if (response.ok) {
      meResponseSchema.parse(await response.json());
      return { allowed: true };
    }
    if (response.status === 401) {
      const { error } = errorResponseSchema.parse(await response.json());
      return {
        allowed: false,
        reason: error.details?.reason === "unavailable" ? "unavailable" : "identity",
      };
    }
    throw new Error("本人の情報を取得できませんでした。再読み込みしてください。");
  };
}

export function AuthenticationGuard({
  load,
  onReload,
  children,
}: {
  load: () => Promise<IdentityResult>;
  onReload: () => void;
  children: (recovery?: IdentityRecovery) => ReactNode;
}) {
  const { data, error, mutate } = useSWR("/api/me", load, { shouldRetryOnError: false });
  if (error && !data?.allowed)
    return (
      <WindowError
        message="本人の情報を取得できませんでした。再読み込みしてください。"
        onReload={onReload}
      />
    );
  if (!data)
    return (
      <div role="status" className="p-8 text-muted">
        本人を確認しています
      </div>
    );
  if (!data.allowed)
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Denied reason={data.reason} onReload={onReload} />
      </div>
    );
  return children(
    error
      ? {
          message: "本人の情報を取得できませんでした。再読み込みしてください。",
          onReload: () => {
            void mutate().catch(() => undefined);
          },
        }
      : undefined,
  );
}
