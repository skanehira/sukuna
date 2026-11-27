# PR のレビュー

- 種別: 機能設計書
- 対象 UC: UC-012 (docs/design/USECASES.md)

## 何を作るか

issue の PR の差分、CI の状況、動作確認の証跡をアプリの中で読み、指示を送って直させるか、merge を許可する機能である。

**使う人**: 開発者

**流れ**:

1. issue を開き、「差分」の表示へ移る。merge 前の確認で止まっている issue は、最初からこの表示が開く
2. PR の差分、CI の検査ごとの状況、動作確認の証跡 (スクリーンショットなど) を読む
3. 気になる箇所を選び、質問か指示をストックする
4. 指示を送ると、その issue の実装の会話の AI に届き、AI が直して PR を更新する
5. 問題が無ければ merge を許可し、y / n の確認に y で答える。AI が merge する

**主な決まり**:

- PR への指摘は、既定ではアプリの中だけで扱う。選んだ指示だけを、PR のレビューコメントとして GitHub に投稿する (BR-057)
- merge 前の確認で止まっている issue に指示を送ると、issue は実装中に戻る。AI が PR を直し終えると、もう一度 merge 前の確認で止まる (BR-099)
- merge された後に直させるときは、完了した issue の実装の会話の続きに直してほしい点を送る。issue は実装中に戻り、AI が新しい worktree と新しい PR で直す (BR-058)
- 見つけた問題を別の issue にしたいときは、その箇所に質問を書いてスレッドを始め、スレッドの AI に issue を作らせる。issue の状態は変わらない
- 許可するのは、画面に表示した版の PR である。表示した後に PR が更新されていれば、許可は通らず、読み直しを求める
- GitHub から PR を取得できないときは、そのことと、最後に取得した内容を表示する
- GitHub を使わないプロジェクトでは、PR の代わりに、実装のブランチの差分を手元の git から求めて表示する。CI と証跡は無い

## 入出力と振る舞い

### この機能の前提

- issue の状態の移り変わりの表は `features/issue-flow.md` が正本である。実装、PR の作成、CI の待ち、merge、worktree の片付けの進め方は `features/implementation-flow.md` に従う。本書は、PR を読む画面と、開発者の操作から起きる移り変わりの条件を書く
- 状態を移すのはランナーの `flow` だけとする。画面のサーバーは、merge の許可をランナーへ渡す (DESIGN.md「横断規約 > 自動フローと既存のスキル」)
- PR の画面で作ったストックは、その issue の実装の会話 (`conversations.kind = impl`) に属する。ストックの持ち方・送り方・スレッドは `features/stock-thread.md` に従う
- PR の差分からの引用 (`pr_diff`。パスと行、元の側か先の側か、コミット) の形は、`features/stock-thread.md`「引用の持ち方」が正本である
- GitHub の読み取りと、指摘の投稿は、画面のサーバーが `gh` で行う。PR は `issues.pr_url` で指す
- 画面の部品 (バッファ、メニューの行、y / n の確認) は `features/buffer-ui.md` に従う

### 画面

issue の中の「差分」の表示である (UI_SKETCH.html の `pc-issue-diff`、`prOf`)。Ctrl+l / Ctrl+h で会話・設計・差分の表示を切り替える。最初に開く表示は、merge 前の確認で止まっている issue なら差分、それ以外は issue の状態で決まる (`features/issue.md`)。

表示は上から次の順に並べる。どれも読み取り専用のバッファの行で、Vim の移動・検索・選択がそのまま使える。

