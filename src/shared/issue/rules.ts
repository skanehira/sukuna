import { issueInputSchema, type IssueRecord } from "./schema";
import type { IssueWriteInput } from "./ports";
export type IssueRuleError = {
  code: "invalid_input" | "dependency_cycle" | "parent_cycle";
  message: string;
};
export type IssueLinks = { number: number; parentNumber: number | null; dependsOn: number[] };

export function validateIssueInput(input: unknown) {
  const parsed = issueInputSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function validateIssueLinks(
  graph: IssueLinks[],
  number: number,
  parentNumber: number | null,
  dependsOn: number[],
): IssueRuleError | null {
  const nodes = new Map(graph.map((node) => [node.number, node]));
  nodes.set(number, { number, parentNumber, dependsOn });
  for (const target of [...(parentNumber === null ? [] : [parentNumber]), ...dependsOn]) {
    if (!nodes.has(target))
      return { code: "invalid_input", message: `#${target} はこのプロジェクトにありません` };
  }
  for (const relation of ["dependsOn", "parentNumber"] as const) {
    const path: number[] = [];
    const active = new Set<number>();
    const visited = new Set<number>();
    const pending: { number: number; exit: boolean }[] = [{ number, exit: false }];
    while (pending.length) {
      const next = pending.pop()!;
      if (next.exit) {
        active.delete(next.number);
        path.pop();
        continue;
      }
      if (active.has(next.number)) {
        const cycle = [...path.slice(path.indexOf(next.number)), next.number];
        return {
          code: relation === "dependsOn" ? "dependency_cycle" : "parent_cycle",
          message: `${cycle.map((n) => `#${n}`).join(" → ")} が循環しています。${relation === "dependsOn" ? "依存" : "親"}を保存しませんでした`,
        };
      }
      if (visited.has(next.number)) continue;
      visited.add(next.number);
      active.add(next.number);
      path.push(next.number);
      pending.push({ ...next, exit: true });
      const node = nodes.get(next.number);
      const targets =
        relation === "dependsOn"
          ? (node?.dependsOn ?? [])
          : node?.parentNumber == null
            ? []
            : [node.parentNumber];
      for (const target of [...targets].reverse()) pending.push({ number: target, exit: false });
    }
  }
  return null;
}

export function prepareIssueWrite(
  issue: IssueRecord,
  input: IssueWriteInput,
  rows: IssueRecord[],
  graph: IssueLinks[],
) {
  const parentNumber =
    input.parentNumber === undefined
      ? (rows.find((row) => row.id === issue.parentId)?.number ?? null)
      : input.parentNumber;
  const dependsOn =
    input.dependsOn ?? graph.find((node) => node.number === issue.number)?.dependsOn ?? [];
  const error = validateIssueLinks(graph, issue.number, parentNumber, dependsOn);
  if (error) return { error };
  const { parentNumber: _parent, dependsOn: _depends, ...fields } = input;
  return {
    fields: {
      ...fields,
      parentId: parentNumber === null ? null : rows.find((row) => row.number === parentNumber)!.id,
    },
    dependencies: dependsOn.map((number) => rows.find((row) => row.number === number)!.id),
  };
}

export function newIssue(
  id: string,
  projectId: string,
  number: number,
  now: number,
  confirmBeforeMerge: boolean,
): IssueRecord {
  return {
    id,
    projectId,
    number,
    title: "",
    body: "",
    kind: null,
    state: "draft",
    stopReason: null,
    parentId: null,
    priority: null,
    designed: false,
    confirmBeforeMerge,
    prUrl: null,
    githubNumber: null,
    createdConversationId: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
}
