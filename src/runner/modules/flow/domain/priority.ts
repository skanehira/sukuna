import type { IssueRecord } from "../../../../shared/issue/schema";

type IssuePriority = NonNullable<IssueRecord["priority"]>;

export function triagePriority(
  urgent: boolean,
  parent: IssuePriority | null | undefined,
  score: number | undefined,
): IssuePriority {
  if (urgent) return "high";
  if (parent) return parent;
  if (score === undefined) return "medium";
  if (score >= 9) return "high";
  return score >= 3 ? "medium" : "low";
}
