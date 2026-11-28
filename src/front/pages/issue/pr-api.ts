import {
  allowMergeResponseSchema,
  prResponseSchema,
  publishResponseSchema,
} from "../../../shared/api/pr";
import { createConversationRequest } from "../../lib/conversation/api";

export function createPrApi(fetcher: typeof fetch) {
  const request = createConversationRequest(fetcher);
  const scope = (id: string) => `/issues/${encodeURIComponent(id)}/pr`;
  return {
    get: async (id: string) => prResponseSchema.parse(await request(scope(id))),
    allowMerge: async (id: string, headSha: string) =>
      allowMergeResponseSchema.parse(
        await request(`${scope(id)}/allow-merge`, "POST", { headSha }),
      ),
    publish: async (id: string, stockIds: string[]) =>
      publishResponseSchema.parse(
        await request(`${scope(id)}/comments/publish`, "POST", { stockIds }),
      ),
  };
}
export type PrApi = ReturnType<typeof createPrApi>;