1. 取得の状況の行 (取得に失敗したときだけ)。例: 「GitHub から PR を取得できませんでした: <gh の 1 行>。15:20 に取得した内容を表示しています」
2. 見出し「PR #128 予約カレンダーに祝日を表示する」と、項目と値の行: 状況 (merge 前の確認 / 実装中 / merge 済み / 閉じた)、ブランチ (`sukuna/issue-8 → main`)、merge できるか (できる / ぶつかっている / 確かめ中)、URL
3. 見出し「CI  成功 n / 失敗 n / 実行中 n」と、検査ごとの行: 名前、状態 (成功 / 失敗 / 実行中 / 待ち / 取り消し / 飛ばした / そのほか)、かかった時間。検査が 0 件なら「CI の検査はありません」。状態の決め方は「CI の状況の対応」にある
4. 見出し「動作確認」と、PR の本文の「動作確認」の節の中身。画像の行の下に画像を出す。画像を読み込めないときは、行の URL だけを残す。節が無ければ「動作確認の証跡はありません」
5. 差分。ファイルごとに見出し「<パス>  +追加 −削除」を置き、行番号付きで削除と追加を色分けする。長い差分の畳み方は会話の差分と同じにする (`features/conversation.md`)
6. 見出し「以前の PR」と、この issue で前に作った PR の URL (merge の後に直させたときだけ)
7. メニューの行「操作」

| 操作 | 画面に起きること |
| --- | --- |
| 差分の行を選んで Space q / Space c | 選んだ箇所を引用にして質問 / 指示を書き、実装の会話のストックに入る。行の左に印が付く |
| メニュー「merge を許可する」(説明は「CI が通ると merge する」) で Enter | 確認「merge を許可しますか? (y / n)」を出す。送っていない指示があれば「送っていない指示が n 件あります。許可しても送られずに残ります」を添える。merge 前の確認で止まっているときだけ出す |
| 確認で y | 許可を送る。「merge を許可しました」のお知らせが出て、issue は実装中になる |
| メニュー「指摘を書いて実装に戻す」で Enter | 実装の会話の入力欄を開く。入力欄の見出しに、一緒に届くストックの指示の件数を出す。Normal モードの Enter で、文とストックの指示を 1 通で送る |
| Space s c / Space s a | ストックの指示を 1 通にまとめて、実装の会話へ送る |
| Space s q | 質問ごとにスレッドが始まる。issue の状態は変えない |
| メニュー「GitHub から読み直す」で Enter | PR を取得し直して、表示を入れ替える |
| Space g | その issue の worktree でターミナルを開く (`features/worktree-terminal.md`)。worktree が片付けられていれば、プロジェクトのディレクトリで開き、「worktree は片付けられています。プロジェクトのディレクトリで開きました」のお知らせを出す |
| ストックの一覧 (Space l) で、指示の行を選んで Space s g | 確認「選んだ指示 n 件を、PR のレビューコメントとして GitHub に投稿しますか? (y / n)」を出す。y で投稿し、投稿した行に「GitHub に投稿済み」と出す |

PR が無いときの表示:

| 場面 | 表示 |
| --- | --- |
| GitHub を使うプロジェクトで、まだ PR が無い | 「PR はまだありません。実装が終わると、ここに差分と CI の結果が出ます」 |
| GitHub を使わないプロジェクトで、実装のブランチがある | 見出し「実装のブランチ <名前> と既定ブランチの差分」と差分。CI・証跡・投稿の操作は出さない。merge 前の確認で止まっていれば、メニュー「merge を許可する」は出す |
| GitHub を使わないプロジェクトで、merge 済み | 「merge 済みです。変更は会話の差分で見られます」 |

### 指示を送ったときの移り変わり

PR の画面から送った指示も、会話から送った発言も、実装の会話に届く前に `flow` が次の表で issue の状態を決める。判定と処理は 1 か所 (`deliverImplInstruction`) に置く。

| 届けたときの issue | 起きること |
| --- | --- |
| 停止中 (merge 前の確認) | issue を実装中にし、指示を届ける。AI が直して PR を更新し、`report_ready_for_merge` で PR の用意ができたと報告すると、もう一度 merge 前の確認で止まる (BR-099) |
| 停止中 (CI の失敗) | issue を実装中にし、指示を届ける。AI が直して push し、`report_ready_for_merge` を呼び直す (`features/implementation-flow.md`「CI の失敗」) |
| 停止中 (worktree を作れなかった) | `flow` が worktree を作り直し、実装の最初の指示と開発者の指示を 1 通で届ける (`features/issue-flow.md`「停止中から戻る」の `retryStageWorktree`)。merge の後の直しで作れなかったときは、最初の指示を下の「merge の後に直させる」の前置きの文にする |
| 実装中で AI が作業中 | 届く前の指示として預け、今の作業が終わってから届ける (BR-009。`features/conversation.md`) |
| 完了 | 下の「merge の後に直させる」 |
| そのほか (停止中のほかの理由など) | `features/issue-flow.md` に従う |

