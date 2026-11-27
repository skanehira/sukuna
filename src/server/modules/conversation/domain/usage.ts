import {
  rateLimitReadingSchema,
  type UsageReport,
  type UsageTotals,
} from "../../../../shared/api/usage";
import { eventSchema } from "../../../../shared/events";

const hour = 3_600_000;
export const usagePeriod = 7 * 24 * hour;

type Conversation = {
  id: string;
  projectId: string;
  issueId: string | null;
  parentConversationId: string | null;
};
type Project = { id: string; name: string };
type Issue = { id: string; projectId: string; number: number; title: string };
type UsageEvent = {
  conversationId: string;
  createdAt: number;
  payload: unknown;
  previousCost: number | null;
};
export type UsageRecords = {
  conversations: Conversation[];
  projects: Project[];
  issues: Issue[];
  turns: Iterable<UsageEvent>;
  rateLimit: unknown;
};
type UsageGroup = {
  total: UsageTotals;
  withoutIssue: UsageTotals;
  issues: Map<string, UsageTotals>;
};

function emptyTotals(): UsageTotals {
  return { tokens5h: 0, tokens7d: 0, costUsd7d: 0 };
}

function add(target: UsageTotals, tokens: number, cost: number, within5h: boolean) {
  target.tokens7d += tokens;
  if (within5h) target.tokens5h += tokens;
  target.costUsd7d += cost;
}

function rootResolver(rows: Conversation[]) {
  const conversations = new Map(rows.map((row) => [row.id, row]));
  const roots = new Map<string, Conversation | undefined>();

  return (id: string): Conversation | undefined => {
    let current = conversations.get(id);
    const visited = new Set<string>();
    let root: Conversation | undefined;
    while (current && !visited.has(current.id)) {
      if (roots.has(current.id)) {
        root = roots.get(current.id);
        break;
      }
      visited.add(current.id);
      if (current.parentConversationId === null) {
        root = current;
        break;
      }
      current = conversations.get(current.parentConversationId);
    }
    for (const visitedId of visited) roots.set(visitedId, root);
    return root;
  };
}

export function perTurnCost(current: number, previous: number): number {
  return Math.max(0, current >= previous ? current - previous : current);
}

export function summarizeUsage(records: UsageRecords, now: number): UsageReport {
  const root = rootResolver(records.conversations);
  const projects = new Map(records.projects.map((project) => [project.id, project]));
  const issues = new Map(records.issues.map((issue) => [issue.id, issue]));
  const groups = new Map<string, UsageGroup>();
  for (const turn of records.turns) {
    const parsed = eventSchema.safeParse({ type: "turn_end", payload: turn.payload });
    if (!parsed.success || parsed.data.type !== "turn_end" || turn.createdAt > now) continue;

    const { usage, cost_usd: cumulative } = parsed.data.payload;
    const cost = perTurnCost(cumulative, turn.previousCost ?? 0);
    if (turn.createdAt < now - usagePeriod) continue;

    const owner = root(turn.conversationId);
    if (!owner || !projects.has(owner.projectId)) continue;
    const tokens =
      usage.input_tokens +
      usage.output_tokens +
      usage.cache_creation_input_tokens +
      usage.cache_read_input_tokens;
    if (tokens === 0 && cost === 0) continue;

    const group = groups.get(owner.projectId) ?? {
      total: emptyTotals(),
      withoutIssue: emptyTotals(),
      issues: new Map(),
    };
    groups.set(owner.projectId, group);
    const within5h = turn.createdAt >= now - 5 * hour;
    add(group.total, tokens, cost, within5h);
    const issue = owner.issueId === null ? undefined : issues.get(owner.issueId);
    if (issue?.projectId === owner.projectId) {
      const totals = group.issues.get(issue.id) ?? emptyTotals();
      add(totals, tokens, cost, within5h);
      group.issues.set(issue.id, totals);
    } else add(group.withoutIssue, tokens, cost, within5h);
  }

  const reading = rateLimitReadingSchema.safeParse(records.rateLimit);
  const rateLimit = reading.success
    ? {
        status: reading.data.status,
        resetsAt: reading.data.resetsAt,
        observedAt: reading.data.observedAt,
        usingOverage:
          reading.data.overageStatus === "allowed" ||
          reading.data.overageStatus === "allowed_warning",
      }
    : null;

  return {
    now,
    rateLimit,
    projects: [...groups]
      .map(([projectId, group]) => ({
        projectId,
        name: projects.get(projectId)!.name,
        total: group.total,
        withoutIssue: group.withoutIssue,
        issues: [...group.issues]
          .map(([issueId, totals]) => {
            const { number, title } = issues.get(issueId)!;
            return { issueId, number, title, ...totals };
          })
          .sort((a, b) => b.tokens7d - a.tokens7d || a.number - b.number),
      }))
      .sort(
        (a, b) =>
          b.total.tokens7d - a.total.tokens7d ||
          a.name.localeCompare(b.name, "ja") ||
          a.projectId.localeCompare(b.projectId),
      ),
  };
}
