import {
  nextDecisionId,
  parseDecisionFile,
  replaceDecisionItems,
  type DecisionRecap,
} from "../../../../shared/recap/decision-file";
import type { RecapDelta } from "./turn-summary";

export function addDecisions(content: string, summary: RecapDelta, recap: DecisionRecap) {
  const existing = parseDecisionFile(content);
  const changes = new Map(summary.changes);
  if ([...changes.keys()].some((id) => !existing.some((item) => item.id === id)))
    throw new Error("変わったことを記す元の項目が消えました。");
  const first = BigInt(nextDecisionId(content).slice(1));
  const added = summary.decisions.map((decision, index) => ({
    ...decision,
    id: `D${first + BigInt(index)}`,
    changedTo: null,
  }));
  const updated = existing.map((item) => {
    const targetIndex = changes.get(item.id);
    return targetIndex === undefined ? item : { ...item, changedTo: added[targetIndex].id };
  });
  return replaceDecisionItems(content, [...updated, ...added], recap);
}
