import { z } from "zod";
import {
  githubImportResponseSchema,
  githubIssuesResponseSchema,
} from "../../shared/api/github-import";
import { usageResponseSchema } from "../../shared/api/usage";

const problem = z.object({ error: z.object({ message: z.string() }) });

export function createProjectUsageApi(fetcher: typeof fetch) {
  const request = async (path: string, init?: RequestInit): Promise<unknown> => {
    const response = await fetcher(path, init);
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(
        problem.safeParse(body).data?.error.message ?? "データを読み込めませんでした。",
      );
    return body;
  };
  const projectUrl = (id: string) => `/api/projects/${encodeURIComponent(id)}`;
  return {
    candidates: async (id: string) =>
      githubIssuesResponseSchema.parse(await request(`${projectUrl(id)}/github-issues`)),
    importIssues: async (id: string, numbers: number[]) =>
      githubImportResponseSchema.parse(
        await request(`${projectUrl(id)}/github-import`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ numbers }),
        }),
      ),
    usage: async () => usageResponseSchema.parse(await request("/api/usage")),
  };
}
