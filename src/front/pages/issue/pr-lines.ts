import type { PrCheck, PrFile, PrResponse } from "../../../shared/api/pr";
import type { LineInfo } from "../../buffer/line";
import type { PrPosition, QuoteSource } from "../../lib/stock/quote";
import { issuePair } from "./issue-form-lines";

type DiffLine = { path: string; commit: string; position: PrPosition };
export type PrLine = LineInfo & {
  diff?: DiffLine;
  diffPath?: string;
  hiddenDiffPositions?: PrPosition[];
  image?: { alt: string; url: string };
};
type PrLineOptions = {
  github: boolean;
  merged: boolean;
  expanded: ReadonlySet<string>;
  allowMerge?: () => void;
  instruct?: () => void | Promise<void>;
  reload?: () => void | Promise<void>;
  expand?: (path: string) => void;
  openExternal?: (url: string) => void;
};

export const prView = "issue-diff";
const checkLabels: Record<PrCheck["outcome"], string> = {
  success: "成功",
  failure: "失敗",
  running: "実行中",
  queued: "待ち",
  cancelled: "取り消し",
  skipped: "飛ばした",
  other: "そのほか",
};
const note = (text: string): LineInfo => ({ kind: "note", text });
const heading = (text: string): LineInfo => ({ kind: "heading", text });
const section = (text: string): LineInfo => ({ kind: "section", text });
const oneLine = (text: string) => text.replaceAll(/[\r\n]/g, " ");
const menu = (text: string, open?: LineInfo["open"], description = ""): LineInfo => ({
  kind: "menu",
  id: text,
  text,
  cols: [text, description],
  open,
});

