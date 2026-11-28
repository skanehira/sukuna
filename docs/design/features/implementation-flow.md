# issue の実装と merge

- 種別: 機能設計書
- 対象 UC: UC-010 (docs/design/USECASES.md)

## 何を作るか

実装待ちになった issue を、AI が issue ごとの worktree で実装し、PR と CI を通して merge し、完了にする機能である。

**使う人**: 開発者 (merge 前の確認を指定した issue を確かめ、止まった issue に答える)。実装と merge は AI が行う

**流れ**:

1. 実装待ちで依存先がすべて完了した issue を、優先度の高い順に、プロジェクトの同時実装の上限まで始める
2. アプリが issue 用の worktree を作り、実装の AI を始める
3. AI が実装し、テストとレビューを通してから PR を作る
4. AI が CI の結果を待ち、通ったら merge する。アプリが merge を確かめて issue を完了にし、worktree を片付ける
5. 子がすべて閉じた親の issue は、アプリが閉じる

**主な決まり**:

- 1 つのプロジェクトで同時に実装する issue は、既定で 5 件までとし、設定で変えられる (BR-042)
- 実装は issue ごとの worktree で行う。worktree を作るのも片付けるのもアプリである (BR-048、BR-050)
- 既定では CI が通ると AI が merge する。merge 前の確認を指定した issue は、PR ができると停止中になり、開発者の許可を待つ (BR-049)
- CI が失敗すると merge せず、失敗した検査を示して停止中になる
- GitHub を使わないプロジェクトでは、検証を通った変更を、PR を作らずに既定ブランチへ入れる
- 未コミットの変更か未 push のコミットがある worktree は消さずに残し、残したことをプロジェクトの画面の issue の行と issue の画面に出す (BR-051)
- 親の issue は実装せず、子がすべて閉じたら閉じる (BR-036)

## 入出力と振る舞い

### この機能の前提

- issue の状態の値、停止中の理由、移り変わりの表は `features/issue-flow.md` が正本である。本書は、実装待ちから完了までの進め方を書く
- 状態を移すのはランナーの自動フロー (`flow`) だけとする。実装の AI は `features/issue.md`「AI に渡すツール」で結果を報告する
- PR・CI・merge は、GitHub を使うプロジェクトでは AI が `gh` で行う (BR-052、DESIGN.md「横断規約 > 自動フローと既存のスキル」)
- merge 前の確認の許可、merge 前の確認で止まった issue への指示、完了した issue を直させることは `features/pr-review.md` が正本である
- 段階の AI を始める評価、一時停止、報告の催促、AI が止まったときの扱いは `features/issue-flow.md` に従う
- worktree の置き場所は `features/worktree-terminal.md`「作る場所と名前」に従う

### 始める順と件数

`features/issue-flow.md`「段階の AI を始める」の評価で、プロジェクトごとに実装を始める issue を選ぶ。始める条件は次のすべてである。

1. issue が実装待ちである
2. 子が無い (親は実装しない。BR-036)
3. 依存先がすべて完了している (BR-037)。取り下げの依存先があれば、停止中 (`dependency_withdrawn`) に移して始めない
4. 親があれば、親が設計待ち・設計レビュー・停止中 (停止前の状態が設計待ちか設計レビュー) のどれでもない。設計で分けた子が、親の設計の承認より先に実装されないようにするためである
5. プロジェクトが解除されておらず、全体とプロジェクトの自動フローが一時停止しておらず、「自動で処理する段階」に実装が入っている
6. その issue の精査・設計・実装の会話のどれも、`working` / `waiting_answer` / `waiting_permission` ではない (BR-041)
7. そのプロジェクトで実装中の issue の数が、`projects.impl_concurrency` (既定 5) より少ない

条件を満たす issue が空きより多いときは、次の順に並べて、上から空きの数だけ始める。残りは実装待ちのまま、空いたときの評価で始まる (UC-010 の 1)。

1. 実効の優先度が高い順。実効の優先度は、その issue と、その issue に直接か間接に依存する閉じていない issue のうち、いちばん高い優先度とする。優先度の無い issue は中とする
2. 同じなら、番号の小さい順

- 実効の優先度を使うのは、優先度の低い依存先が後回しになり、優先度の高い issue が塞がれるのを防ぐためである (`dev-triage` の `references/priority.md`「判定の流れ」の 3)
- 件数に数えるのは実装中の issue だけである。停止中の issue は数えない
- 停止中から実装中へ戻るのは、開発者の操作か AI の再開による。上限を超えていても戻す。上限は新しく始める issue にだけ効く
- プロジェクトをまたぐ数と、開発者が始める会話には上限を設けない (BR-042)
- 並列に実装する前提 (worktree のセットアップの手順と、検証のサーバーのポートの指定のしかたが、対象のリポジトリの設計書にあること) は、実装の AI が Step 0 で確かめる。無ければ `report_needs_human` で報告する (下の読み替えの表)

### 始めるときの手順

1. issue を実装中に移し、`stage_changed` (`implement`) を足す
2. 実装の会話 (`conversations.kind` が `impl` で、`issue_id` が同じもの) があれば使う。無ければ、題名を `#<番号> の実装`、作業ディレクトリをプロジェクトのディレクトリにして、指示を送らずに作る
3. worktree を用意する (下の「worktree を作る」)
4. 実装の会話の作業ディレクトリと `worktree_id` を、その worktree にする
5. 最初の指示 (下の「実装の AI の最初の指示」) を、`origin` を `flow` として送り、`ai_started` を足す

