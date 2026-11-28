import type { TimelineAnchor } from "../../../../shared/progress/draft";
import type { DesignFile } from "../../../../shared/api/design";
import type { DesignRecord } from "../../../../shared/design/records";
import type { DesignRejectionDraft } from "../../../../shared/ipc";
import type { Logger } from "../../../../shared/log";

export type DesignDependencies = {
  read(id: string):
    | (DesignRecord & {
        unsentInstructionCount: number;
        draft?: DesignRejectionDraft & { timelineAnchors?: TimelineAnchor[] | null };
      })
    | null;
  git: {
    diff(cwd: string, base: string, head: string): Promise<DesignFile[] | null>;
    head(cwd: string, branch: string): Promise<string | null>;
  };
  runner: { forward(method: string, path: string, input: unknown): Promise<Response> };
  log: Logger;
};
