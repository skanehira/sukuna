import {
  initialRestoreGeneration,
  restoreGenerationCheckHeader,
  restoreGenerationHeader,
  restoreRequestHeader,
} from "../../shared/settings/restore-schema";
import { isReadOnlyHttpMethod } from "../../shared/api";
import { forgetStoredOpenings } from "./recap/read-tracking";

const generationKey = "sukuna:restore:generation";

export function createRestoreConnection({
  fetcher,
  origin,
  storage,
  reload,
}: {
  fetcher: typeof fetch;
  origin: string;
  storage: Storage;
  reload: (requestId: string | null) => void;
}) {
  let observed: string | undefined;
  let reloading = false;
  function observe(response: Response): void {
    if (reloading) return;
    const generation = response.headers.get(restoreGenerationHeader) ?? initialRestoreGeneration;
    if (observed === undefined) {
      observed = generation;
      try {
        const previous = storage.getItem(generationKey);
        if ((previous || initialRestoreGeneration) !== generation) forgetStoredOpenings(storage);
        if (previous !== generation) storage.setItem(generationKey, generation);
      } catch {
        return;
      }
    } else if (generation !== observed) {
      reloading = true;
      reload(response.headers.get(restoreRequestHeader));
    }
  }
  async function readIdentity(url: string, signal?: AbortSignal): Promise<Response> {
    const response = await fetcher(url, { cache: "no-store", signal });
    if (response.ok && !signal?.aborted) observe(response);
    return response;
  }
  const request: typeof fetch = async (input, init) => {
    const original = input instanceof Request ? input : undefined;
    if (isReadOnlyHttpMethod(init?.method ?? original?.method ?? "GET"))
      return fetcher(input, init);
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
      origin,
    );
    if (url.origin !== origin || !url.pathname.startsWith("/api/")) return fetcher(input, init);
    if (observed === undefined || reloading)
      throw new Error("データベースを確認してから変更を保存してください。");
    const headers = new Headers(init?.headers ?? original?.headers);
    headers.set(restoreGenerationCheckHeader, observed);
    const response = await fetcher(input, { ...init, headers });
    if (response.status === 409 && response.headers.has(restoreGenerationHeader)) observe(response);
    return response;
  };
  return {
    readIdentity,
    request,
    async verify(
      signal?: AbortSignal,
      onVerified?: (response: Response, signal?: AbortSignal) => Promise<void>,
    ) {
      const response = await readIdentity("/api/me", signal);
      if (!response.ok || reloading || signal?.aborted) return false;
      await onVerified?.(response, signal);
      return !reloading && !signal?.aborted;
    },
    reloading: () => reloading,
  };
}