- 3 で失敗したら、停止中 (`failed`) に移す。`cause` は `worktree_failed`、`detail` は「worktree を作れませんでした: <git の出力の 1 行目>」とする
- 停止中へ移したあとに、実装の会話に止まった記録 (`error`) を書く。会話の末尾に「再開する」が出る
- 開発者が再開を選ぶか指示を送ると、`flow` が worktree を作り直す。最初の指示と開発者の指示を 1 通で届ける (`features/issue-flow.md`「停止中から戻る」の `retryStageWorktree`)
- 完了した issue を直させるときは、`features/pr-review.md`「merge の後に直させる」の手順で始める。worktree は本書「worktree を作る」で新しく作り、`stage_changed` (`implement`) を足す

### worktree を作る

実装の worktree は、`features/worktree-terminal.md`「作る場所と名前」の規則で作る。自動フローに固有の決まりは次のとおりである。

| 項目 | 決まり |
| --- | --- |
| 名前 | `issue-<番号>`。同じ名前の worktree かブランチがすでにあれば、`issue-<番号>-<k>` (k は 2 から、空いている最小の数) |
| ブランチ | `sukuna/issue-<番号>`。名前に `-<k>` を付けたときは、ブランチにも同じものを付ける。既存のブランチは使わず、新しく作る |
| 元にするもの | GitHub を使うプロジェクトは `git fetch origin <既定ブランチ>` のあと `origin/<既定ブランチ>`、使わないプロジェクトは手元の既定ブランチ。取得に失敗したら手元の既定ブランチから作る |
| 置き場所 | `features/worktree-terminal.md`「作る場所と名前」 |
| 記録 | `worktrees` に `origin = flow`、`issue_id`、`port_slot` を入れ、`branch_created` を真にする |
| 使い直し | その issue の実装の worktree (`origin = flow`、名前が `issue-` で始まる) で片付けていないもののうち、最後の `implementation_done` と `reopened_for_fix` より後に作ったものがあれば、新しく作らずに使う。作った時刻は `worktrees.id` (ULID) の時刻で比べる。作成時の Git 登録とフォルダを照合する |

- 取得に失敗して手元から作っても、お知らせは出さない。merge の前の rebase (「merge の手順」の 7) で既定ブランチの最新を取り込むためである
- 作った直後に、リポジトリの直下の `.worktreeinclude` に当たるファイルのうち、git が無視するものだけを複製する。手順は `dev-impl` の SKILL.md「2.0 並列実行の可否と枠組み」と同じにする
- 依存の導入などのセットアップは、アプリは行わない。対象のリポジトリの `docs/design/DESIGN.md` の手順に沿って、実装の AI が行う
- `port_slot` は、そのプロジェクトの片付けていない実装の worktree が使っていない最小の数 (0 から) とする。AI は、対象のリポジトリの基準のポートに `port_slot` × 10 を足したポートで、検証のサーバーを起動する
- 完了した issue を直させるとき (`features/pr-review.md`「merge の後に直させる」) は、上の名前の規則で新しい worktree を作る。前の worktree が残っていて名前が重なるときだけ `-<k>` が付く。merge 済みのブランチの上では直さない

### 実装の AI の最初の指示

実装の AI は、既存のスキル `dev-impl` の手順で、この issue 1 件だけを、用意した worktree で実装する。最初の指示は次の文とする。`<...>` は送るときに埋める。

```text
#<番号>「<題名>」を実装してください。

- 手順は dev-impl のスキル (~/.claude/skills/dev-impl/SKILL.md) に従ってください。扱う issue はこの 1 件だけで、並列にはしません。
- この issue はアプリ sukuna が管理しています。GitHub の issue・ラベル・Project は使わず、issue の読み書きは mcp__sukuna__ のツールで行ってください。スキルの手順は、下の表のとおりに読み替えてください。
- 作業ディレクトリ <worktree のパス> は、この issue のための worktree で、ブランチ <ブランチ> を開いています。ブランチを切り替えず、ここで実装してください。worktree を消さないでください。
- 検証のサーバーのポートは、対象のリポジトリの基準のポートに <port_slot × 10> を足した値を使ってください。
- 段階が変わったら report_stage で知らせてください (review: レビューを始める、pr: PR を作る、merge: merge する)。
- PR を作り終えたら (GitHub を使わないプロジェクトでは検証を終えたら)、report_ready_for_merge で報告し、返ってきた文の指示に従ってください。
- 人の判断が要るときは、作業をコミットしてから report_needs_human で報告し、番を終えてください。選択式の質問のツール (AskUserQuestion) は使わないでください。
- プロジェクト: <プロジェクト名> (<プロジェクトのパス>)。既定ブランチ: <ブランチ>。GitHub を<使う / 使わない>プロジェクトです。<GitHub のリポジトリ名>

<読み替えの表 (下の表の「スキルの箇所」と「この会話での読み替え」の 2 列)>

<merge の手順 (下の「merge の手順」の、GitHub を使うかどうかに合う方)>
```

`dev-impl` の読み替え:

