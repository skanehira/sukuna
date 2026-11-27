export type SummaryInput = {
  chapters: { position: number; title: string }[];
  decisions: { id: string; kind: string; text: string }[];
  questions: { id: string; text: string }[];
  entries: (
    | { number: number; speaker: "developer" | "assistant"; text: string }
    | { text: string }
  )[];
};

export interface SummarizerPort {
  summarize(input: SummaryInput, signal: AbortSignal): Promise<unknown>;
}
