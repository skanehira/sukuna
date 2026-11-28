import type { IssueRecord } from "../../../../shared/issue/schema";
import type { StageProject } from "./stage-ports";

const skillSteps = `| スキルの箇所 | この会話での読み替え |
| --- | --- |
| モデル方針、Haiku への委譲 | 同じに行う |
| Step 0: 前提チェック | 指示の値を使う。\`gh\` は GitHub を使うプロジェクトだけで使う |
| Step 0: 前提チェック | 同じに確かめる。あれば \`report_needs_human\` で報告する |
| Step 0: 前提チェック | 行わない |
| Step 0: 前提チェック | 作業ディレクトリのブランチの元に \`docs/design/\` があるかを確かめる。無ければ \`report_needs_human\` で、設計書を既定ブランチへ入れるよう求める |
| Step 0: 作業ログのディレクトリ | 同じに作る。worktree の外に置く |
| Step 0 と 2.0 の前提 1・2 | 並列にできるかは決めない。セットアップの手順と、検証のサーバーのポートを外から指定するしかたが、設計書にあるかを確かめる。無ければ \`report_needs_human\` で報告する |
| Step 1: issue の収集と着手順 | 行わない。扱うのは指示の 1 件だけで、順と件数はアプリが決める |
| 2.1・2.5・2.6 の印 | 行わない |
| 前回の中断からの復帰 | 行わない。止まった作業は、この会話の続きとして同じ worktree で再開する |
| 2.0 並列実行の可否と枠組み | worktree の作成と複製は行わない。前提 1 の worktree のセットアップは行う。ポートは指示の値を使う |
| 2.1 着手 | 同じに確かめる。前回のコミットの上で再開するときは、未コミットの差分があれば続きとして扱う |
| 2.1 着手 | ブランチは切らない。\`BASE_SHA\` は、元にしたブランチ (\`origin/<既定ブランチ>\` か手元の既定ブランチ) と \`HEAD\` の merge-base とする |
| 2.1 着手 | ラベルは変えない。開始のコメントは \`issue_comment\` で書く |
| 2.2 実装 | \`issue_get\` で読んだ題名と本文を \`<SCRATCH>/issue-<番号>.md\` に書き、\`issue_file: <パス>\` の行を足して渡す。「issue の本文は gh issue view ではなく issue_file を読む」と添える |
| 2.3 レビュー | 2.2 と同じに \`issue_file\` を渡す。始める前に \`report_stage\` (\`review\`) を呼ぶ |
| 2.3 issue にする指摘 | 同じに行う。GitHub を使わないプロジェクトでは \`issue_comment\` で残す |
| 2.4 コミット・検証 | 同じに行う |
| 2.4 PR の push と \`--head\` | 指示のブランチ (\`sukuna/issue-<番号>\`、名前に \`-<k>\` が付けば同じものが付く) を使う |
| 2.4 PR | 書かない。\`Closes\` などのキーワードも書かない (GitHub の同じ番号の別の issue を閉じるため)。先頭行は \`sukuna: #<番号> <題名>\` とする |
| 2.4 PR | 同じに行う。始める前に \`report_stage\` (\`pr\`) を呼ぶ。\`PR_FAILED issue_link\` は起きない |
| 2.4 PR のあと | 使わない。\`report_ready_for_merge\` で報告し、返ってきた文に従う。CI の待ちと merge は「merge の手順」で行う |
| 2.5 完了処理 | 行わない。アプリが行う |
| 2.5 完了処理 | \`issue_create\` で作る。作った issue は確定済みで精査される。作成済みの印は \`issue_list\` の \`text\` で探す |
| 2.5 完了処理 | \`issue_comment\` で書き、そのあと \`report_implementation_done\` で報告する |
| 2.5 完了処理 | 写さない。\`CI:\` の行は「merge の手順」の 3 で見た結果で書く |
| 2.6 エスカレーション | WIP をコミットする。push はしない。\`report_needs_human\` で報告し、番を終える。worktree は消さない |
| Step 3: 終了処理 | 親の掃き掃除は行わない (アプリが行う)。この PR の指摘の issue は 2.5 で作り切る。最終報告は \`report_implementation_done\` の \`summary\` に書く |
| Step 3: 終了処理 | 行わない。worktree のブランチを切り替えない |
| エスカレーション回答後の再開 | 回答はこの会話に届く。仕様に関わる回答は \`issue_update\` で本文に反映し、\`<SCRATCH>/issue-<番号>.md\` を書き直してから続ける |
| 会話の入口 (\`CLAUDE_JOB_DIR\`) | 行わない |`;