| スキルの箇所 | スキルの動き | この会話での読み替え |
| --- | --- | --- |
| モデル方針、Haiku への委譲 | implementer と review-impl を opus で、コミットと巨大な出力の検証を haiku で起動する | 同じに行う |
| Step 0: 前提チェック | `gh repo view` で既定ブランチとリポジトリ名を取る | 指示の値を使う。`gh` は GitHub を使うプロジェクトだけで使う |
| Step 0: 前提チェック | 必須の技術検証のマーカーが設計書に残っていれば止まる | 同じに確かめる。あれば `report_needs_human` で報告する |
| Step 0: 前提チェック | ラベル 4 種を用意する | 行わない |
| Step 0: 前提チェック | 設計書が push 済みかを確かめる | 作業ディレクトリのブランチの元に `docs/design/` があるかを確かめる。無ければ `report_needs_human` で、設計書を既定ブランチへ入れるよう求める |
| Step 0: 作業ログのディレクトリ | `SCRATCH` を作る | 同じに作る。worktree の外に置く |
| Step 0 と 2.0 の前提 1・2 | 並列にできるかを、設計書の worktree のセットアップの手順とポートの契約で決める | 並列にできるかは決めない。セットアップの手順と、検証のサーバーのポートを外から指定するしかたが、設計書にあるかを確かめる。無ければ `report_needs_human` で報告する |
| Step 1: issue の収集と着手順 | `next-issues.sh` で集め、担当の印を取り、着手順を出す | 行わない。扱うのは指示の 1 件だけで、順と件数はアプリが決める |
| 2.1・2.5・2.6 の印 | `next-issues.sh mark` で `started` / `closed` / `parked` を書く | 行わない |
| 前回の中断からの復帰 | 残ったブランチ・worktree・PR から再開の位置を決める | 行わない。止まった作業は、この会話の続きとして同じ worktree で再開する |
| 2.0 並列実行の可否と枠組み | worktree を作り、`.worktreeinclude` を複製し、スロットのポートを決める | worktree の作成と複製は行わない。前提 1 の worktree のセットアップは行う。ポートは指示の値を使う |
| 2.1 着手 | 作業ツリーが clean かを確かめる | 同じに確かめる。前回のコミットの上で再開するときは、未コミットの差分があれば続きとして扱う |
| 2.1 着手 | ブランチを切り、`BASE_SHA` を控える | ブランチは切らない。`BASE_SHA` は、元にしたブランチ (`origin/<既定ブランチ>` か手元の既定ブランチ) と `HEAD` の merge-base とする |
| 2.1 着手 | ラベルを `in-progress` にし、開始のコメントを書く | ラベルは変えない。開始のコメントは `issue_comment` で書く |
| 2.2 実装 | implementer に `issue_number` を渡し、implementer が `gh issue view` で本文を読む | `issue_get` で読んだ題名と本文を `<SCRATCH>/issue-<番号>.md` に書き、`issue_file: <パス>` の行を足して渡す。「issue の本文は gh issue view ではなく issue_file を読む」と添える |
| 2.3 レビュー | review-impl に `issue_number` を渡す | 2.2 と同じに `issue_file` を渡す。始める前に `report_stage` (`review`) を呼ぶ |
| 2.3 issue にする指摘 | PR のコメントに残す | 同じに行う。GitHub を使わないプロジェクトでは `issue_comment` で残す |
| 2.4 コミット・検証 | 論理単位でコミットし、全体の検証を 1 巡する | 同じに行う |
| 2.4 PR の push と `--head` | ブランチ `issue-<N>` を push し、`workflow-create-pr` の `--head` に渡す | 指示のブランチ (`sukuna/issue-<番号>`、名前に `-<k>` が付けば同じものが付く) を使う |
| 2.4 PR | 本文の先頭行に `Closes #<N>` を書く | 書かない。`Closes` などのキーワードも書かない (GitHub の同じ番号の別の issue を閉じるため)。先頭行は `sukuna: #<番号> <題名>` とする |
| 2.4 PR | `workflow-create-pr` を非対話で起動する | 同じに行う。始める前に `report_stage` (`pr`) を呼ぶ。`PR_FAILED issue_link` は起きない |
| 2.4 PR のあと | `merge-pr.sh` で CI を待ち、merge し、後片付けをする | 使わない。`report_ready_for_merge` で報告し、返ってきた文に従う。CI の待ちと merge は「merge の手順」で行う |
| 2.5 完了処理 | issue と親を close し、ラベルを外す | 行わない。アプリが行う |
| 2.5 完了処理 | 指摘から `gh issue create` で issue を作る | `issue_create` で作る。作った issue は確定済みで精査される。作成済みの印は `issue_list` の `text` で探す |
| 2.5 完了処理 | 完了のコメントを書く | `issue_comment` で書き、そのあと `report_implementation_done` で報告する |
| 2.5 完了処理 | 完了のコメントの `CI:` の行を `merge-pr.sh` の出力から写す | 写さない。`CI:` の行は「merge の手順」の 3 で見た結果で書く |
| 2.6 エスカレーション | WIP をコミットして push し、`needs-human` を付けて駐車し、worktree を消す | WIP をコミットする。push はしない。`report_needs_human` で報告し、番を終える。worktree は消さない |
| Step 3: 終了処理 | 親の掃き掃除、指摘の作り残しの回収、最終報告 | 親の掃き掃除は行わない (アプリが行う)。この PR の指摘の issue は 2.5 で作り切る。最終報告は `report_implementation_done` の `summary` に書く |
| Step 3: 終了処理 | 既定ブランチへ戻って `git pull` する | 行わない。worktree のブランチを切り替えない |
| エスカレーション回答後の再開 | 回答を本文に反映し、`ready` を付けて再実行する | 回答はこの会話に届く。仕様に関わる回答は `issue_update` で本文に反映し、`<SCRATCH>/issue-<番号>.md` を書き直してから続ける |
| 会話の入口 (`CLAUDE_JOB_DIR`) | 駐車のコメントに `claude attach` の行を足す | 行わない |