- 「merge 前の確認で止まる」かどうかは、`issues.confirm_before_merge` で決める。指示で直した後も、この値は変えない
- 実装中に戻したときの `state_changed` の `cause` は `impl_instruction` とする (`features/issue-flow.md`)
- 質問 (スレッド) は、どの状態でも issue の状態を変えない

### merge の後に直させる

完了した issue の実装の会話に、開発者が指示を送ったときの動きである (UC-012 B)。

1. `flow` が issue を実装中に戻し、`issue_events` に `reopened_for_fix` (`{ "previousPrUrl": "..." \| null }`。GitHub を使わないプロジェクトでは `null`) と `stage_changed` (`implement`) を記録する。`closed_at` は空にする
2. 新しい worktree とブランチを、`features/implementation-flow.md`「worktree を作る」の規則で作る。前の worktree は使い直さない。実装の会話の作業ディレクトリを、その worktree に変える
3. worktree を作れなければ、停止中 (`failed`) にする。扱いは `features/implementation-flow.md`「始めるときの手順」と同じにする
   - 引き金になった開発者の指示は届けず、入力欄の書きかけに残す (`features/conversation.md`)
   - 開発者が指示を送るか再開を選び、`flow` が worktree を作り直せたら、手順 4 の前置きの文を最初の指示にする。開発者の指示があれば続けて 1 通にする (`features/issue-flow.md`「停止中から戻る」)
4. 実装の会話の続きとして、AI に 1 通で届ける。先頭に次の文を付け、`origin` は開発者の書いた指示のもの (`developer` か `stock`) のままとする。会話には、前置きを含めて開発者の発言として出す
   - GitHub を使うプロジェクト: 「この issue の PR <URL> は merge 済みです。既定ブランチの最新から作った worktree で、新しい PR を作って次の点を直してください」
   - GitHub を使わないプロジェクト: 「この issue の変更は既定ブランチに入っています。既定ブランチの最新から作った worktree で、次の点を直してください」
5. ここから先は `features/implementation-flow.md` の実装と同じに進む。新しい PR ができたら `issues.pr_url` を新しい URL にし、前の URL は `reopened_for_fix` の記録から「以前の PR」に並べる
6. merge 前の確認を指定した issue なら、新しい PR でも merge 前の確認で止まる

### merge の許可

許可の要求には、画面に表示した先頭のコミット (`headSha`) を付ける。GitHub を使うプロジェクトでは PR の先頭、使わないプロジェクトでは実装のブランチの先頭である。サーバーは次を確かめてから、ランナーへ渡す。

1. issue が停止中で、止まった理由が merge 前の確認 (`merge_confirm`) である。違えば `conflict`
2. GitHub を使うプロジェクトでは、PR が開いている (merge 済みでも閉じてもいない)。違えば `conflict`。使わないプロジェクトでは、この検査を省く
3. `headSha` が、いまの先頭と同じである。GitHub を使うプロジェクトは PR の先頭と、使わないプロジェクトは git で求めた実装のブランチの先頭と比べる。違えば `conflict` で「表示した後に変更が更新されました。読み直してから許可してください」を返す。GitHub から取得できなければ `github_unavailable` を返し、許可しない

ランナーの `flow` は `issue_events` に `merge_allowed` (`{ "headSha": "..." }`) を記録し、issue を実装中にする。実装の会話の続きに次の文を、`origin` を `flow` として届ける。会話には、開発者の発言ではなく「自動フローが指示を送りました」の区切りの行で出す。この後の CI の待ちと merge と完了は `features/implementation-flow.md` に従う。

