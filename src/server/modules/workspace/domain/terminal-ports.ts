import type { Result } from "neverthrow";
import type { OpenTerminalInput, TerminalOpened } from "../../../../shared/api/terminal";
import type { WorktreeActivity } from "../../../../shared/workspace/worktree-activity";

export type TerminalError = {
  code: "not_found" | "conflict" | "internal";
  message: string;
};

export type TerminalLocation = {
  projectId: string;
  worktreeId: string | null;
  path: string;
  label: string;
};

export interface TerminalSessionsPort {
  open(
    location: TerminalLocation,
    input: Pick<OpenTerminalInput, "cols" | "rows" | "conversationId">,
  ): Result<TerminalOpened, TerminalError>;
  runningId(path: string): string | null;
  endAt(path: string): Promise<void>;
}

export type TerminalDependencies = {
  location(input: OpenTerminalInput): Result<TerminalLocation, TerminalError>;
  sessions: TerminalSessionsPort;
  activity: Pick<WorktreeActivity, "acquire">;
};
