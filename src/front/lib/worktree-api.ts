import { z } from "zod";
import {
  worktreeCreatedSchema,
  worktreeListSchema,
  worktreeRemovedSchema,
} from "../../shared/api/worktree";
import { terminalOpenedSchema, type OpenTerminalInput } from "../../shared/api/terminal";
import { createConversationRequest, ConversationApiError } from "./conversation/api";

const issueLocation = z.object({
  issue: z.object({
    projectId: z.string(),
    state: z.string(),
    stoppedFrom: z.string().optional(),
    conversations: z.array(z.object({ id: z.string(), kind: z.string() })),
  }),
});

const trees = (project: string) => `/projects/${encodeURIComponent(project)}/worktrees`;
export function createWorktreeApi(fetcher: typeof fetch) {
  const request = createConversationRequest(fetcher);
  return {
    list: async (project: string) =>
      worktreeListSchema.parse(await request(trees(project))).worktrees,
    create: async (project: string, name: string) =>
      worktreeCreatedSchema.parse(await request(trees(project), "POST", { name })),
    remove: async (id: string) =>
      worktreeRemovedSchema.parse(await request(`/worktrees/${encodeURIComponent(id)}`, "DELETE")),
    switch: (id: string, worktreeId: string | null) =>
      request<unknown>(`/conversations/${encodeURIComponent(id)}/workspace`, "PUT", { worktreeId }),
    issue: async (id: string) =>
      issueLocation.parse(await request(`/issues/${encodeURIComponent(id)}`)).issue,
    openTerminal: async (input: OpenTerminalInput) =>
      terminalOpenedSchema.parse(await request("/terminals", "POST", input)),
    terminalExists: async (id: string, signal: AbortSignal) => {
      const response = await fetcher(`/api/terminals/${encodeURIComponent(id)}`, {
        method: "HEAD",
        cache: "no-store",
        signal,
      });
      if (response.status === 404) return false;
      if (response.status === 204) return true;
      throw new ConversationApiError(
        response.status,
        "network_error",
        "ターミナルにつながりません",
      );
    },
  };
}

export type WorktreeApi = ReturnType<typeof createWorktreeApi>;
