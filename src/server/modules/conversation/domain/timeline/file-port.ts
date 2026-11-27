import type { TimelineFile } from "../../../../../shared/progress/schema";

export type TimelineRead = { file: TimelineFile | null; readError: string | null };
export interface TimelineFilePort {
  read(sessionId: string): Promise<TimelineRead>;
}
