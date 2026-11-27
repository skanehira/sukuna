import { err, ok, type Result } from "neverthrow";
import type { ContentSearchResponse, NameSearchResponse } from "../../../../shared/files";
import { searchQuerySchema } from "../../../../shared/files";
import type { WorkspaceDependencies, WorkspaceError } from "../domain/ports";
import { searchNames } from "./search-names";
import { workspaceContext } from "./workspace-context";

export async function searchContent(
  id: string,
  input: { mode: string; q: string },
  deps: WorkspaceDependencies,
): Promise<Result<ContentSearchResponse | NameSearchResponse, WorkspaceError>> {
  const context = await workspaceContext(id, deps);
  if (context.isErr()) return err(context.error);
  const parsed = searchQuerySchema.safeParse(input);
  if (!parsed.success)
    return err({
      code: "invalid_input",
      message:
        input.mode === "content" || input.mode === "name"
          ? "検索する語を入れてください"
          : "検索の種類は content または name を指定してください",
    });
  const { mode, q } = parsed.data;
  if (mode === "name") return searchNames(context.value.cwd, q, deps);
  const results = await deps.search.content(context.value.cwd, q);
  if (results.isErr()) return err(results.error);
  return ok({ mode: "content", query: q, ...results.value });
}