### merge の手順

`report_ready_for_merge` が「CI を待って merge してください」か「merge してください」を返したら、AI は次の手順で進める。指示の文には、プロジェクトに合う方だけを入れる。

```text
merge の手順 (GitHub を使うプロジェクト)
1. PR の先頭のコミットが手元の HEAD と同じになるまで、10 秒おきに最大 12 回待つ。ならなければ report_needs_human で報告する。
2. リポジトリに .github/workflows があれば、PR の検査が登録されるまで 10 秒おきに最大 12 回待つ。0 件のままなら CI は無いものとして 4 へ進む。
3. gh pr checks <PR の URL> --json name,bucket,link を 30 秒おきに見る。全件が pass か skipping になったら 4 へ進む。fail か cancel が 1 件でもあれば、merge せずに report_ci_failed で報告し、番を終える。2 で待ち始めてから 60 分を過ぎても終わらなければ、時間切れとして report_ci_failed で報告する。
4. report_stage (merge) を呼び、gh pr merge <PR の URL> --repo <リポジトリ名> --squash --match-head-commit <HEAD> で merge する。
5. gh pr view <PR の URL> --json state,mergeCommit で state が MERGED であることを確かめる。
6. MERGED なら、指摘の issue と完了のコメントを書き、report_implementation_done で PR の URL と merge のコミットを報告する。
7. ぶつかって merge できない (mergeable が CONFLICTING、mergeStateStatus が DIRTY か BEHIND) ときは、1 回だけ origin/<既定ブランチ> へ rebase し、全体の検証をもう 1 巡して green を確かめ、git push --force-with-lease で押し直す。そのあと report_ready_for_merge を rebased: true で呼び直し、返ってきた文に従う。2 回目もぶつかったら report_needs_human で報告する。
8. ほかの理由で merge できないときは、gh pr view <PR の URL> --json state,mergeCommit を見る。state が MERGED なら 6 へ進む。そうでなければ、gh の出力を添えて report_needs_human で報告する。
```

```text
merge の手順 (GitHub を使わないプロジェクト)
1. report_stage (merge) を呼ぶ。
2. 手元の既定ブランチへ rebase する。rebase で差分が変わったら、全体の検証をもう 1 巡して green を確かめる。
3. 既定ブランチがどこかの worktree (ふつうはプロジェクトのディレクトリ) で開かれていれば、その worktree で git merge --ff-only <ブランチ> を実行する。開かれていなければ、git branch -f を使わずに git update-ref で既定ブランチの参照だけを進める。
4. 既定ブランチが先に進んでいて fast-forward できなければ、2 と 3 を 1 回だけやり直す。それでも入れられないか、開かれている worktree の未コミットの変更とぶつかったら、report_needs_human で報告する。
5. 入れたら、完了のコメントを書き、report_implementation_done で既定ブランチの新しい先頭のコミットを報告する。
```

### 実装の段階の記録

実装中の段階は、`issue_events` の種類 `stage_changed` (`{ "stage": "<段階>" }`) で記録する。`features/work-monitor.md` が工程の表示に使う。

| 段階 | 記録するとき |
| --- | --- |
| `implement` | 実装を始めたとき。完了した issue を直させるときと、停止中から実装中に戻ったときも記録する |
| `review` | AI が `report_stage` で `review` を知らせたとき |
| `pr` | AI が `report_stage` で `pr` を知らせたとき |
| `ci` | `report_ready_for_merge` を受けて、CI を待って merge する指示を返したとき。merge の許可を受けたとき |
| `merge` | AI が `report_stage` で `merge` を知らせたとき |

- 同じ段階が続けて来たときは、2 件目を記録しない
- 段階は表示のためだけに使い、状態の移り変わりには使わない

### PR の用意ができたとき

AI が `report_ready_for_merge` を呼ぶと、`flow` は次を行う。

1. 状態が実装中であることを確かめる。違えばツールは失敗を返す
2. GitHub を使うプロジェクトでは、`pr_url` が要る。`gh pr view` で、PR が開いていて、先頭のコミットが報告の `head_sha` と同じことを確かめる。違えばツールは失敗を返し、違いを文で伝える
3. `ready_for_merge` (`{ "prUrl": "..." \| null, "headSha": "...", "rebased": <真偽>, "summary": "..." }`) を足し、`issues.pr_url` を報告の URL にする
4. 次の表で決め、ツールの戻りの文で AI に伝える