const githubMerge = `merge の手順 (GitHub を使うプロジェクト)
1. PR の先頭のコミットが手元の HEAD と同じになるまで、10 秒おきに最大 12 回待つ。ならなければ report_needs_human で報告する。
2. リポジトリに .github/workflows があれば、PR の検査が登録されるまで 10 秒おきに最大 12 回待つ。0 件のままなら CI は無いものとして 4 へ進む。
3. gh pr checks <PR の URL> --json name,bucket,link を 30 秒おきに見る。全件が pass か skipping になったら 4 へ進む。fail か cancel が 1 件でもあれば、merge せずに report_ci_failed で報告し、番を終える。2 で待ち始めてから 60 分を過ぎても終わらなければ、時間切れとして report_ci_failed で報告する。
4. report_stage (merge) を呼び、gh pr merge <PR の URL> --repo <リポジトリ名> --squash --match-head-commit <HEAD> で merge する。
5. gh pr view <PR の URL> --json state,mergeCommit で state が MERGED であることを確かめる。
6. MERGED なら、指摘の issue と完了のコメントを書き、report_implementation_done で PR の URL と merge のコミットを報告する。
7. ぶつかって merge できない (mergeable が CONFLICTING、mergeStateStatus が DIRTY か BEHIND) ときは、1 回だけ origin/<既定ブランチ> へ rebase し、全体の検証をもう 1 巡して green を確かめ、git push --force-with-lease で押し直す。そのあと report_ready_for_merge を rebased: true で呼び直し、返ってきた文に従う。2 回目もぶつかったら report_needs_human で報告する。
8. ほかの理由で merge できないときは、gh pr view <PR の URL> --json state,mergeCommit を見る。state が MERGED なら 6 へ進む。そうでなければ、gh の出力を添えて report_needs_human で報告する。`;

const localMerge = `merge の手順 (GitHub を使わないプロジェクト)
1. report_stage (merge) を呼ぶ。
2. 手元の既定ブランチへ rebase する。rebase で差分が変わったら、全体の検証をもう 1 巡して green を確かめる。
3. 既定ブランチがどこかの worktree (ふつうはプロジェクトのディレクトリ) で開かれていれば、その worktree で git merge --ff-only <ブランチ> を実行する。開かれていなければ、git branch -f を使わずに git update-ref で既定ブランチの参照だけを進める。
4. 既定ブランチが先に進んでいて fast-forward できなければ、2 と 3 を 1 回だけやり直す。それでも入れられないか、開かれている worktree の未コミットの変更とぶつかったら、report_needs_human で報告する。
5. 入れたら、完了のコメントを書き、report_implementation_done で既定ブランチの新しい先頭のコミットを報告する。`;

export function implementationInstruction(
  issue: Pick<IssueRecord, "number" | "title">,
  project: Pick<StageProject, "name" | "path" | "defaultBranch" | "usesGithub">,
  tree: { path: string; branch: string; portSlot: number },
  repository: string | null,
) {
  const introduction = `#${issue.number}「${issue.title}」を実装してください。

- 手順は dev-impl のスキル (~/.claude/skills/dev-impl/SKILL.md) に従ってください。扱う issue はこの 1 件だけで、並列にはしません。
- この issue はアプリ sukuna が管理しています。GitHub の issue・ラベル・Project は使わず、issue の読み書きは mcp__sukuna__ のツールで行ってください。スキルの手順は、下の表のとおりに読み替えてください。
- 作業ディレクトリ ${tree.path} は、この issue のための worktree で、ブランチ ${tree.branch} を開いています。ブランチを切り替えず、ここで実装してください。worktree を消さないでください。
- 検証のサーバーのポートは、対象のリポジトリの基準のポートに ${tree.portSlot * 10} を足した値を使ってください。
- 段階が変わったら report_stage で知らせてください (review: レビューを始める、pr: PR を作る、merge: merge する)。
- PR を作り終えたら (GitHub を使わないプロジェクトでは検証を終えたら)、report_ready_for_merge で報告し、返ってきた文の指示に従ってください。
- 人の判断が要るときは、作業をコミットしてから report_needs_human で報告し、番を終えてください。選択式の質問のツール (AskUserQuestion) は使わないでください。
- プロジェクト: ${project.name} (${project.path})。既定ブランチ: ${project.defaultBranch}。GitHub を${project.usesGithub ? "使う" : "使わない"}プロジェクトです。${repository ? " " + repository : ""}`;
  const merge = project.usesGithub
    ? githubMerge.replaceAll("<リポジトリ名>", repository ?? "origin のリポジトリ")
    : localMerge;
  return [introduction, skillSteps, merge].join("\n\n");
}