指示は、実装の会話の現在の作業場所に届ける。古い AI の実行があれば閉じ、出力の読み取りが終わるまで待つ。同じ `session_id` と現在のプロジェクトの設定で開き直す。待つ間に終了処理が始まった場合や、取り下げなどで merge 前の確認から状態が変わった場合は `conflict` とする。許可と指示は保存せず、新しい AI の実行も開かない。

許可と指示の保存は DESIGN.md「トランザクション境界」に従う。worktree の削除と競合して排他の予約を取れなければ `conflict` とし、すべての保存を戻す。会話の同期で確保した予約を使い、issue の保存で取り直さない。届く前の開発者の指示は許可の指示に混ぜず、次の正常終了後に届ける。

- GitHub を使うプロジェクト: 「merge を許可されました。merge の手順で CI を待って merge してください」
- GitHub を使わないプロジェクト: 「merge を許可されました。merge の手順で既定ブランチへ入れてください」

### 指摘を GitHub に投稿する

ストックの一覧で選んだ指示を、PR のレビュー 1 件として投稿する (UC-012 D)。

- 投稿できるのは、その issue の実装の会話のストックの指示で、まだ投稿していないものである。状態 (`stocked` か `sent`) は問わない。質問と投稿済みの指示は飛ばし、飛ばした件数をお知らせに出す
- 引用が PR の差分 (`pr_diff`) で、その行がいまの PR の差分にもある指示は、その行へのコメントにする。そのほか (会話やファイルからの引用、PR の更新で消えた行) は、引用の文を添えてレビューの本文にまとめる
- 「いまの差分にもある」は、引用の `commit` がいまの PR の先頭と同じなら常に真とする。違えば、いまの差分の同じ `path`・同じ `side`・同じ行が、引用の `text` の最初の行で始まるときだけ真とする (`features/stock-thread.md`「印」と同じ判定)
- 行のコメントは、`path` を引用の `path`、`line` と `side` を引用の `end` の行と側から作る。側は `old` を GitHub の `LEFT`、`new` を `RIGHT` にする。`start` が `end` と違う行なら、`start_line` と `start_side` も `start` から作る。レビューの `commit_id` は、いまの PR の先頭のコミットとする
- GitHub が行のコメントを受け付けなかったときは、すべてを本文にまとめて 1 回だけ投稿し直す
- 投稿は `gh api` で、PR のレビュー (種類は COMMENT) を 1 件作る。1 回の呼び出しなので、一部だけが投稿されることは無い
- 投稿した指示には、コメントの URL を `stock_items.github_comment_url` に記録する。AI への送信とは関係が無く、投稿しても指示はストックに残る

### 取得と最後に取得した内容

- PR の情報は `gh pr view <URL> --json number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeable,mergedAt,body,statusCheckRollup,files` で、差分は `gh pr diff <URL>` で取る。ファイル一覧のページ分割と CI の日時への対応は DESIGN.md「既知の制約」に従う
- 取得に成功するたびに、issue ごとの最後に取得した内容 (下の「API」の応答の中身) を `pr_snapshots` に保存する。失敗したときは、保存した内容と失敗の文を返す
- 公開情報で同名の CI の新旧を確定できない場合も、取得失敗として扱う。案内文は「最新の CI を判定できませんでした。GitHubで検査結果を確認してください。」とする。保存済みの内容があれば、その `fetchedAt` を保ち、案内文を `fetchError` に入れて 200 で返す。保存済みの内容がなければ 502 `github_unavailable` を返す
- 画面は、表示を開いたとき、`/ws` の issue の配信を受けたとき、「GitHub から読み直す」を選んだときに取得する。CI の検査に実行中か待ちがあるあいだは、表示を開いている間だけ 30 秒ごとに取得する
- 取得した PR の状態が `MERGED` で、issue が実装中か、停止前の状態が実装中の停止中なら、画面のサーバーは `/flow/notify` を `issue_id` 付きで送る。開発者が GitHub で直接 merge したときに、`flow` が merge を確かめて完了にする (`features/implementation-flow.md`「GitHub で merge されたとき」)
- 証跡は、PR の本文のうち見出し「動作確認」(レベルは問わない) から次の同じレベルの見出しまでとする。画像は Markdown の画像の記法から取り出す。画像はブラウザが URL から直接読み込む
- 差分が大きすぎて GitHub が返さないときは、ファイルの一覧だけを出し、「差分が大きすぎて GitHub から取得できません。Space g のターミナルで確かめてください」を出す

