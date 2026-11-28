import type { IssueRecord } from "../../../../shared/issue/schema";
import type { IssueState } from "../../../../shared/issue/state";

export type ImplementationCandidate = Pick<
  IssueRecord,
  "id" | "number" | "state" | "priority" | "parentId"
> & {
  dependsOn: readonly string[];
  stoppedFrom: IssueState | null;
  busy: boolean;
};

const priority = { low: 0, medium: 1, high: 2 };
const closed = (candidate: ImplementationCandidate) =>
  candidate.state === "done" || candidate.state === "withdrawn";

function blocksChildren(parent: ImplementationCandidate | undefined) {
  const state = parent?.state === "stopped" ? parent.stoppedFrom : parent?.state;
  return state === "design" || state === "design_review";
}

function inheritedPriority(
  candidate: ImplementationCandidate,
  dependents: Map<string, ImplementationCandidate[]>,
) {
  let highest = priority[candidate.priority ?? "medium"];
  const seen = new Set([candidate.id]);
  const pending = [...(dependents.get(candidate.id) ?? [])];
  for (const dependent of pending) {
    if (seen.has(dependent.id)) continue;
    seen.add(dependent.id);
    if (!closed(dependent)) highest = Math.max(highest, priority[dependent.priority ?? "medium"]);
    pending.push(...(dependents.get(dependent.id) ?? []));
  }
  return highest;
}

export function implementationQueue(
  issues: readonly ImplementationCandidate[],
  enabled: boolean,
  limit: number,
) {
  const withdrawn: string[] = [];
  const ready: ImplementationCandidate[] = [];
  if (!enabled) return { start: [], withdrawn };
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const parents = new Set(issues.map((issue) => issue.parentId));
  const dependents = new Map<string, ImplementationCandidate[]>();
  for (const issue of issues) {
    for (const dependency of issue.dependsOn) {
      const list = dependents.get(dependency) ?? [];
      list.push(issue);
      dependents.set(dependency, list);
    }
    if (issue.state !== "ready") continue;
    const prerequisites = issue.dependsOn.map((id) => byId.get(id)?.state);
    if (prerequisites.includes("withdrawn")) withdrawn.push(issue.id);
    else if (
      !issue.busy &&
      !parents.has(issue.id) &&
      !blocksChildren(issue.parentId ? byId.get(issue.parentId) : undefined) &&
      prerequisites.every((state) => state === "done")
    )
      ready.push(issue);
  }
  const used = issues.filter((issue) => issue.state === "implementing").length;
  const start = ready
    .map((issue) => ({ issue, priority: inheritedPriority(issue, dependents) }))
    .sort((a, b) => b.priority - a.priority || a.issue.number - b.issue.number)
    .slice(0, Math.max(0, limit - used))
    .map(({ issue }) => issue.id);
  return { start, withdrawn };
}