| 条件 | issue | ツールが返す文 |
| --- | --- | --- |
| `issues.confirm_before_merge` が真で、許可済みの rebase ではない | 停止中 (`merge_confirm`)。`detail` は「merge 前の確認」 | 「merge 前の確認で止めました。番を終えてください。開発者が許可すると、この会話に merge の指示が届きます」 |
| 上に当たらず、GitHub を使う | 実装中のまま。`stage_changed` (`ci`) | 「CI を待って merge してください」 |
| 上に当たらず、GitHub を使わない | 実装中のまま | 「merge してください」 |

- 許可済みの rebase は、同じ PR と作業場所に限る。ランナーは GitHub が返す base のコミットを比較に使う。許可した版の変更を今回の比較元に適用した結果が、報告版と一致するときに許可を引き継ぐ
- 許可済みの rebase で確認で止めないのは、merge のための rebase は issue の差分を変えず、開発者の許可がすでにあるためである。許可の前の rebase と、許可の後に直した報告は、ふつうの報告と同じに確認で止める
- 一時停止のあいだも、この戻りの文は返す。AI は番の途中で動いているからである (`features/issue-flow.md`「一時停止と自動で処理する段階」)

### merge の前に自分が確認する issue

merge 前の確認を指定した issue (`issues.confirm_before_merge` が真) は、PR ができると停止中 (`merge_confirm`) になる (UC-010 A、BR-049)。

- 開発者は PR の画面で確かめ、merge を許可する。許可を受けると、`flow` が issue を実装中に戻し、実装の会話に merge の指示を届ける。届けた後の AI は「merge の手順」で進める。許可の受け方と指示の文は `features/pr-review.md`「merge の許可」に従う
- 開発者が指示を送ると、issue は実装中に戻る。AI が直して `report_ready_for_merge` を呼ぶと、もう一度停止中 (`merge_confirm`) になる (BR-099。`features/pr-review.md`)
- GitHub を使わないプロジェクトでも同じに止まる。開発者は実装のブランチの差分を読んで許可する (`features/pr-review.md`)
- 確認の指定を実装の途中で変えたときは、`report_ready_for_merge` を受けた時点の値で決める

### GitHub を使わないプロジェクト

`projects.uses_github` が偽のプロジェクトでは、PR と CI を使わない (UC-010 B)。

- AI は、テスト・lint・DoD の検証を通した後に、`pr_url` を付けずに `report_ready_for_merge` を呼ぶ
- merge 前の確認で許可を得た場合は、そのときの作業ブランチの先頭を既定ブランチに入れる。rebase で別の先頭になったときは、その版で許可を得る
- 確認の指定が無ければ「merge してください」が返り、AI は「merge の手順 (GitHub を使わないプロジェクト)」で既定ブランチへ入れる
- `flow` は、`report_implementation_done` の `merge_commit` と worktree の `HEAD` が既定ブランチに含まれることを確かめてから完了にする (「完了」の 2)

### 実装の途中で人の判断が要るとき

AI は、作業をコミットしてから `report_needs_human` で報告する (UC-010 C)。

- `flow` は issue を停止中 (`question`) にする。worktree と実装の会話はそのまま残す
- 開発者が実装の会話で答えると、AI が同じ worktree で、保存した作業の続きから再開する。答えが会話に記録されると、issue は実装中に戻る (`features/issue-flow.md`「停止中から戻る」)
- AI は、仕様に関わる回答を `issue_update` で本文に反映してから続ける。implementer は本文しか読まないためである

### CI の失敗

AI は CI の失敗を見つけたら merge せずに `report_ci_failed` で報告する (UC-010 E1)。

1. `flow` は `ci_failed` (`{ "checks": [ { "name": "...", "bucket": "fail" \| "cancel" \| "pending", "link": "..." } ], "timedOut": <真偽>, "summary": "..." }`) を足す
2. issue を停止中 (`ci_failed`) にする。`detail` は失敗した検査の名前を「、」でつないだ文とする。時間切れなら「CI が 60 分で終わりませんでした」とする
3. ツールは「停止中にしました。番を終えてください」を返す

- 失敗した検査は、一覧の状況の文 (`features/inbox.md`)、会話の末尾 (`features/issue.md`)、PR の画面 (`features/pr-review.md`) に出る
- CI の失敗では、AI に直させる周回を自動で回さない。ローカルの検証が通って CI だけが失敗するのは環境の差が疑われ、どちらを正とするかを開発者が決めるためである (`dev-impl` の SKILL.md「2.4」の終了コード 11 と同じ扱い)
- 開発者が実装の会話に指示を送ると、届ける前に issue は実装中に戻る (`features/pr-review.md` の `deliverImplInstruction`)。AI は直して push し、`report_ready_for_merge` を呼び直す

### 完了

AI が `report_implementation_done` を呼ぶと、`flow` は merge を確かめてから完了にする。