### CI の状況の対応

`statusCheckRollup` には、GitHub Actions などの検査 (CheckRun) と、外部のサービスの状況 (StatusContext) が混ざる。どちらも次の表で行の状態と見出しの数え先に写す。

| GitHub の値 | 行の状態 | 見出しで数える先 |
| --- | --- | --- |
| CheckRun の `conclusion` が `success` | 成功 | 成功 |
| CheckRun の `conclusion` が `neutral` / `skipped` | 飛ばした | 成功 |
| CheckRun の `conclusion` が `failure` / `timed_out` / `action_required` / `startup_failure` | 失敗 | 失敗 |
| CheckRun の `conclusion` が `cancelled` | 取り消し | 失敗 |
| CheckRun の `status` が `in_progress` (`conclusion` が無い) | 実行中 | 実行中 |
| CheckRun の `status` が `queued` / `waiting` / `pending` / `requested` (`conclusion` が無い) | 待ち | 実行中 |
| StatusContext の `state` が `SUCCESS` | 成功 | 成功 |
| StatusContext の `state` が `FAILURE` / `ERROR` | 失敗 | 失敗 |
| StatusContext の `state` が `PENDING` / `EXPECTED` | 実行中 | 実行中 |
| 上のどれにも当たらない (`stale` など) | そのほか | 数えない |

- 失敗と取り消しは、実装の AI が CI の失敗として報告する検査と同じである (`features/implementation-flow.md`「merge の手順」の 3)

## API

共通のエラー応答と本人の判定は DESIGN.md「横断規約 > エラー応答」「横断規約 > 本人の判定」参照。GitHub から取得できないときと投稿できないときは、共通のコード `github_unavailable` (502) を返す。

### GET `/api/issues/:id/pr`

```json
{
  "issueId": "01J...",
  "source": "github",
  "pr": {
    "number": 128, "title": "予約カレンダーに祝日を表示する", "url": "https://github.com/o/r/pull/128",
    "state": "open", "isDraft": false, "headRefName": "sukuna/issue-8", "headSha": "9b1e...",
    "baseRefName": "main", "mergeable": "mergeable", "mergedAt": null
  },
  "checks": [
    { "name": "test", "kind": "check_run", "status": "completed", "conclusion": "success", "state": null, "outcome": "success", "startedAt": 1764100000000, "completedAt": 1764100090000, "detailsUrl": "https://..." },
    { "name": "e2e", "kind": "check_run", "status": "in_progress", "conclusion": null, "state": null, "outcome": "running", "startedAt": 1764100000000, "completedAt": null, "detailsUrl": "https://..." }
  ],
  "evidence": { "markdown": "### 一覧\n![一覧](https://github.com/user-attachments/assets/...)", "images": [{ "alt": "一覧", "url": "https://github.com/user-attachments/assets/..." }] },
  "files": [ { "path": "src/calendar/holiday.ts", "status": "modified", "binary": false, "additions": 2, "deletions": 1, "hunks": [] } ],
  "local": null,
  "diffTooLarge": false,
  "earlierPrUrls": [],
  "fetchedAt": 1764100100000,
  "fetchError": null,
  "waitingMergeConfirm": true,
  "implConversationId": "01J...",
  "worktree": { "id": "01J...", "path": "/Users/me/src/booking-web/.claude/worktrees/issue-8" },
  "unsentInstructionCount": 1
}
```

