import type { Result } from "neverthrow";
type OperationError = {
  code: "conflict" | "not_found" | "internal" | "invalid_input" | "runner_unavailable";
  message: string;
};
export type MergeIssue = {
  id: string;
  projectId: string;
  conversationId: string | null;
  usesGithub: boolean;
  state: string;
  stopReason: string | null;
};
export interface MergeRepository {
  get(id: string): MergeIssue | undefined;
  accept(id: string, headSha: string, now: number): void;
}
export type AllowMergeDependencies = {
  repository: MergeRepository;
  deliver(
    conversationId: string,
    text: string,
    accept: () => void,
  ): Promise<Result<void, OperationError>>;
  now(): number;
  changed(issue: MergeIssue): void;
};

export class MergeStateConflict extends Error {
  constructor() {
    super("issue の状態が変わりました。読み直してから操作してください。");
  }
}
