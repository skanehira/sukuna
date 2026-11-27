import {
  changesResponseSchema,
  contentSearchResponseSchema,
  fileContentResponseSchema,
  filesResponseSchema,
  nameSearchResponseSchema,
  type ChangesResponse,
  type ContentSearchResponse,
  type FileContentResponse,
  type FilesResponse,
  type NameSearchResponse,
} from "../../../shared/files";
import { threadsResponseSchema, type Thread } from "../../../shared/stock";
import type { z } from "zod";
import { ConversationApiError } from "../conversation/api";

export type FilesApi = {
  list(this: void, id: string, signal?: AbortSignal): Promise<FilesResponse>;
  content(this: void, id: string, path: string, signal?: AbortSignal): Promise<FileContentResponse>;
  search(
    this: void,
    id: string,
    mode: "content" | "name",
    query: string,
    signal: AbortSignal,
  ): Promise<ContentSearchResponse | NameSearchResponse>;
  changes(this: void, id: string, signal?: AbortSignal): Promise<ChangesResponse>;
  threads(this: void, id: string, signal: AbortSignal): Promise<Thread[]>;
};

export function createFilesApi(fetcher: typeof fetch): FilesApi {
  async function get<T>(
    id: string,
    suffix: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetcher(`/api/conversations/${encodeURIComponent(id)}${suffix}`, {
      signal,
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ConversationApiError(
        response.status,
        value?.error?.code ?? "network_error",
        value?.error?.message ?? "取得できませんでした。再読み込みしてください。",
      );
    }
    return schema.parse(value);
  }
  return {
    list: (id, signal) => get(id, "/files", filesResponseSchema, signal),
    content: (id, path, signal) =>
      get(id, `/files/content?${new URLSearchParams({ path })}`, fileContentResponseSchema, signal),
    search: (id, mode, q, signal) => {
      const url = `/search?${new URLSearchParams({ mode, q })}`;
      return mode === "content"
        ? get(id, url, contentSearchResponseSchema, signal)
        : get(id, url, nameSearchResponseSchema, signal);
    },
    changes: (id, signal) => get(id, "/changes", changesResponseSchema, signal),
    threads: async (id, signal) =>
      (await get(id, "/threads", threadsResponseSchema, signal)).threads,
  };
}
