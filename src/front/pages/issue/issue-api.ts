import { issueResponseSchema, type IssueInput } from "../../../shared/issue/schema";
import { projectSettingsSchema } from "../../../shared/api/project";
import { errorResponseSchema } from "../../../shared/api";
import type { z } from "zod";

export class IssueApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function createIssueApi(fetcher: typeof fetch) {
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    method = "GET",
    input?: IssueInput,
  ): Promise<T> {
    const response = await fetcher(path, {
      method,
      ...(input === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }),
    });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const failure = errorResponseSchema.safeParse(value);
      throw failure.success
        ? new IssueApiError(failure.data.error.code, failure.data.error.message)
        : new IssueApiError("network_error", "issue を取得できませんでした");
    }
    return schema.parse(value);
  }

  const project = (id: string) => `/api/projects/${encodeURIComponent(id)}`;
  const issue = (id: string) => `/api/issues/${encodeURIComponent(id)}`;
  return {
    project: (id: string) => request(project(id), projectSettingsSchema),
    get: async (id: string) => (await request(issue(id), issueResponseSchema)).issue,
    create: async (id: string, input: IssueInput) =>
      (await request(`${project(id)}/issues`, issueResponseSchema, "POST", input)).issue,
    update: async (id: string, input: IssueInput) =>
      (await request(issue(id), issueResponseSchema, "PATCH", input)).issue,
    confirm: async (id: string) =>
      (await request(`${issue(id)}/confirm`, issueResponseSchema, "POST")).issue,
    reopen: async (id: string) =>
      (await request(`${issue(id)}/reopen`, issueResponseSchema, "POST")).issue,
  };
}

export type IssueApi = ReturnType<typeof createIssueApi>;