1. 状態が実装中であることを確かめる。違えばツールは失敗を返す
2. GitHub を使うプロジェクトでは、`gh pr view <pr_url> --json state,mergeCommit,headRefOid` で、状態が `MERGED` であることを確かめる。使わないプロジェクトでは、`merge_commit` と worktree の `HEAD` が既定ブランチに含まれることを確かめる
3. 確かめられなければ、ツールは「merge を確かめられませんでした: <理由>。merge の手順を見直してから、もう一度報告してください」を返し、状態を変えない
4. 確かめたら、`implementation_done` (`{ "prUrl": "..." \| null, "mergeCommit": "...", "summary": "..." }`) を足し、issue を完了に移す
5. worktree を片付ける (下の「worktree の片付け」)。実装の会話の作業ディレクトリは、片付けたらプロジェクトのディレクトリにする。会話は残し、あとで再開できる (BR-058)
6. 親の issue を確かめる (下の「親の issue を閉じる」)
7. 評価を行う。この issue を待っていた issue の実装がここで始まる
8. ツールは「完了にしました。番を終えてください」を返す

### GitHub で merge されたとき

開発者が GitHub で PR を直接 merge したときも、`flow` が merge を確かめて完了にする。画面のサーバーは、PR の取得で状態が `MERGED` なら、`/flow/notify` を `issue_id` 付きで送る (`features/pr-review.md`「取得と最後に取得した内容」)。

1. `flow` は、その issue が実装中か、停止前の状態が実装中の停止中で、`issues.pr_url` があるときだけ確かめる
2. 実装の会話が `working` / `waiting_answer` / `waiting_permission` なら、まだ確かめない。`flow` はその issue をメモリに覚えておき、その会話の番が終わるか止まったときに 1 から確かめる。覚えた issue はランナーの再起動で消えるが、次に PR を取得したときの知らせで確かめ直す
3. `gh pr view <pr_url> --json state,mergeCommit` で、状態が `MERGED` であることを確かめる。違えば何もしない
4. 「完了」の 4〜7 を行う。`implementation_done` の `mergeCommit` は取得した値、`summary` は「GitHub で merge されました」とする

### 報告の催促

`features/issue-flow.md`「番の終わりで報告が無いとき」で数える実装の報告は、`report_ready_for_merge`・`report_ci_failed`・`report_implementation_done`・`report_needs_human` の 4 つである。`report_stage` は数えない。催促の文の報告のツール名は `report_ready_for_merge` とする。

### worktree の片付け

完了した issue と、取り下げの issue の worktree (`origin = flow`) を片付ける。設計の worktree とブランチの扱いは `features/design-review.md`「設計の作業場所」に従う。開発者が作った worktree (`origin = user`) は片付けない (BR-050)。

消してよいかは、`features/worktree-terminal.md`「消す」の表の 3〜6 で決める。どれかに当てはまれば消さない (BR-051)。表の 1 と 2 は、自動フローの片付けでは当てはまらない。判定は、同書の `src/shared` の関数を画面のサーバーと同じに使う。未 push のコミットの数え方と、`HEAD` が merge を確かめた PR の先頭と同じときの例外も、同書に従う。

- 表の 3 (会話の AI が動いている) は、その issue の段階の会話 (精査・設計・実装の会話) を数えない。片付けは報告のツールの処理の中で行い、そのとき段階の会話は作業中だからである。スレッドなど、ほかの会話は数える。数える会話は、判定の関数に渡す前に `flow` が選ぶ
- 消せる worktree は、同書「消す」の確認を行う。ランナーは画面のサーバーから、同じ worktree の管理ターミナルが終了したと確認してから、フォルダと Git の worktree 登録を消す。確認を得られないときは片付けを保留し、接続が戻ったときに改めて確認する
- 初期化済みのサブモジュールや状態を確かめられないサブモジュールがあれば、worktree を保持する。
- Git の登録を指す名前を変えずに、作業ディレクトリの実物を非公開の一時パスへ移す。Git 登録と実物の双方を、作成時の記録に照合してから削除する。確認できなければ残す
- ブランチは、別の Git 操作がそのブランチを開く場合に備えて保持する。worktree を消したあとに `worktree_removed` (`{ "worktreeId": "...", "path": "..." }`) を足す
- 消さないときは、`worktree_kept` (`{ "worktreeId": "...", "path": "...", "uncommittedFiles": <数>, "unpushedCommits": <数> }`) を足し、ランナーの `issue` の知らせを出す (UC-010 E2)。画面のサーバーはそれを受けて `inbox` に `changed` を出す (`features/runtime.md`「配信」)
- 残したことは、プロジェクトの画面の完了か取り下げの issue の行 (`features/inbox.md`) と、issue の画面の末尾 (`features/issue.md`) に「worktree を残しました: <パス>」と出す
- 残したことは通知にしない。開発者の対応が要る変化ではなく、issue の画面とプロジェクトの画面で分かるためである
- 残した worktree は、開発者が worktree の一覧から消す (`features/worktree-terminal.md`)。設計の worktree の端末確認を保留した記録 (`awaitingTerminal: true`) は、接続が戻ったときに再評価する
- 片付けに失敗したとき (git の失敗) も、残したときと同じに記録する。issue の完了は取り消さない

### 親の issue を閉じる

子が完了か取り下げになったとき、子の親が変わったとき、子が再開したとき、完了した子を直させるとき、親が実装待ち (親) になったときに、その親を確かめる。

| 親の状態 | 子の様子 | 起きること |
| --- | --- | --- |
| 実装待ち | 子がすべて閉じていて (完了か取り下げ)、1 件以上が完了 | 親を完了にする (BR-036)。`cause` は `children_closed` |
| 実装待ち | 子がすべて取り下げ | 何もしない。親は実装待ちのまま残り、開発者が取り下げるか子を足す |
| 完了 | 閉じていない子がある | 親を実装待ち (親) に戻す。`cause` は `child_reopened` |
| そのほか | 問わない | 何もしない。親が実装待ちになったときに確かめ直す |

