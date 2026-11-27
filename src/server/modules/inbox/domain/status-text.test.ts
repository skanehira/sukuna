import { expect, it } from "vite-plus/test";
import { statusText } from "./status-text";
it.each([
  ["design_review", {}, "設計の承認", "設計の承認を待っています"],
  ["merge_confirm", {}, "merge 前の確認", "merge 前の確認を待っています"],
  ["question", { stopped: true, detail: "方針\n次の行" }, "質問: 方針", "方針"],
  ["failed", { detail: "失敗の理由\n次の行" }, "失敗: 失敗の理由", "失敗: 失敗の理由"],
  ["failed", {}, "失敗", "失敗"],
  ["ci_failed", { detail: "lint\r\n後続" }, "CI の失敗: lint", "CI が失敗しました: lint"],
  [
    "dependency_withdrawn",
    { detail: "#3\n#4" },
    "依存先 #3 の取り下げ",
    "依存先 #3 が取り下げられました",
  ],
  [
    "usage_limit",
    {},
    "利用枠切れで停止 (15 分ごとに再開を試みる)",
    "利用枠を使い切りました。15 分ごとに再開を試みます",
  ],
  [
    "usage_limited",
    {},
    "利用枠切れで停止 (15 分ごとに再開を試みる)",
    "利用枠を使い切りました。15 分ごとに再開を試みます",
  ],
  [
    "usage_limited",
    { resetTime: "12:34" },
    "利用枠切れで停止 (12:34 に再開)",
    "利用枠を使い切りました。12:34 に自動で再開します",
  ],
  ["question", { questions: ["一つ目\n続き", "二つ目"] }, "質問 2 件: 一つ目 ほか", "一つ目"],
  ["question", { questions: ["一つ目"] }, "質問 1 件: 一つ目", "一つ目"],
  [
    "permission",
    { tool: "Bash", target: "vp test\n次の行" },
    "許可の確認: Bash",
    "許可の確認: Bash(vp test)",
  ],
  ["turn_ended", { lastText: "AI の発言\n続き" }, "AI の発言", "AI の発言"],
  ["stopped_by_user", {}, "止めました", ""],
  [
    "restarted",
    {},
    "再起動で止まりました",
    "再起動で作業が止まりました。再開するか指示を送ると続けます",
  ],
  ["working", {}, "", ""],
  ["summarizing", {}, "応答をまとめています", ""],
  ["flow_waiting", { flowPaused: true, stageExcluded: true }, "自動フローを一時停止しています", ""],
  ["flow_waiting", { stageExcluded: true }, "自動で処理しない段階です", ""],
  ["flow_waiting", {}, "開始を待っています", ""],
  [
    "thread",
    { thread: { status: "失敗: 理由", notice: "失敗: 理由" }, threadAnswers: 2 },
    "スレッドの回答 2 件 · スレッド: 失敗: 理由",
    "失敗: 理由",
  ],
] as const)("理由 %s の文言を1行で返す", (reason, input, status, notice) => {
  expect(statusText(reason, input)).toEqual({
    status,
    notice,
  });
});
it("通知の本文は120文字で切り、状況の列幅での切り詰めはしない", () => {
  expect(statusText("turn_ended", { lastText: "あ".repeat(121) })).toEqual({
    status: "あ".repeat(121),
    notice: `${"あ".repeat(120)}…`,
  });
});
