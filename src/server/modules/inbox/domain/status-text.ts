import type { InboxRow } from "../../../../shared/inbox/schema";
export type StatusContext = {
  stopped?: boolean;
  detail?: string;
  resetTime?: string;
  questions?: readonly string[];
  tool?: string;
  target?: string;
  lastText?: string;
  flowPaused?: boolean;
  stageExcluded?: boolean;
  thread?: { status: string; notice: string };
  threadAnswers?: number;
};
export function firstLine(text: string): string {
  return text.split(/\r?\n/)[0] ?? "";
}
export function statusText(
  reason: InboxRow["reason"],
  input: StatusContext,
): { status: string; notice: string } {
  const detail = firstLine(input.detail ?? "");
  const suffix = detail ? `: ${detail}` : "";
  let status = "";
  let notice = "";
  switch (reason) {
    case "design_review":
      status = "設計の承認";
      notice = "設計の承認を待っています";
      break;
    case "merge_confirm":
      status = "merge 前の確認";
      notice = "merge 前の確認を待っています";
      break;
    case "question": {
      const questions = input.questions ?? [];
      const first = firstLine(questions[0] ?? "");
      status = input.stopped
        ? `質問${suffix}`
        : `質問 ${questions.length} 件${first ? `: ${first}` : ""}${questions.length > 1 ? " ほか" : ""}`;
      notice = input.stopped ? detail || "質問" : first;
      break;
    }
    case "failed":
      status = `失敗${suffix}`;
      notice = status;
      break;
    case "ci_failed":
      status = `CI の失敗${suffix}`;
      notice = `CI が失敗しました${suffix}`;
      break;
    case "dependency_withdrawn":
      status = detail ? `依存先 ${detail} の取り下げ` : "依存先の取り下げ";
      notice = detail ? `依存先 ${detail} が取り下げられました` : "依存先が取り下げられました";
      break;
    case "usage_limit":
    case "usage_limited":
      status = `利用枠切れで停止 (${input.resetTime ? `${input.resetTime} に再開` : "15 分ごとに再開を試みる"})`;
      notice = input.resetTime
        ? `利用枠を使い切りました。${input.resetTime} に自動で再開します`
        : "利用枠を使い切りました。15 分ごとに再開を試みます";
      break;
    case "permission":
      status = `許可の確認: ${firstLine(input.tool ?? "")}`;
      notice = `${status}${input.target ? `(${firstLine(input.target)})` : ""}`;
      break;
    case "thread":
      status = `スレッド: ${input.thread?.status ?? ""}`;
      notice = input.thread?.notice ?? "";
      break;
    case "turn_ended":
      status = firstLine(input.lastText ?? "");
      notice = status;
      break;
    case "stopped_by_user":
      status = "止めました";
      break;
    case "restarted":
      status = "再起動で止まりました";
      notice = "再起動で作業が止まりました。再開するか指示を送ると続けます";
      break;
    case "summarizing":
      status = "応答をまとめています";
      break;
    case "flow_waiting":
      status = input.flowPaused
        ? "自動フローを一時停止しています"
        : input.stageExcluded
          ? "自動で処理しない段階です"
          : "開始を待っています";
      break;
    case "working":
      break;
  }
  if ((input.threadAnswers ?? 0) > 0 && reason !== "working")
    status = `スレッドの回答 ${input.threadAnswers} 件 · ${status}`;
  const chars = Array.from(notice);
  return { status, notice: chars.length > 120 ? `${chars.slice(0, 120).join("")}…` : notice };
}