- `source` は `github` (GitHub の PR) / `local` (GitHub を使わないプロジェクトの実装のブランチ) / `none` (PR もブランチも無い) とする。`none` のときは `pr`・`files` を空にする
- `source` が `local` のときは、`pr` を `null` にし、`local` に `{ "branch": "sukuna/issue-8", "baseBranch": "main", "headSha": "..." }` を入れる。`headSha` は git で求めた実装のブランチの先頭で、merge の許可に付けて送る。ほかの `source` では `local` を `null` にする
- `pr.state` は `open` / `merged` / `closed`、`pr.mergeable` は `mergeable` / `conflicting` / `unknown` とする
- `checks[].kind` は `check_run` / `status_context` とする。`check_run` は `status` と `conclusion` に GitHub の値を小文字で入れ、`status_context` は `state` に入れる。使わない項目は `null` にする
- `checks[].outcome` は「CI の状況の対応」の行の状態で、`success` (成功) / `skipped` (飛ばした) / `failure` (失敗) / `cancelled` (取り消し) / `running` (実行中) / `queued` (待ち) / `other` (そのほか) とする
- `checks` の並びは、失敗 (取り消しを含む)、実行中、待ち、成功 (飛ばしたを含む)、そのほかの順で、同じ中は名前の順とする
- `files[].hunks` の形は `features/design-review.md` の設計 API と同じとする。行番号は、削除の行が PR の元の側、追加と前後の行が PR の先の側の番号である
- 取得に失敗し、保存した内容があれば、200 で保存した内容と `fetchError` (開発者に見せる文) を返す。保存した内容も無ければ 502 `github_unavailable` を返す
- issue が無ければ 404 `not_found`

### POST `/api/issues/:id/pr/allow-merge`

- リクエスト: `{ "headSha": "9b1e..." }`
- 応答: 202 `{ "state": "implementing" }`
- 409 `conflict`: merge 前の確認で止まっていない / PR が開いていない (GitHub を使うプロジェクトだけ) / `headSha` がいまの先頭と違う
- 502 `github_unavailable`: GitHub を使うプロジェクトで、PR の先頭を確かめられない
- 503 `runner_unavailable`: ランナーにつながらない。許可は記録しない

### POST `/api/issues/:id/pr/comments/publish`

- リクエスト: `{ "stockIds": ["01J...", "01J..."] }`。1〜50 件
- 応答: 200

```json
{
  "reviewUrl": "https://github.com/o/r/pull/128#pullrequestreview-1",
  "published": [ { "stockId": "01J...", "url": "https://github.com/o/r/pull/128#discussion_r1", "placement": "line" } ],
  "skipped": [ { "stockId": "01J...", "reason": "question" } ]
}
```

- `placement` は `line` (行へのコメント) / `body` (レビューの本文) とする。`skipped[].reason` は `question` / `already_published` / `not_in_conversation` とする
- 400 `invalid_input`: 件数が範囲の外 / 投稿できる指示が 0 件
- 409 `conflict`: GitHub を使わないプロジェクト / PR が無い / PR が merge 済みか閉じている
- 502 `github_unavailable`: 投稿に失敗した。どの指示にも投稿の記録を付けない

ストックへの指示の送信は `features/stock-thread.md` と `features/conversation.md` の API を使う。この機能は、それらが実装の会話に届ける前に呼ぶ `deliverImplInstruction` を持つ。

### ランナーへの操作

`src/shared/ipc.ts` に次を足す (`features/runtime.md`「画面のサーバーからランナーへの操作」)。状態が合わなければ 409 を返す。

| メソッド | パス | 用途 | 主な入力 | 主な出力 |
| --- | --- | --- | --- | --- |
| POST | `/flow/issues/:id/pr/allow-merge` | merge を許可し、実装の会話に merge の指示を届ける | `head_sha` | `state` |

- 会話の送信とストックの送信は、ランナーの中で、実装の会話に届ける前に `deliverImplInstruction` を呼ぶ。ソケットの操作は足さない

## 実装の配置

