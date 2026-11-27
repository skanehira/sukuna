import useSWR from "swr";
import type { FilesApi } from "./api";

export function useFileChanges(api: FilesApi, id: string) {
  return useSWR(["file-changes", id], () => api.changes(id), {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    shouldRetryOnError: false,
  });
}
