export type DecisionItem = {
  id: string;
  kind: "decision" | "rejected" | "pending";
  text: string;
  reason: string | null;
  seq: number | null;
  changedTo: string | null;
};
const kinds = { 決定: "decision", 棄却: "rejected", 保留: "pending" } as const;
const labels = { decision: "決定", rejected: "棄却", pending: "保留" } as const;

export function parseDecisionLine(line: string): DecisionItem | null {
  const match =
    /^- \[(決定|棄却|保留)\] (D[1-9]\d*): (.+?)(?: — (.*?))?(?: → (D[1-9]\d*))?(?: <!-- seq=(\d+) -->)?$/.exec(
      line,
    );
  if (
    !match ||
    !match[3].trim() ||
    / <!-- seq=| → D/.test(match[3]) ||
    (match[4] && / <!-- seq=| → D/.test(match[4]))
  )
    return null;
  return {
    id: match[2],
    kind: kinds[match[1] as keyof typeof kinds],
    text: match[3],
    reason: match[4] ?? null,
    seq: match[6] === undefined ? null : Number(match[6]),
    changedTo: match[5] ?? null,
  };
}
export function parseDecisionFile(content: string): DecisionItem[] {
  return content.split(/\r?\n/).flatMap((line) => {
    const item = parseDecisionLine(line);
    return item ? [item] : [];
  });
}
export function serializeDecision(item: DecisionItem): string {
  return `- [${labels[item.kind]}] ${item.id}: ${item.text}${item.reason === null ? "" : ` — ${item.reason}`}${item.changedTo === null ? "" : ` → ${item.changedTo}`}${item.seq === null ? "" : ` <!-- seq=${item.seq} -->`}`;
}
export function nextDecisionId(content: string): string {
  return `D${Math.max(0, ...parseDecisionFile(content).map((item) => Number(item.id.slice(1)))) + 1}`;
}
export function replaceDecisionItems(content: string, items: DecisionItem[]): string {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  let index = 0;
  const result = lines
    .map((line) => {
      const body = line.replace(/\r?\n$/, "");
      if (!parseDecisionLine(body)) return line;
      const item = items[index++];
      return item ? serializeDecision(item) + (line.endsWith("\n") ? newline : "") : "";
    })
    .join("");
  const remaining = items.slice(index);
  return remaining.length === 0
    ? result
    : result +
        (result && !result.endsWith("\n") ? newline : "") +
        remaining.map(serializeDecision).join(newline) +
        newline;
}