- 親を完了にしたら、その親の親も同じに確かめる
- 子の再開を保存できない間は、祖先に依存する実装も始めない。処理を保留した親は排他の解除後に確かめ直す
- 親を閉じたことで、その親に依存していた issue の実装が始まることがある。閉じた後に評価を行う

### ランナーの再起動のあと

段階の会話の続きと評価は `features/issue-flow.md`「ランナーの再起動のあと」に従う。実装に固有のことは次のとおりである。

- CI の待ちは AI の会話の中のコマンドで行っているので、再起動で止まる。続きの指示を受けた AI が、「merge の手順」の 1 からやり直す
- 実装中で、実装の会話に指示がまだ届いていない issue (始めるときの手順の途中で止まった) は、手順の 3 からやり直す。worktree があれば使い直す
- 片付け途中で止まった処理は、会話の作業場所を読む前に復旧する。保存した同一性と削除の記録を使い、確かめられる worktree だけを戻すか片付ける。完了・取り下げの issue に未片付けの worktree があれば、保持が確定したものを除いて改めて片付ける

## API

画面向けの API は持たない。

- merge の許可は、`features/pr-review.md` の `POST /api/issues/:id/pr/allow-merge` から、ランナーの `flow` に渡る
- 同時に実装する件数の設定と一時停止は、`features/project-settings.md` の `PATCH /api/projects/:id` で変わり、`/flow/notify` で評価が行われる
- 実装の AI が使うツール (`report_stage`、`report_ready_for_merge`、`report_ci_failed`、`report_implementation_done`、`report_needs_human`) の引数と戻りは、`features/issue.md`「AI に渡すツール」にある

## 実装の配置

| 処理 | 層 | 実装先ファイル |
| --- | --- | --- |
| 始める条件、実効の優先度、始める順 | ドメイン | `src/runner/modules/flow/domain/impl-queue.ts` |
| worktree の名前・ブランチ・`port_slot` の決め方 | ドメイン | `src/runner/modules/flow/domain/impl-worktree.ts` |
| 親を閉じるか戻すかの判定 | ドメイン | `src/runner/modules/flow/domain/parent-closing.ts` |
| 最初の指示の文、読み替えの表、merge の手順の文 | ドメイン | `src/runner/modules/flow/domain/impl-instructions.ts` |
| 実装を始める → issues, issue_events, conversations, worktrees | ユースケース | `src/runner/modules/flow/usecase/start-implementation.ts` |
| PR の用意・CI の失敗・段階の報告を受ける → issues, issue_events | ユースケース | `src/runner/modules/flow/usecase/on-impl-report.ts` |
| 完了と片付けと親の確かめ → issues, issue_events, worktrees, conversations | ユースケース | `src/runner/modules/flow/usecase/complete-implementation.ts` |
| worktree の作成と削除 (git の実行) | インフラ (git の Port) | `src/runner/modules/workspace/adapter/git-cli.ts` |
| PR の状態の確認 (`gh pr view`) | インフラ (GitHub の Port) | `src/runner/modules/flow/adapter/gh-cli.ts` |

- 評価の本体は `features/issue-flow.md` の `evaluate-project.ts` で、実装を始める判断だけを `impl-queue.ts` に置く
- 消してよいかの判定は `features/worktree-terminal.md` が `src/shared` に置く関数を使う。git と `gh` で判定の材料を集めるのは、ランナーの git と GitHub の Port である
- テーブルの定義は DESIGN.md「データスキーマ」参照

## エッジケースの決定

1. **空・最小データ**: 実装待ちの issue が 0 件なら何もしない。依存先が 0 件の issue は、依存の条件を満たしたものとして扱う。変更が 0 件のまま `report_ready_for_merge` が来ても、そのまま受ける (PR の画面が「変更はありません」を出す)
2. **上限・境界値**: 同時実装の件数の範囲は `features/project-settings.md` が決める。上限ちょうどの件数が実装中なら、新しく始めない。CI の待ちは、検査の登録を待ち始めてから 60 分までとする。rebase による復旧は 1 回までとする
3. **エラー時に利用者へ見えるもの**: worktree を作れない、CI の失敗、merge できない、のどれも停止中にして、理由を `detail` に入れる。一覧の状況の文と会話の末尾に出る。worktree を残したときは `worktree_kept` を記録し、プロジェクトの画面の issue の行と issue の画面に出す
4. **並行操作・二重実行**: 評価は何度呼んでも同じ結果になり、実装中の件数の数えと移り変わりを 1 つのトランザクションで行う。`report_implementation_done` が 2 回来たら、2 回目は状態が完了なのでツールが失敗を返す。同じプロジェクトの複数の issue が同時に merge して既定ブランチが進んだら、後の issue は「merge の手順」の 7 の rebase で取り込む
5. **再表示時の整合**: 状態と段階は `issue_events` に残し、画面は配信を受けて API で読み直す。PR の状況は PR の画面が GitHub から読み直す (`features/pr-review.md`)
6. **表示の寿命**: 「worktree を残しました」は、issue が閉じていて、残した worktree を開発者が消すまで、issue の画面の末尾に出す。プロジェクトの画面の行での出し方は `features/inbox.md` に従う。停止中の `detail` は、実装中に戻ると消える。段階 (`stage_changed`) は完了の後も記録として残す
7. **送る前のデータ**: 該当なし (この機能は開発者の入力を受けない。merge 前の確認への指示は会話とストックが持つ)
8. **状態の移り変わり**: 実装待ち → 実装中 → (停止中 → 実装中)* → 完了。停止中になるのは、質問・失敗・利用枠切れ・CI の失敗・merge 前の確認・依存先の取り下げのときである。表は `features/issue-flow.md` にある。親は実装待ちから、子がすべて閉じると完了に移る
9. **自動で進むこと**: 実装の開始、CI の待ち、merge、完了、worktree の片付け、親を閉じることは、開発者の操作なしに進める (P2)。CI の失敗と merge できないときは自動でやり直さない。保持が確定した worktree の片付けは自動でやり直さない
10. **端末と画面をまたぐこと**: issue の状態・段階・worktree の記録はサーバーに置き、どの端末でも同じにする (P3)。merge の許可はどの端末からでもよく、先に届いた 1 回だけが効く (`features/pr-review.md`)
11. **並びと数え方**: 始める順は実効の優先度の高い順、同じなら番号の小さい順とする。件数は、そのプロジェクトの実装中の issue を数える。CI の 60 分は、検査の登録を待ち始めた時刻から数える。`port_slot` は 0 から数える

