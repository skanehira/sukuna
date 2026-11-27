import type { Result } from "neverthrow";
import type { z } from "zod";
import type { diffSchema } from "../../../../shared/events";
import type { ContentMatch } from "../../../../shared/files";

export type WorkspaceError = {
  code: "invalid_input" | "not_found" | "conflict" | "internal";
  message: string;
};
export interface FileSystemPort {
  realpath(path: string): Promise<Result<string, WorkspaceError>>;
  lstat(path: string): Promise<Result<{ symbolicLink: boolean }, WorkspaceError>>;
  readlink(path: string): Promise<Result<string, WorkspaceError>>;
  stat(path: string): Promise<Result<{ size: number; directory: boolean }, WorkspaceError>>;
  read(path: string): Promise<Result<Uint8Array, WorkspaceError>>;
}
export interface SearchPort {
  files(cwd: string): Promise<Result<string[], WorkspaceError>>;
  content(
    cwd: string,
    query: string,
  ): Promise<
    Result<{ matches: ContentMatch[]; truncated: boolean; timedOut: boolean }, WorkspaceError>
  >;
}
export interface WorkspaceRepositoryPort {
  conversation(id: string): Result<{ cwd: string } | undefined, WorkspaceError>;
  diffs(id: string): Result<DiffRecord[], WorkspaceError>;
}
export type DiffRecord = { seq: number; createdAt: number; payload: z.infer<typeof diffSchema> };
export interface SearchClockPort {
  schedule(callback: () => void, milliseconds: number): () => void;
}
export type WorkspaceDependencies = {
  fs: FileSystemPort;
  search: SearchPort;
  repository: WorkspaceRepositoryPort;
};
