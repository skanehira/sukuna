import type { OpenedDatabase } from "../../../../shared/db/open";
import type { SearchClockPort, WorkspaceDependencies } from "../domain/ports";
import { createFileSystem } from "./fs";
import { createWorkspaceRepository } from "./repository";
import { createRg } from "./rg";

export function createWorkspaceDependencies(
  database: () => OpenedDatabase["db"],
  clock?: SearchClockPort,
): WorkspaceDependencies {
  return {
    fs: createFileSystem(),
    repository: createWorkspaceRepository(database),
    search: createRg(clock),
  };
}