| 処理 | 層 | 実装先ファイル |
| --- | --- | --- |
| CI の検査の並べ方と集計、証跡の節の切り出し、行のコメントにできるかの判定 | ドメイン | `src/server/modules/flow/domain/pr-view.ts` |
| PR の画面の内容を組み立て、最後に取得した内容を保存する → issues, issue_events, pr_snapshots, stock_items, worktrees | ユースケース | `src/server/modules/flow/usecase/get-pr.ts` |
| merge の許可の事前の検査と、ランナーへの受け渡し | ユースケース | `src/server/modules/flow/usecase/allow-merge.ts` |
| 指摘の投稿 → stock_items | ユースケース | `src/server/modules/flow/usecase/publish-comments.ts` |
| `gh` の実行 (PR の取得、差分、レビューの投稿) | インフラ (GitHub の Port) | `src/server/modules/flow/adapter/gh-cli.ts` |
| GitHub を使わないプロジェクトの差分 | インフラ (git の Port) | `src/server/modules/workspace/adapter/git-cli.ts` |
| API ハンドラ (`/api/issues/:id/pr` の 3 本) | API ハンドラ | `src/server/modules/flow/adapter/pr-routes.ts` |
| 指示を届けるときの移り変わり (`deliverImplInstruction`)、merge の後に直させる、merge の許可 → issues, issue_events, conversations | ユースケース | `src/runner/modules/flow/usecase/impl-instruction.ts`、`src/runner/modules/flow/usecase/allow-merge.ts` |
| 入出力の Zod のスキーマ | 共有 | `src/shared/api/pr.ts` |
| 「差分」の表示 (行の組み立て、画像の表示、メニュー、確認、30 秒ごとの取得) | UI | `src/front/pages/issue/pr-view.tsx`、`src/front/pages/issue/pr-lines.ts` |

- `pr_snapshots` の `payload` は、GET の応答の中身の JSON である。issue ごとに 1 行を上書きする
- テーブルの定義は DESIGN.md「データスキーマ」参照

## エッジケースの決定

1. **空・最小データ**: PR がまだ無い issue は「PR はまだありません」を出す。CI の検査が 0 件なら「CI の検査はありません」、証跡の節が無ければ「動作確認の証跡はありません」を出す。変更が 0 ファイルの PR は「変更はありません」を出す
2. **上限・境界値**: 投稿は 1 回に 50 件までとする。GitHub が返さない大きさの差分は、ファイルの一覧だけを出す。長いファイルの差分は会話の差分と同じ規則で畳む。CI の検査は件数で切らない
3. **エラー時に利用者へ見えるもの**: 取得の失敗は、表示の先頭の行に、失敗の文と保存した内容の時刻を出す。保存した内容も無ければ、主のウィンドウに失敗の文と「GitHub から読み直す」だけを出す。許可と投稿の失敗は、`message` をエラーのお知らせに出す。`gh` が認証されていないときは「gh にログインしていません。ターミナルで gh auth login を実行してください」を出す。本人の判定は DESIGN.md「横断規約 > 本人の判定」参照
4. **並行操作・二重実行**: 許可は `headSha` が一致し、issue が merge 前の確認で止まっているときだけ通す。2 回目の許可は状態が実装中になっているので `conflict` になる。投稿は、同じ指示を 2 回投稿しないよう、投稿の記録が付いた指示を飛ばす。投稿の要求の処理中に同じ指示の投稿が来たら、後の要求を `conflict` にする (指示ごとに処理中の印を持つ)
5. **再表示時の整合**: 表示は、開くたびと、`/ws` の issue の配信を受けるたびに取得し直す。取得の失敗が続くあいだは、保存した内容と、その取得の時刻を出し続ける
6. **表示の寿命**: 取得の失敗の行は、次に取得に成功するまで残す。「GitHub に投稿済み」の印は、ストックの行に残し続ける。CI の実行中の表示は、取得し直すたびに入れ替える
7. **送る前のデータ**: 指示を書いた入力欄の文は、実装の会話の書きかけの入力に置く (方針 P1)。merge を許可しても、投稿しても、ストックの指示は消さない
8. **状態の移り変わり**: 停止中 (merge 前の確認) → 指示を送る → 実装中 → 直し終える → 停止中 (merge 前の確認)。停止中 (merge 前の確認) → 許可 → 実装中 → merge → 完了。完了 → 指示を送る → 実装中 → 新しい PR → (merge 前の確認 →) 完了。表は `features/issue-flow.md` に写す
9. **自動で進むこと**: 許可した後の merge と、指示を届けた後の直しは、開発者の操作なしに進める (方針 P2)。CI の実行中のあいだの取得は、表示を開いているあいだだけ行う。GitHub への投稿は、開発者が選んで y で答えたときだけ行い、自動ではしない
10. **端末と画面をまたぐこと**: ストック、投稿の記録、最後に取得した内容はサーバーに置き、どの端末でも同じにする。カーソルの位置と、開いている表示はブラウザのタブごとに持つ (方針 P3)
11. **並びと数え方**: 差分のファイルは GitHub が返した順に並べる。CI の検査は API の節の順に並べる。CI の見出しの件数は検査の数で数え、同じ名前の検査が複数あるときは、種類を問わず作成順が最新の 1 件だけを数える。CI のかかった時間は、検査の開始から終了 (実行中なら取得の時刻) までとする

