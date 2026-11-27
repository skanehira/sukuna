import type { Result } from "neverthrow";
import type { z } from "zod";
import type { patchTocSchema, RecapResponse } from "../../../../shared/recap/api";
import type { DecisionFileStore, RecapError } from "../../../../shared/recap/ports";
export type { RecapError };
export type RecapContext = {
  projectPath: string;
  title: string;
  recap: RecapResponse;
  lastTurnSeq: number;
};
export type Chapter = { position: number; title: string; startSeq: number };
export interface RecapRepository {
  context(id: string): Result<RecapContext | undefined, RecapError>;
  saveRead(id: string, input: { readSeq?: number; position?: number }): Result<boolean, RecapError>;
  chapters(id: string): Result<Chapter[], RecapError>;
  transaction<T>(
    operation: (repository: RecapRepository) => Result<T, RecapError>,
  ): Result<T, RecapError>;
  patchChapter(
    id: string,
    position: number,
    patch: z.infer<typeof patchTocSchema>,
  ): Result<boolean, RecapError>;
}
export type RecapDependencies = {
  repository: RecapRepository;
  files: DecisionFileStore;
  runner: { rebuild(id: string): Promise<Result<{ state: RecapResponse["state"] }, RecapError>> };
  changed(id: string): void;
};
