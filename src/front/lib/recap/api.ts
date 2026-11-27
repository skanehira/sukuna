import type { z } from "zod";
import type {
  DecisionsResponse,
  RecapResponse,
  TocResponse,
  patchTocSchema,
  putDecisionsSchema,
} from "../../../shared/recap/api";
import { ConversationApiError } from "../conversation/api";
import type { ReadBody } from "./read-tracking";
export type RecapApi = {
  recent(id: string): Promise<RecapResponse>;
  toc(id: string): Promise<TocResponse>;
  decisions(id: string): Promise<DecisionsResponse>;
  read(id: string, body: ReadBody, keepalive: boolean): Promise<void>;
  patchToc(
    id: string,
    position: number,
    body: z.infer<typeof patchTocSchema>,
  ): Promise<TocResponse>;
  putDecisions(id: string, body: z.infer<typeof putDecisionsSchema>): Promise<DecisionsResponse>;
  rebuild(id: string): Promise<{ state: RecapResponse["state"] }>;
};
export function createRecapApi(fetcher: typeof fetch): RecapApi {
  async function request<T>(
    id: string,
    suffix: string,
    method = "GET",
    body?: unknown,
    keepalive = false,
  ): Promise<T> {
    const response = await fetcher(`/api/conversations/${encodeURIComponent(id)}/${suffix}`, {
      method,
      keepalive,
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const value = (await response.json()) as { error: { code: string; message: string } };
      throw new ConversationApiError(response.status, value.error.code, value.error.message);
    }
    return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
  }
  return {
    recent: (id) => request(id, "recap"),
    toc: (id) => request(id, "toc"),
    decisions: (id) => request(id, "decisions"),
    read: (id, body, keepalive) => request(id, "read", "POST", body, keepalive),
    patchToc: (id, position, body) => request(id, `toc/${position}`, "PATCH", body),
    putDecisions: (id, body) => request(id, "decisions", "PUT", body),
    rebuild: (id) => request(id, "recap/rebuild", "POST"),
  };
}
