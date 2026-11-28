import type { ConversationDraft } from "../../../shared/conversation/api";
import type { z } from "zod";
import {
  approveDesignResponseSchema,
  designResponseSchema,
  rejectDesignResponseSchema,
} from "../../../shared/api/design";
import { errorResponseSchema } from "../../../shared/api";

export function createDesignApi(fetcher: typeof fetch) {
  async function request<T>(path: string, schema: z.ZodType<T>, input?: object): Promise<T> {
    const response = await fetcher(
      path,
      input
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          }
        : undefined,
    );
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const failure = errorResponseSchema.safeParse(body);
      throw new Error(failure.success ? failure.data.error.message : "設計を取得できませんでした");
    }
    return schema.parse(body);
  }
  const path = (id: string) => `/api/issues/${encodeURIComponent(id)}/design`;
  return {
    get: (id: string) => request(path(id), designResponseSchema),
    approve: (id: string, headCommit: string) =>
      request(`${path(id)}/approve`, approveDesignResponseSchema, { headCommit }),
    reject: (id: string, text: string, draft?: ConversationDraft | null) =>
      request(`${path(id)}/reject`, rejectDesignResponseSchema, { text, draft }),
  };
}

export type DesignApi = ReturnType<typeof createDesignApi>;
