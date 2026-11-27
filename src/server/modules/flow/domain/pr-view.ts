import type { PrCheck, PrFile } from "../../../../shared/api/pr";
import type { Quote } from "../../../../shared/stock";
export type RawCheck = {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string | null;
  detailsUrl?: string | null;
  targetUrl?: string | null;
  runId?: number;
  suiteId?: number;
  appId?: number;
  workflowRunId?: number;
  runAttempt?: number;
};
const time = (value: string | null | undefined) => {
  if (!value || value.startsWith("0001-01-01T")) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
function outcome(c: PrCheck): PrCheck["outcome"] {
  if (c.kind === "status_context")
    return c.state === "success"
      ? "success"
      : ["failure", "error"].includes(c.state ?? "")
        ? "failure"
        : ["pending", "expected"].includes(c.state ?? "")
          ? "running"
          : "other";
  if (c.conclusion) {
    if (c.conclusion === "success") return "success";
    if (["neutral", "skipped"].includes(c.conclusion)) return "skipped";
    if (["failure", "timed_out", "action_required", "startup_failure"].includes(c.conclusion))
      return "failure";
    return c.conclusion === "cancelled" ? "cancelled" : "other";
  }
  return c.status === "in_progress"
    ? "running"
    : ["queued", "waiting", "pending", "requested"].includes(c.status ?? "")
      ? "queued"
      : "other";
}
const rank = { failure: 0, cancelled: 0, running: 1, queued: 2, success: 3, skipped: 3, other: 4 };
export function groupCheckRows(raw: RawCheck[]) {
  const groups = new Map<string, RawCheck[]>();
  for (const row of raw) {
    const name = row.name ?? row.context ?? "";
    groups.set(name, [...(groups.get(name) ?? []), row]);
  }
  return groups;
}
export function latestCheckRows(raw: RawCheck[]) {
  const items: RawCheck[] = [];
  const ambiguousNames: string[] = [];
  for (const [name, rows] of groupCheckRows(raw)) {
    if (rows.length === 1) {
      items.push(rows[0]);
      continue;
    }
    const timed = rows.map((row) => ({
      row,
      at:
        row.__typename === "StatusContext" || row.context !== undefined
          ? (time(row.startedAt) ?? time(row.createdAt))
          : time(row.createdAt),
    }));
    if (timed.some((item) => item.at === null)) {
      ambiguousNames.push(name);
      continue;
    }
    const newest = Math.max(...timed.map((item) => item.at!));
    let candidates = timed.filter((item) => item.at === newest).map((item) => item.row);
    if (
      candidates.length > 1 &&
      candidates[0].workflowRunId !== undefined &&
      candidates.every(
        (row) => row.workflowRunId === candidates[0].workflowRunId && row.runAttempt !== undefined,
      )
    ) {
      const attempt = Math.max(...candidates.map((row) => row.runAttempt!));
      candidates = candidates.filter((row) => row.runAttempt === attempt);
    }
    if (candidates.length === 1) items.push(candidates[0]);
    else ambiguousNames.push(name);
  }
  return { items, ambiguousNames: ambiguousNames.sort((a, b) => a.localeCompare(b)) };
}
export function checksView(raw: RawCheck[]) {
  const selected = latestCheckRows(raw);
  const checks: PrCheck[] = selected.items
    .map((item) => {
      const context = item.__typename === "StatusContext" || item.context !== undefined;
      const check: PrCheck = {
        name: item.name ?? item.context ?? "",
        kind: context ? "status_context" : "check_run",
        status: context ? null : (item.status?.toLowerCase() ?? null),
        conclusion: context ? null : (item.conclusion?.toLowerCase() ?? null),
        state: context ? (item.state?.toLowerCase() ?? null) : null,
        outcome: "other",
        startedAt: context ? (time(item.startedAt) ?? time(item.createdAt)) : time(item.startedAt),
        completedAt: context ? null : time(item.completedAt),
        detailsUrl: item.detailsUrl ?? item.targetUrl ?? null,
      };
      check.outcome = outcome(check);
      return check;
    })
    .sort((a, b) => rank[a.outcome] - rank[b.outcome] || a.name.localeCompare(b.name));
  const counts = { success: 0, failure: 0, running: 0 };
  for (const c of checks) {
    const r = rank[c.outcome];
    if (r === 0) counts.failure++;
    else if (r === 1 || r === 2) counts.running++;
    else if (r === 3) counts.success++;
  }
  return {
    checks,
    counts,
    ...(selected.ambiguousNames.length ? { ambiguousNames: selected.ambiguousNames } : {}),
  };
}
export function evidenceSection(body: string) {
  const lines = body.split(/\r?\n/);
  let level = 0;
  const selected: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (fence === null) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      if (level) selected.push(line);
      continue;
    }
    const heading = fence === null ? line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/) : null;
    if (heading) {
      if (level && heading[1].length === level) break;
      if (!level && heading[2] === "動作確認") {
        level = heading[1].length;
        continue;
      }
    }
    if (level) selected.push(line);
  }
  const markdown = selected.join("\n").trim();
  const images = [...markdown.matchAll(/!\[([^\]]*)\]\(<?([^\s>]+)>?(?:\s+"[^"]*")?\)/g)].map(
    (m) => ({ alt: m[1], url: m[2] }),
  );
  return { markdown, images };
}
function gitPath(value: string) {
  if (!value.startsWith('"')) return value;
  const bytes: number[] = [];
  const inner = value.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && /[0-7]/.test(inner[i + 1] ?? "")) {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 3;
    } else if (inner[i] === "\\") {
      const next = inner[++i];
      const escaped: Record<string, string> = {
        a: "\u0007",
        b: "\b",
        t: "\t",
        n: "\n",
        v: "\v",
        f: "\f",
        r: "\r",
        '"': '"',
        "\\": "\\",
      };
      bytes.push(...new TextEncoder().encode(escaped[next] ?? next));
    } else bytes.push(...new TextEncoder().encode(inner[i]));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
