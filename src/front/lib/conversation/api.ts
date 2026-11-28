import type { ConversationApi } from "./types";

export class ConversationApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function createConversationRequest(fetcher: typeof fetch) {
  return async function request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    read?: (response: Response) => T | Promise<T>,
  ): Promise<T> {
    const response = await fetcher(`/api${path}`, {
      method,
      ...(body === undefined
        ? {}
        : body instanceof File
          ? { headers: { "Content-Type": body.type }, body }
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const value = (await response.json().catch(() => ({
        error: {
          code: response.status === 404 ? "not_found" : "network_error",
          message:
            response.status === 404
              ? "開いた対象が見つかりません。一覧から選び直してください。"
              : "取得できませんでした。再読み込みしてください。",
        },
      }))) as { error: { code: string; message: string } };
      throw new ConversationApiError(response.status, value.error.code, value.error.message);
    }
    if (read) return read(response);
    return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
  };
}

export function createConversationApi(fetcher: typeof fetch): ConversationApi {
  const request = createConversationRequest(fetcher);
  const path = (id: string) => `/conversations/${encodeURIComponent(id)}`;
  return {
    get: (id) => request(path(id)),
    events: (id, after) => request(`${path(id)}/events?after=${after}&limit=2000`),
    projects: async () =>
      (await request<{ projects: Awaited<ReturnType<ConversationApi["projects"]>> }>("/projects"))
        .projects,
    start: (projectId, worktree) =>
      request("/conversations", "POST", {
        projectId,
        workspace: { kind: worktree ? "new_worktree" : "project" },
      }),
    send: (id, body) => request(`${path(id)}/messages`, "POST", body),
    saveDraft: (id, body) => request(`${path(id)}/draft`, "PUT", body),
    saveAnswers: (id, questionSeq, answers) =>
      request(`${path(id)}/answers`, "PUT", { questionSeq, answers }),
    sendAnswers: (id, confirmUnanswered, questionSeq) =>
      request(`${path(id)}/answers/send`, "POST", { questionSeq, confirmUnanswered }),
    permission: (id, requestId, decision) =>
      request(`${path(id)}/permissions/${encodeURIComponent(requestId)}`, "POST", { decision }),
    stop: (id) => request(`${path(id)}/stop`, "POST"),
    resume: (id) => request(`${path(id)}/resume`, "POST"),
    editQueue: (id, item, body) =>
      request(`${path(id)}/queue/${encodeURIComponent(item)}`, "PATCH", body),
    deleteQueue: (id, item) => request(`${path(id)}/queue/${encodeURIComponent(item)}`, "DELETE"),
    sendStock: (id, input) => request(`${path(id)}/stock/send`, "POST", input),
    upload: (id, file) => request(`${path(id)}/images`, "POST", file),
  };
}
