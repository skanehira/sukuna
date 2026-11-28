import { z } from "zod";
import {
  projectRegistrationResponseSchema,
  projectRemovalResponseSchema,
  projectSettingsSchema,
  type ProjectPatch,
} from "../../shared/api/project";
import { issueRecordSchema } from "../../shared/issue/schema";
import { flowPausedSchema } from "../../shared/settings/settings-schema";

const errorMessage = z.object({ error: z.object({ message: z.string() }) });
const issueProject = z.object({
  issue: z.object({ projectId: issueRecordSchema.shape.projectId }),
});
const json = (method: "PUT" | "POST" | "PATCH", body: object): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const projectPath = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

export class ProjectSettingsRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createProjectSettingsApi(fetcher: typeof fetch) {
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    fallback: string,
    init?: RequestInit,
  ): Promise<T> {
    const response = await fetcher(path, init);
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok)
      throw new ProjectSettingsRequestError(
        response.status,
        errorMessage.safeParse(data).data?.error.message ?? fallback,
      );
    return schema.parse(data);
  }
  return {
    async issueProject(id: string) {
      const response = await fetcher(`/api/issues/${encodeURIComponent(id)}`);
      if (!response.ok) return undefined;
      return issueProject.safeParse(await response.json()).data?.issue.projectId;
    },
    get: (id: string) =>
      request(projectPath(id), projectSettingsSchema, "プロジェクトの設定を読み込めませんでした"),
    register: (path: string) =>
      request(
        "/api/projects",
        projectRegistrationResponseSchema,
        "プロジェクトを登録できませんでした",
        json("POST", { path }),
      ),
    update: (id: string, patch: ProjectPatch) =>
      request(
        projectPath(id),
        projectSettingsSchema,
        "プロジェクトの設定を保存できませんでした",
        json("PATCH", patch),
      ),
    remove: (id: string) =>
      request(
        projectPath(id),
        projectRemovalResponseSchema,
        "プロジェクトの登録を解除できませんでした",
        { method: "DELETE" },
      ),
    pause: (paused: boolean) =>
      request(
        "/api/settings/flow-paused",
        flowPausedSchema,
        "自動フローの設定を保存できませんでした",
        json("PUT", { paused }),
      ),
  };
}

export type ProjectSettingsApi = ReturnType<typeof createProjectSettingsApi>;
