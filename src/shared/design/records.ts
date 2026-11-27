import type { IssueState } from "../issue/state";
import type { DesignEvent } from "../api/design";

export type DesignProject = {
  id: string;
  path: string;
  defaultBranch: string;
  usesGithub: boolean;
  designMergeMode: "direct" | "pr";
  flowPaused: boolean;
  autoStages: ("triage" | "design" | "impl")[];
};
export type DesignRecord = {
  issue: { id: string; number: number; title: string; state: IssueState; prUrl: string | null };
  project: DesignProject;
  conversation: { id: string; cwd: string; worktreeId: string | null } | null;
  events: DesignEvent[];
};
