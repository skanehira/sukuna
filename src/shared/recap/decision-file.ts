import { decisionItemSchema } from "./api";

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
  const item = {
    id: match[2],
    kind: kinds[match[1] as keyof typeof kinds],
    text: match[3],
    reason: match[4] ?? null,
    seq: match[6] === undefined ? null : Number(match[6]),
    changedTo: match[5] ?? null,
  };
  return decisionItemSchema.safeParse(item).success ? item : null;
}
const versionMarker = "<!-- sukuna-decisions:v2 -->";
const recapHeader =
  /^<!-- sukuna-decisions:v3 recap=([1-9]\d*):([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) -->$/;
export type DecisionRecap = { endSeq: number; token: string };

export function readDecisionRecap(content: string): DecisionRecap | undefined {
  const [head] = content.split(/\r?\n/, 1);
  const match = recapHeader.exec(head);
  if (!match) return undefined;
  const endSeq = Number(match[1]);
  return Number.isSafeInteger(endSeq) ? { endSeq, token: match[2] } : undefined;
}
function parseQuotedDecisionLine(line: string): DecisionItem | null {
  const match =
    /^- \[(決定|棄却|保留)\] (D[1-9]\d*): ("(?:[^"\\\r\n]|\\[^\r\n])*")(?: — ("(?:[^"\\\r\n]|\\[^\r\n])*"))?(?: → (D[1-9]\d*))?(?: <!-- seq=(\d+) -->)?$/.exec(
      line,
    );
  if (!match) return null;
  try {
    const text: string = JSON.parse(match[3]);
    const reason: string | null = match[4] === undefined ? null : JSON.parse(match[4]);
    if (!text.trim()) return null;
    const item = {
      id: match[2],
      kind: kinds[match[1] as keyof typeof kinds],
      text,
      reason,
      seq: match[6] === undefined ? null : Number(match[6]),
      changedTo: match[5] ?? null,
    };
    return decisionItemSchema.safeParse(item).success ? item : null;
  } catch {
    return null;
  }
}
const provenancePrefix = "<!-- sukuna-decisions:unmanaged:v1 ";
type Provenance = { token: string; text: string };
type DocumentLine = {
  raw: string;
  body: string;
  control: boolean;
  protected: boolean;
  item: DecisionItem | null;
};
function provenance(body: string): Provenance[] | null {
  if (!body.startsWith(provenancePrefix) || !body.endsWith(" -->")) return null;
  try {
    const value: unknown = JSON.parse(body.slice(provenancePrefix.length, -4));
    if (!Array.isArray(value) || value.length === 0) return null;
    if (
      !value.every(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          typeof entry.token === "string" &&
          /^u[1-9]\d*$/.test(entry.token) &&
          typeof entry.text === "string",
      )
    )
      return null;
    const entries = value as Provenance[];
    return new Set(entries.map((entry) => entry.token)).size === entries.length ? entries : null;
  } catch {
    return null;
  }
}
const marker = (token: string, side: "begin" | "end") =>
  `<!-- sukuna-decisions:unmanaged:${token}:${side} -->`;
function documentLines(content: string): DocumentLine[] {
  const lines: DocumentLine[] = (content.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((raw) => ({
    raw,
    body: raw.replace(/\r?\n$/, ""),
    control: false,
    protected: false,
    item: null,
  }));
  const quoted = lines[0]?.body === versionMarker || readDecisionRecap(content) !== undefined;
  if (quoted) {
    lines[0].control = true;
    const entries = provenance(lines[1]?.body ?? "");
    if (entries) {
      lines[1].control = true;
      for (const entry of entries) {
        const starts = lines.flatMap((line, index) =>
          line.body === marker(entry.token, "begin") ? [index] : [],
        );
        const ends = lines.flatMap((line, index) =>
          line.body === marker(entry.token, "end") ? [index] : [],
        );
        if (starts.length === 1 && ends.length === 1 && starts[0] < ends[0]) {
          lines[starts[0]].control = true;
          lines[ends[0]].control = true;
          if (ends[0] > starts[0] + 1) {
            for (let index = starts[0] + 1; index < ends[0]; index += 1)
              lines[index].protected = true;
            continue;
          }
        }
        const moved = lines.find(
          (line) => !line.control && !line.protected && line.body === entry.text,
        );
        if (moved) moved.protected = true;
      }
    }
  }
  const parse = quoted ? parseQuotedDecisionLine : parseDecisionLine;
  for (const line of lines) {
    if (!line.control && !line.protected) line.item = parse(line.body);
    if (
      !quoted &&
      !line.item &&
      (parseQuotedDecisionLine(line.body) || line.body.startsWith(provenancePrefix))
    )
      line.protected = true;
  }
  return lines;
}
export function parseDecisionFile(content: string): DecisionItem[] {
  return documentLines(content).flatMap((line) => (line.item ? [line.item] : []));
}
export function serializeDecision(item: DecisionItem): string {
  return `- [${labels[item.kind]}] ${item.id}: ${JSON.stringify(item.text)}${item.reason === null ? "" : ` — ${JSON.stringify(item.reason)}`}${item.changedTo === null ? "" : ` → ${item.changedTo}`}${item.seq === null ? "" : ` <!-- seq=${item.seq} -->`}`;
}
export function nextDecisionId(content: string): string {
  const maximum = parseDecisionFile(content).reduce((maximum, item) => {
    const number = BigInt(item.id.slice(1));
    return number > maximum ? number : maximum;
  }, 0n);
  return `D${maximum + 1n}`;
}
export function replaceDecisionItems(
  content: string,
  items: DecisionItem[],
  recap = readDecisionRecap(content),
): string {
  if (content === "" && items.length === 0) return "";
  const lines = documentLines(content);
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const entries: Provenance[] = [];
  let index = 0;
  let tokenNumber = 1;
  const result = lines
    .filter((line) => !line.control)
    .map((line) => {
      if (line.protected) {
        let token: string;
        do {
          token = `u${tokenNumber++}`;
        } while (
          lines.some(
            (line) =>
              !line.control &&
              (line.body === marker(token, "begin") || line.body === marker(token, "end")),
          )
        );
        entries.push({ token, text: line.body });
        return (
          marker(token, "begin") +
          newline +
          line.raw +
          (line.raw.endsWith("\n") ? "" : newline) +
          marker(token, "end") +
          newline
        );
      }
      if (!line.item) return line.raw;
      const item = items[index++];
      return item ? serializeDecision(item) + (line.raw.endsWith("\n") ? newline : "") : "";
    })
    .join("");
  const remaining = items.slice(index);
  const updated =
    remaining.length === 0
      ? result
      : result +
        (result && !result.endsWith("\n") ? newline : "") +
        remaining.map(serializeDecision).join(newline) +
        newline;
  const metadata =
    entries.length === 0
      ? ""
      : provenancePrefix +
        JSON.stringify(entries).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e") +
        " -->" +
        newline;
  const header = recap
    ? `<!-- sukuna-decisions:v3 recap=${recap.endSeq}:${recap.token} -->`
    : versionMarker;
  return header + newline + metadata + updated;
}