## テスト方針

| 受け入れ基準 (docs/design/USECASES.md) | レベル |
| --- | --- |
| （US-033）issue の PR を開くと、差分と、動作確認の証跡が表示される | 単体 |
| （US-055）issue の PR を開くと、CI の検査ごとの状況が表示される | 単体 |
| （US-033）PR の差分の箇所を選んで指示を送ると、その issue の実装の会話の AI に届き、AI が PR を更新する | 結合 |
| （US-054）merge の前の確認を求められた PR で merge を許可すると、AI が merge する | 結合 |
| （US-079）完了した issue の実装の会話を再開して直してほしい点を送ると、AI が新しい PR を作って直す | 結合 |
| （US-036）ストックの指示を選んで GitHub への投稿を選ぶと、選んだ指示だけが PR のレビューコメントとして投稿される | 結合 |
| （US-033）GitHub から PR を取得できないと、取得できないことと、最後に取得した内容が表示される | 結合 |
| （US-024）PR を開き、指摘を送り、merge を許可するまでを、Vim と同じ操作感のキーボード操作だけで行える | E2E |

- 単体: 「差分」の表示の行の組み立てを、PR の API の応答の見本から確かめる (差分、証跡の節と画像の行、CI の並びと見出しの件数)。CI の状況の対応は、表の行ごとに `pr-view.ts` の単体テストで確かめる。証跡の節の切り出しは、見出しのレベル違いと、節が無い本文で確かめる。文言は完全一致で比べる
- 結合: 画面のサーバーを本物の SQLite で動かし、GitHub の Port を偽物 (決めた PR・CI・差分を返し、投稿の要求を記録する) に差し替える。ランナーの `flow` は、Agent SDK の偽物で動かす。偽物は、名前が `mcp__sukuna__` で始まるツールの呼び出しでは、登録した処理を実際に呼ぶ (`features/runtime.md`)
- 指示を送る行は、merge 前の確認で止まった issue に指示を送ると実装中になり、偽物の AI が `report_ready_for_merge` を呼ぶと、また merge 前の確認で止まることまで確かめる
- GitHub を使わないプロジェクトの許可は、本物の git で作った実装のブランチの先頭と `headSha` を比べ、PR の検査を省いて許可が通ることを結合で確かめる
- 投稿の行は、選んだ指示だけが偽物に届き、質問と投稿済みの指示は届かないことを、偽物が記録した要求の全体を比べて確かめる
- 取得できない行は、1 回目に成功、2 回目に失敗する偽物で、2 回目の応答が保存した内容と `fetchError` を持つことを確かめる。画面の表示は単体で確かめる
- E2E: 前提データで merge 前の確認で止まった issue を作り、GitHub の Port と Agent SDK を偽物にして起動する。差分の表示で Space c で指示をストックし、Space s c で送り、偽物の AI の直しの後にメニューで merge を許可して y で答え、issue が完了になるまでをキーボードだけで行う

E2E 対象動線: （US-024）PR を開き、指摘を送り、merge を許可するまでを、Vim と同じ操作感のキーボード操作だけで行える
