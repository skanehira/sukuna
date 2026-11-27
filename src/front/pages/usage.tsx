import type { UsageRateLimit, UsageReport, UsageTotals } from "../../shared/api/usage";
import { Frame } from "../buffer/Frame";
import type { ColumnDef, LineInfo } from "../buffer/line";
import { LifecycleBuffer } from "../components/lifecycle/LifecycleBuffer";

export const usageTitle = "利用量";
const columns: ColumnDef[] = [
  {
    name: "usage",
    heads: ["名前", "直近 5 時間のトークン", "直近 7 日のトークン", "直近 7 日の料金の目安"],
    widths: [28, 17, 17, 19],
    align: ["left", "right", "right", "right"],
  },
];
const tokenFormat = new Intl.NumberFormat("ja-JP");
const costFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function rateLimitMessage(
  rate: UsageRateLimit,
  formatClock: (at: number) => string,
): string {
  if (rate.status === "rejected" && rate.usingOverage) return "超過分の利用で続けています";
  switch (rate.status) {
    case "allowed":
      return "余裕があります";
    case "allowed_warning":
      return "残りが少なくなっています";
    case "rejected":
      return rate.resetsAt === null
        ? "上限に達しました"
        : `上限に達しました。${formatClock(rate.resetsAt)} に戻ります`;
  }
}

function row(id: string, name: string, totals: UsageTotals, strong = false): LineInfo {
  const cells = [
    name.replace(/[\r\n]/g, " "),
    tokenFormat.format(totals.tokens5h),
    tokenFormat.format(totals.tokens7d),
    costFormat.format(totals.costUsd7d),
  ];
  return { id, kind: "row", colDef: "usage", text: cells.join("  "), cols: cells, strong };
}

export function UsagePage({
  usage,
  formatClock,
  formatObserved,
}: {
  usage: UsageReport;
  formatClock: (at: number) => string;
  formatObserved: (at: number) => string;
}) {
  const { projects, rateLimit } = usage;
  const lines: LineInfo[] = [
    { kind: "heading", text: "利用枠" },
    {
      kind: "note",
      text: rateLimit
        ? rateLimitMessage(rateLimit, formatClock)
        : "まだ分かりません。AI が動くと分かります",
    },
  ];
  if (rateLimit) {
    lines.push({ kind: "note", text: `確認した時刻: ${formatObserved(rateLimit.observedAt)}` });
    if (rateLimit.resetsAt !== null && usage.now >= rateLimit.resetsAt)
      lines.push({ kind: "note", text: "戻る時刻を過ぎました。次に AI が動くと更新されます" });
  }
  lines.push({ kind: "heading", text: "プロジェクトと issue ごとの利用量" });
  if (projects.length === 0) lines.push({ kind: "note", text: "直近 7 日に AI は動いていません" });
  for (const project of projects) {
    lines.push(row(project.projectId, project.name, project.total, true));
    for (const issue of project.issues)
      lines.push(row(issue.issueId, `  #${issue.number} ${issue.title}`, issue));
    lines.push(
      row(project.projectId + ":without-issue", "  issue の無い会話", project.withoutIssue),
    );
  }
  lines.push(
    {
      kind: "note",
      text: "料金の目安は API の料金に換算した値で、サブスクリプションの請求額ではありません",
    },
    { kind: "note", text: "目次などの更新に使った分は含みません" },
  );
  return (
    <Frame title={usageTitle} side="main" columns={columns}>
      <LifecycleBuffer side="main" viewName="usage" columns={columns} lines={lines} />
    </Frame>
  );
}