## テスト方針

| 受け入れ基準 (docs/design/USECASES.md) | レベル |
| --- | --- |
| （US-010）issue が実装待ちになり、依存先がすべて閉じていると、issue 用の worktree で実装の AI が始まる | 結合 |
| （US-010）実装の AI が始まると、AI は実装し、テストを通し、レビューの指摘を直してから PR を作る | 単体 |
| （US-038）merge の前の確認を指定していない issue で CI が通ると、AI が PR を merge し、issue が完了になる | 結合 |
| （US-010）実装待ちの issue がプロジェクトの上限より多いとき、優先度の高い順に上限の件数だけ実装が始まり、残りは空くまで待つ | 結合 |
| （US-038）CI が失敗すると、merge されずに issue が停止中になり、失敗した検査が表示される | 結合 |
| （US-054）merge の前に自分が確認すると指定した issue は、PR ができると停止中になり、許可すると merge される | 結合 |
| （US-011）実装の途中で AI が質問を書くと、issue が停止中になり、答えると保存した作業の続きから再開する | 結合 |
| （US-013）issue が完了になると、自動フローが作った worktree が片付けられる | 結合 |
| （US-013）未コミットの変更か未 push のコミットがある worktree は消されずに残り、残したことが知らされる | 結合 |
| （US-060）GitHub を使わないプロジェクトでは、検証を通った変更が、PR を作らずに既定ブランチへ merge される | 結合 |

- 結合: ランナーの `flow` を、本物の SQLite と、一時ディレクトリに作った本物の git のリポジトリ (既定ブランチと、リモートの代わりの bare のリポジトリ) で動かす。Agent SDK は台本どおりに動く偽物、`gh` は Port の偽物 (決めた PR の状態と merge の結果を返す) に差し替える。Agent SDK の偽物は、名前が `mcp__sukuna__` で始まるツールの呼び出しでは、登録した処理を実際に呼ぶ (`features/runtime.md`)。報告のツールを呼ぶ台本で、`flow` の処理まで通す
- 「AI は実装し、テストを通し、レビューの指摘を直してから PR を作る」は AI のスキルの振る舞いで、アプリが渡すのは最初の指示だけである。単体テストで、最初の指示に `dev-impl` の手順、読み替えの表の全行、worktree のパス、merge の手順が入ることを完全一致で確かめる
- 上限の行は、実装待ちの issue を 7 件 (優先度と依存を混ぜる) 用意し、上限 5 で実効の優先度の高い 5 件だけが始まり、1 件の完了で次の 1 件が始まることを確かめる
- merge 前の確認の行は、許可の受け付け (`features/pr-review.md`) から入り、偽物の AI が merge の完了を報告すると完了になることまで確かめる
- worktree の行は、本物の git で、未コミットのファイルがある場合、squash の merge の後に手元だけのコミットを足した場合、何も残っていない場合の 3 つを確かめる。残したときは、`worktree_kept` が記録され、`notifications` に行が増えないことも確かめる
- GitHub を使わない行は、偽物の AI の台本の `shell` の段 (`features/runtime.md`) が本物の git で既定ブランチを fast-forward し、`flow` が完了にすることを確かめる
- worktree の行の、手元だけのコミットと未コミットのファイルは、テストのコードが台本を流す前に git で作る
- CI が通る行は、実装待ちの issue を前提データで用意し、偽物の AI と偽物の `gh` で PR・CI の成功・merge を流すと、issue が完了になり、`inbox` の `changed` が出ることを確かめる
- GitHub で直接 merge された PR は、偽物の `gh` が `MERGED` を返すと、`/flow/notify` の後に issue が完了になることを結合で確かめる

E2E 対象動線: なし (画面を持たない。merge から完了までは `features/pr-review.md` の E2E がなぞる)