export function parsePrDiff(diff: string): PrFile[] {
  const files: PrFile[] = [];
  let file: PrFile | undefined;
  let hunk: PrFile["hunks"][number] | undefined;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git ("(?:\\.|[^"])*"|a\/.*?) ("(?:\\.|[^"])*"|b\/.*)$/);
      file = {
        path: match ? gitPath(match[2]).slice(2) : "",
        status: "modified",
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (header) {
      hunk = {
        oldStart: Number(header[1]),
        oldLines: Number(header[2] ?? 1),
        newStart: Number(header[3]),
        newLines: Number(header[4] ?? 1),
        lines: [],
      };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk) {
      if (/^[ +-]/.test(line)) {
        hunk.lines.push(line);
        if (line[0] === "+") file.additions++;
        if (line[0] === "-") file.deletions++;
      }
      continue;
    }
    if (line.startsWith("new file mode")) file.status = "added";
    if (line.startsWith("deleted file mode")) file.status = "deleted";
    if (line.startsWith("rename to ")) {
      file.path = gitPath(line.slice(10));
      file.status = "renamed";
    }
    if (line.startsWith("+++ ") && line !== "+++ /dev/null")
      file.path = gitPath(line.slice(4)).slice(2);
    if (line.startsWith("Binary files ") || line === "GIT binary patch") file.binary = true;
  }
  return files;
}
export function canCommentOnLine(quote: Quote | null, headSha: string, files: PrFile[]): boolean {
  if (quote?.kind !== "pr_diff") return false;
  if (quote.commit === headSha) return true;
  const first = quote.text.split("\n")[0];
  for (const hunk of files.find((f) => f.path === quote.path)?.hunks ?? []) {
    let old = hunk.oldStart;
    let current = hunk.newStart;
    for (const line of hunk.lines) {
      const side = quote.start.side;
      const number = side === "old" ? old : current;
      const exists = side === "old" ? line[0] !== "+" : line[0] !== "-";
      if (exists && number === quote.start.line && line.slice(1).startsWith(first)) return true;
      if (line[0] !== "+") old++;
      if (line[0] !== "-") current++;
    }
  }
  return false;
}
