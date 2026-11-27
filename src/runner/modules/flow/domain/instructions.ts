import type { Stage } from "./evaluate";

const triage = [
  "#<番号>「<題名>」を精査してください。",
  "",
  "- 手順は dev-triage のスキル (~/.claude/skills/dev-triage/SKILL.md と references/) に従ってください。扱う issue はこの 1 件だけです。",
  "- この issue はアプリ sukuna が管理しています。GitHub の issue・ラベル・Project は使わず、issue の読み書きは mcp__sukuna__ のツールで行ってください。スキルの手順は、下の表のとおりに読み替えてください。",
  "- 結果は report_triage で報告してください。人の判断が要るときは report_needs_human で報告してください。報告したら、番を終えてください。",
  "- issue_get で読んだ designed が真なら、設計済みの issue です。採点せず、score を付けずに報告してください。",
  "- 選択式の質問のツール (AskUserQuestion) は使わず、質問は report_needs_human に書いてください。",
  "- プロジェクト: <プロジェクト名> (<パス>)。既定ブランチ: <ブランチ>。GitHub を<使う / 使わない>プロジェクトです。",
  "",
  "| スキルの箇所 | この会話での読み替え |",
  "| --- | --- |",
  "| 前提を確かめる | ラベルと変数は確かめない。GitHub を使うプロジェクトだけ `git fetch origin` を行う。既定ブランチは指示の値を使う |",
  "| 前提を確かめる | GitHub を使うプロジェクトは `origin/<既定ブランチ>`、使わないプロジェクトは手元の既定ブランチから読む |",
  "| 1. 対象を集める | 行わない。扱うのは指示の 1 件だけで、作成者と時間の条件は見ない |",
  "| 2. 読む | `issue_get` で、本文・コメント・親・子・依存先を読む |",
  "| 2. 読む | 見ない |",
  "| 2. 読む | 印は使わない。開発者の回答は、この会話の発言として届く |",
  "| 3. 振り分ける | 使わない |",
  "| 3. 振り分ける | `report_needs_human` で、閉じるか、どこで扱うかを尋ねる |",
  "| 3. 振り分ける | `report_triage` の `result` を `parent` にする |",
  "| 3. 振り分ける | `report_needs_human` で緊急かを尋ねる。開発者が緊急と答えたら、採点せずに `report_triage` を `urgent: true` で報告する |",
  "| 3. 振り分ける | `report_needs_human` で報告する。コメントの型は `references/templates.md` を質問の文に使う |",
  "| 3. 振り分ける | `report_triage` の `result` を `design` にする |",
  "| 3. 振り分ける | `report_triage` の `kind` に `bug` / `enhancement` / `refactoring` / `question` を入れる |",
  "| 4. 採点する | 同じに採点する。本文の末尾に `## 優先度` を足すのは `issue_update` で行う。スコアは `report_triage` の `score` にも入れる |",
  "| 4. 採点する | 同じに行う。親は `issue_get` の `parent` で分かる |",
  "| 4. 採点する | 同じに行う。`report_triage` の `score` にはその値を入れる |",
  "| 5. 反映する | 本文は `issue_update`、コメントは `issue_comment` で書く。ラベルは付けない |",
  "| 5. 反映する | 行わない |",
  "| 5. 反映する | `report_needs_human` で、失敗したことと理由を報告する |",
  "| 6. 最終報告 | `report_triage` の `summary` に 1 行で書く |",
  "| 会話の入口 (`CLAUDE_JOB_DIR`) | 行わない。この会話は issue から開ける |",
].join("\n");

