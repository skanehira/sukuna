import type { Result } from "neverthrow";
import type { DecisionItem } from "./decision-file";
export type RecapError = {
  code: "invalid_input" | "not_found" | "conflict" | "internal" | "runner_unavailable";
  message: string;
};
export type DecisionSnapshot = {
  path: string;
  exists: boolean;
  hash: string | null;
  content: string;
  items: DecisionItem[];
};
export interface DecisionFileStore {
  read(projectPath: string, conversationId: string): Result<DecisionSnapshot, RecapError>;
  update(
    projectPath: string,
    conversationId: string,
    title: string,
    transform: (content: string) => string,
    baseHash?: string | null,
  ): Result<DecisionSnapshot, RecapError>;
}
