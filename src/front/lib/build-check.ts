import { meResponseSchema } from "../../shared/api";

const updateMessage = "アプリが更新されました。再読み込みすると新しい版になります。";

export function createBuildCheck({
  build,
  show,
}: {
  build: string;
  show: (message: string) => void;
}) {
  let lastObserved = build;

  async function observe(response: Response, signal?: AbortSignal): Promise<void> {
    if (!response.ok) return;
    try {
      const result = meResponseSchema.safeParse(await response.clone().json());
      if (!result.success || signal?.aborted) return;
      const next = result.data.build;
      if (next === lastObserved) return;
      lastObserved = next;
      if (next !== build) show(updateMessage);
    } catch {
      return;
    }
  }

  return {
    observe,
    watchChunks(target: Pick<EventTarget, "addEventListener" | "removeEventListener">): () => void {
      const report = () => show(updateMessage);
      target.addEventListener("vite:preloadError", report);
      return () => target.removeEventListener("vite:preloadError", report);
    },
  };
}