const design = [
  "#<番号>「<題名>」を設計してください。",
  "",
  "- 手順は dev-feat-spec のスキル (~/.claude/skills/dev-feat-spec/SKILL.md) の設計モードに従ってください。扱う issue はこの 1 件だけです。",
  "- この issue はアプリ sukuna が管理しています。GitHub の issue・ラベル・Project は使わず、issue の読み書きは mcp__sukuna__ のツールで行ってください。スキルの手順は、下の表のとおりに読み替えてください。",
  "- 作業ディレクトリ <worktree のパス> は、この issue の設計のための worktree で、ブランチ <ブランチ> を開いています。ブランチを切り替えず、ここで設計書を書いてコミットしてください。push と PR の作成はしないでください。",
  "- 終えたら、コミットしてから report_design で報告してください。人の判断が要るときは report_needs_human で報告してください。報告したら、番を終えてください。",
  "- 選択式の質問のツール (AskUserQuestion) は使わず、質問は report_needs_human に書いてください。",
  "- プロジェクト: <プロジェクト名> (<パス>)。既定ブランチ: <ブランチ>。GitHub を<使う / 使わない>プロジェクトです。",
  "",
  "| スキルの箇所 | この会話での読み替え |",
  "| --- | --- |",
  "| 前提を確かめる | 確かめない。既定ブランチは指示の値を使う |",
  "| 前提を確かめる | 作業ディレクトリ (設計の worktree) で確かめる。差し戻しで再開したときは、前回のコミットの上に続ける |",
  "| 1. 対象を集めて並べる | 行わない。扱うのは指示の 1 件だけである |",
  "| 1. 対象を集めて並べる | 見ない。ブランチは指示のものを使う |",
  "| 2. 1 件ずつ設計する | 行わない。ブランチを切り替えない |",
  "| 3. 読んで振り分ける | `issue_get` で本文とコメントを読む |",
  "| 3. 読んで振り分ける | `report_needs_human` で質問を報告する |",
  "| 3. 読んで振り分ける | 設計書を変えてコミットする。PR は作らない |",
  "| 3. 読んで振り分ける | 本文の書き直しを `issue_update` で反映する。設計書を変えずに報告する |",
  "| 4. 設計書を書く | 飛ばさずに設計する。ほかの issue の設計のブランチ (`sukuna/design-*`) が同じ機能設計書を変えていれば、`report_design` の `checks` に「#<番号> の設計と同じ設計書を変えます」と書く |",
  "| 4. 設計書を書く | 行わない。指示のブランチで書く |",
  "| 4. 設計書を書く | スケッチは直す。画像は撮らない (設計レビューは差分で読む) |",
  "| 5. issue の本文を書き直す | 同じに下書きを作り、`issue-check.sh` を通してから `issue_update` で反映する |",
  "| 5. issue の本文を書き直す | 子は `issue_create` で作る。`parent` にこの issue の番号を、`designed` に `true` を、依存は `depends_on` に入れる。本文の `Depends on #<番号>` の行も残す |",
  "| 6. 別のコンテキストで検査する | 同じに行う。観点 7・8 の「PR の本文」は `report_design` の `policy` と `checks` に読み替える。観点 9 (画面の画像) は行わない |",
  "| 7. 出す | コミットまで行い、`report_design` で報告する。`policy` に修正方針の要約を、`checks` に人に確かめたい点を 1 件ずつ入れる。push・PR・ラベル・コメントは行わない |",
  "| 7. 出す | `report_needs_human` で報告する。ブランチと worktree は消さない |",
  "| 8. 最終報告 | `report_design` の `policy` の最初の 1 行に書く |",
  "| 直しのモード | 使わない。差し戻しの指摘は、この会話の続きに届く。設計書と本文を直し、手順 6 の検査をやり直して、もう一度 `report_design` で報告する。前に分けた子は `issue_update` で直す。要らなくなった子は `report_design` の `checks` に書き、開発者に取り下げを求める |",
  "| 会話の入口 (`CLAUDE_JOB_DIR`) | 行わない |",
].join("\n");

const prompts = { triage, design };

export const resumeDependency = "依存先の取り下げが解消しました。止まったところから続けてください";
export const restartInstruction =
  "ランナーが再起動しました。中断したところから続けてください。直前のツールの実行は結果が分からないので、必要なら確かめ直してください。";
export const missingReport = "結果の報告が無いまま AI が番を終えました";

export function nudgeInstruction(stage: Stage) {
  return `この issue の結果を report_${stage} で報告してください。人の判断が要るときは report_needs_human で報告してください`;
}

export function firstInstruction(
  stage: Stage,
  issue: { number: number; title: string },
  project: { name: string; path: string; defaultBranch: string; usesGithub: boolean },
  tree?: { path: string; branch: string },
  reopened = false,
) {
  const values: Record<string, string> = {
    "<番号>": String(issue.number),
    "<題名>": issue.title,
    "<プロジェクト名>": project.name,
    "<パス>": project.path,
    "<ブランチ>": project.defaultBranch,
    "<worktree のパス>": tree?.path ?? "",
    "<使う / 使わない>": project.usesGithub ? "使う" : "使わない",
  };
  const instructions = prompts[stage]
    .split("\n")
    .map((line) => {
      if (line.startsWith("|")) return line;
      return line.replace(/<[^>]+>/g, (token, index: number) =>
        token === "<ブランチ>" && line.startsWith("- 作業ディレクトリ") && index > 0
          ? (tree?.branch ?? "")
          : (values[token] ?? token),
      );
    })
    .join("\n");
  return reopened
    ? `この issue は再開されました。これまでの会話を踏まえて、もう一度精査してください。\n\n${instructions}`
    : instructions;
}
