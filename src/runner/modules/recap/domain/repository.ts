export type RecapConversation = {
  id: string;
  path: string;
  cwd: string;
  title: string;
  reflectedSeq: number;
  failedAt: number | null;
};

export type Chapter = { position: number; title: string; startSeq: number };
export type RecapTurn = {
  startSeq: number;
  endSeq: number;
  events: { seq: number; type: string; payload: unknown; createdAt: number }[];
};

export interface RecapRepository {
  get(id: string): RecapConversation | undefined;
  projectPath(projectId: string): string | undefined;
  lastTurn(id: string): { seq: number; createdAt: number } | undefined;
  unfinished(): { id: string; endSeq: number }[];
  nextTurn(id: string, after: number): RecapTurn | undefined;
  chapters(id: string): Chapter[];
  questions(id: string): { id: string; text: string }[];
  fail(id: string, reflectedSeq: number, time: number | null): boolean;
  save(
    id: string,
    reflectedSeq: number,
    turn: RecapTurn,
    summary: {
      title: string | null;
      questions: { id: string; seq: number; text: string }[];
      answered: string[];
    },
  ): void;
}
