import { z } from "zod";
import { toolTarget } from "../../../../shared/activity/last-action";
import type { SummaryInput } from "./summarizer-port";

const number = z.number().int().positive();
const nonBlank = z.string().refine((text) => text.trim().length > 0);
const deltaSchema = z.strictObject({
  chapter: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("continue") }),
    z.strictObject({ kind: z.literal("new"), title: nonBlank }),
  ]),
  decisions: z.array(
    z.strictObject({
      kind: z.enum(["decision", "rejected", "pending"]),
      text: nonBlank,
      reason: z.string().nullable().optional(),
      line: number,
    }),
  ),
  changes: z.array(z.strictObject({ id: z.string(), to: number })),
  questions: z.array(number),
  answered: z.array(z.string()),
});

const linePayload = z.object({
  text: z.string(),
  origin: z.string().optional(),
  parent_tool_use_id: z.string().nullable().optional(),
});
const toolPayload = z.object({ name: z.string(), input: z.unknown() });

type TurnEvent = { seq: number; type: string; payload: unknown };
type Line = { seq: number; text: string };
export function turnLines(events: TurnEvent[], cwd: string) {
  const entries: SummaryInput["entries"] = [];
  const lines = new Map<number, Line>();
  let lastAssistantLines = new Set<number>();
  for (const event of events) {
    if (event.type === "tool_use") {
      const { name, input } = toolPayload.parse(event.payload);
      const label = `${name}(${toolTarget(name, input, cwd)})`.replace(/[\r\n]/g, " ");
      entries.push({ text: `ツール: ${label}` });
      continue;
    }
    if (event.type !== "user_message" && event.type !== "assistant_text") continue;
    const { text, origin, parent_tool_use_id: parentToolUseId } = linePayload.parse(event.payload);
    if (origin === "flow" || origin === "resume" || parentToolUseId) continue;
    const speaker = event.type === "user_message" ? "developer" : "assistant";
    const utterance = new Set<number>();
    for (const line of text.split(/\r\n|\n|\r/)) {
      const number = lines.size + 1;
      lines.set(number, { seq: event.seq, text: line });
      entries.push({ number, speaker, text: line });
      utterance.add(number);
    }
    if (speaker === "assistant") lastAssistantLines = utterance;
  }
  return { entries, lines, lastAssistantLines };
}

const cut = (text: string, length: number) => Array.from(text).slice(0, length).join("");
export function applySummary(
  output: unknown,
  input: SummaryInput,
  { lines, lastAssistantLines }: ReturnType<typeof turnLines>,
) {
  const parsed = deltaSchema.safeParse(output);
  if (!parsed.success) return null;
  const delta = parsed.data;
  if (delta.chapter.kind === "continue" && input.chapters.length === 0) return null;
  const decisions = delta.decisions.flatMap(({ line, text, reason, kind }) => {
    const source = lines.get(line);
    if (!source?.text.trim()) return [];
    return [
      {
        seq: source.seq,
        kind,
        text: cut(text.trim(), 200),
        reason: reason == null ? null : cut(reason, 200),
      },
    ];
  });
  if (decisions.length !== delta.decisions.length) return null;
  const knownDecisions = new Set(input.decisions.map(({ id }) => id));
  const changes = new Map<string, number>();
  for (const { id, to } of delta.changes) {
    if (!knownDecisions.has(id) || !decisions[to - 1] || changes.has(id)) return null;
    changes.set(id, to - 1);
  }
  const addedQuestions = [];
  for (const number of [...new Set(delta.questions)].sort((a, b) => a - b)) {
    const line = lines.get(number);
    if (!lastAssistantLines.has(number) || !line?.text.trim()) return null;
    addedQuestions.push(line);
  }
  const knownQuestions = new Set(input.questions.map(({ id }) => id));
  if (delta.answered.some((id) => !knownQuestions.has(id))) return null;
  return {
    title: delta.chapter.kind === "new" ? cut(delta.chapter.title.trim(), 30) : null,
    decisions,
    changes: [...changes],
    questions: addedQuestions,
    answered: [...new Set(delta.answered)],
  };
}
export type RecapDelta = NonNullable<ReturnType<typeof applySummary>>;