function webUrl(text: string): string | undefined {
  try {
    const url = new URL(text);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch {}
}

const urlRow = (text: string, openExternal?: PrLineOptions["openExternal"]): LineInfo => {
  const url = webUrl(text);
  return {
    kind: "row",
    text: oneLine(text),
    open: url && openExternal ? () => openExternal(url) : undefined,
  };
};

function duration(check: PrCheck, fetchedAt: number) {
  const end = check.completedAt ?? (check.outcome === "running" ? fetchedAt : null);
  if (check.startedAt === null || end === null) return "—";
  const seconds = Math.max(0, Math.floor((end - check.startedAt) / 1_000));
  const units = [
    [Math.floor(seconds / 3600), "時間"],
    [Math.floor((seconds % 3600) / 60), "分"],
    [seconds % 60, "秒"],
  ] as const;
  return (
    units
      .filter(([value]) => value > 0)
      .map(([value, unit]) => `${value}${unit}`)
      .join("") || "0秒"
  );
}

const running = (check: PrCheck) => check.outcome === "running" || check.outcome === "queued";
export const runningChecks = (checks: PrCheck[]): boolean => checks.some(running);

function checkRows(checks: PrCheck[], fetchedAt: number): LineInfo[] {
  const success = checks.filter(
    (check) => check.outcome === "success" || check.outcome === "skipped",
  ).length;
  const failure = checks.filter(
    (check) => check.outcome === "failure" || check.outcome === "cancelled",
  ).length;
  return [
    section(`CI  成功 ${success} / 失敗 ${failure} / 実行中 ${checks.filter(running).length}`),
    ...(checks.length
      ? checks.map((check): LineInfo => {
          const cols = [
            oneLine(check.name),
            checkLabels[check.outcome],
            duration(check, fetchedAt),
          ];
          return { kind: "row", text: cols.join("  "), cols, colDef: "pr-checks" };
        })
      : [note("CI の検査はありません")]),
  ];
}

function evidenceRows(
  evidence: PrResponse["evidence"],
  openExternal?: PrLineOptions["openExternal"],
): PrLine[] {
  if (!evidence.markdown.trim()) return [note("動作確認の証跡はありません")];

  const rows: PrLine[] = [];
  const images = new Set(evidence.images.map(({ alt, url }) => JSON.stringify([alt, url])));
  for (const line of evidence.markdown.split(/\r?\n/)) {
    let end = 0;
    for (const match of line.matchAll(/!\[([^\]]*)\]\(<?([^\s>]+)>?(?:\s+"[^"]*")?\)/g)) {
      const [, alt, address] = match;
      if (!images.has(JSON.stringify([alt, address]))) continue;
      if (line.slice(end, match.index).trim()) rows.push(note(line.slice(end, match.index)));
      const url = webUrl(address);
      rows.push({
        ...urlRow(address, openExternal),
        ...(url && { image: { alt, url } }),
      });
      end = match.index + match[0].length;
    }
    const rest = line.slice(end);
    if (end === 0 || rest.trim()) rows.push(note(rest));
  }
  return rows;
}

function diffRows(file: PrFile, commit: string, options: PrLineOptions): PrLine[] {
  const lines = file.hunks.flatMap((hunk) => {
    let old = hunk.oldStart;
    let next = hunk.newStart;
    return hunk.lines.flatMap((text): (PrLine & { diff: DiffLine })[] => {
      const prefix = text[0];
      if (prefix !== "-" && prefix !== "+" && prefix !== " ") return [];
      const position: PrPosition =
        prefix === "-" ? { side: "old", line: old } : { side: "new", line: next };
      if (prefix !== "+") old++;
      if (prefix !== "-") next++;
      return [
        {
          id: JSON.stringify(["pr-line", file.path, position.side, position.line]),
          kind: prefix === "-" ? "del" : prefix === "+" ? "add" : "code",
          text: oneLine(text.slice(1)),
          lineNumber: position.line,
          cursor: true,
          diffPath: file.path,
          diff: { path: file.path, commit, position },
        },
      ];
    });
  });
  const hidden = lines.length > 25 && !options.expanded.has(file.path);
  return [
    {
      ...heading(`${oneLine(file.path)}  +${file.additions} −${file.deletions}`),
      id: `pr-file:${file.path}`,
      diffPath: file.path,
    },
    ...(hidden
      ? [
          ...lines.slice(0, 10),
          {
            ...menu(`残り ${lines.length - 10} 行 (Enter か zo で開く)`, () =>
              options.expand?.(file.path),
            ),
            id: `pr-fold:${file.path}`,
            diffPath: file.path,
            hiddenDiffPositions: lines.slice(10).map(({ diff }) => diff.position),
          },
        ]
      : lines),
  ];
}

function previousUrls(urls: string[], openExternal?: PrLineOptions["openExternal"]): LineInfo[] {
  return urls.length ? [section("以前の PR"), ...urls.map((url) => urlRow(url, openExternal))] : [];
}

const time = new Intl.DateTimeFormat("ja-JP", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function mergePrompt(count: number): string {
  const question = "merge を許可しますか?";
  return count === 0
    ? question
    : `${question} 送っていない指示が ${count} 件あります。許可しても送られずに残ります`;
}

export function prLines(data: PrResponse, options: PrLineOptions): PrLine[] {
  const local = options.merged ? null : data.local;
  const head = data.pr?.headSha ?? local?.headSha;
  const rows: PrLine[] = [];
  if (data.fetchError) {
    const detail = oneLine(data.fetchError).replace(/。$/, "");
    const prefix = "GitHub から PR を取得できませんでした: ";
    const message = detail.startsWith(prefix) ? detail : `${prefix}${detail}`;
    rows.push(note(`${message}。${time.format(data.fetchedAt)} に取得した内容を表示しています`));
  }
  if (data.pr) {
    const pr = data.pr;
    const state =
      pr.state === "merged"
        ? "merge 済み"
        : pr.state === "closed"
          ? "閉じた"
          : data.waitingMergeConfirm
            ? "merge 前の確認"
            : "実装中";
    rows.push(
      heading(`PR #${pr.number} ${oneLine(pr.title)}`),
      issuePair("pr-state", "状況", state),
      issuePair("pr-branches", "ブランチ", oneLine(`${pr.headRefName} → ${pr.baseRefName}`)),
      issuePair(
        "pr-mergeable",
        "merge できるか",
        { mergeable: "できる", conflicting: "ぶつかっている", unknown: "確かめ中" }[pr.mergeable],
      ),
      {
        ...issuePair("pr-url", "URL", oneLine(pr.url)),
        open: urlRow(pr.url, options.openExternal).open,
      },
      ...checkRows(data.checks, data.fetchedAt),
      section("動作確認"),
      ...evidenceRows(data.evidence, options.openExternal),
    );
  } else if (local) {
    rows.push(heading(`実装のブランチ ${oneLine(local.branch)} と既定ブランチの差分`));
  } else {
    rows.push(
      note(
        options.github
          ? "PR はまだありません。実装が終わると、ここに差分と CI の結果が出ます"
          : options.merged
            ? "merge 済みです。変更は会話の差分で見られます"
            : "実装のブランチはまだありません",
      ),
    );
  }
  if (head) {
    if (data.diffTooLarge)
      rows.push(
        note("差分が大きすぎて GitHub から取得できません。Space g のターミナルで確かめてください"),
      );
    else if (data.files.length === 0) rows.push(note("変更はありません"));
    for (const file of data.files)
      rows.push(...diffRows(data.diffTooLarge ? { ...file, hunks: [] } : file, head, options));
  }
  rows.push(...previousUrls(data.earlierPrUrls, options.openExternal));
  const actions: LineInfo[] = [];
  if (data.waitingMergeConfirm && head)
    actions.push({
      ...menu("merge を許可する", options.allowMerge, "CI が通ると merge する"),
      main: true,
    });
  if (data.implConversationId) actions.push(menu("指摘を書いて実装に戻す", options.instruct));
  if (options.github) actions.push(menu("GitHub から読み直す", options.reload));
  if (actions.length) rows.push(section("操作"), ...actions);
  return rows;
}

export function prUnavailableLines(
  message: string,
  reload: LineInfo["open"],
  github: boolean,
): LineInfo[] {
  return [note(oneLine(message)), menu(github ? "GitHub から読み直す" : "再読み込み", reload)];
}

export function prQuoteSources(lines: readonly PrLine[]): readonly QuoteSource[] {
  const byPath = new Map<
    string,
    {
      kind: "pr_diff";
      path: string;
      commit: string;
      positions: (PrPosition | undefined)[];
      hidden?: readonly PrPosition[];
    }
  >();
  for (const [index, { diff, diffPath, hiddenDiffPositions }] of lines.entries()) {
    if (!diff) {
      const source = diffPath && byPath.get(diffPath);
      if (source && hiddenDiffPositions) source.hidden = hiddenDiffPositions;
      continue;
    }
    let source = byPath.get(diff.path);
    if (!source) {
      source = { kind: "pr_diff", path: diff.path, commit: diff.commit, positions: [] };
      byPath.set(diff.path, source);
    }
    source.positions[index] = diff.position;
  }
  return [...byPath.values()];
}
