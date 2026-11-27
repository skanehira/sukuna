import type { LifecycleSearchResponse } from "../../../../shared/lifecycle";
import type { LifecycleRepository } from "../domain/lifecycle";

const SEARCH_LIMIT = 100;

export function searchLifecycle(
  query: string,
  repository: LifecycleRepository,
): LifecycleSearchResponse {
  const matches = repository.search(query, SEARCH_LIMIT + 1);
  return { results: matches.slice(0, SEARCH_LIMIT), truncated: matches.length > SEARCH_LIMIT };
}
