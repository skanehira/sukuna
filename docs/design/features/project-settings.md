# プロジェクトと自動フローの設定

- 種別: 機能設計書
- 対象 UC: UC-014 (docs/design/USECASES.md)

## 何を作るか

リポジトリをプロジェクトとして登録・解除し、AI の動かし方と自動フローをプロジェクトごとに設定し、GitHub の issue の取り込みと利用量の確認を行う機能である。

**使う人**: 開発者

**流れ**:

1. 設定の画面で「プロジェクトを登録する」を選び、Mac Studio の上のリポジトリのパスを書く。プロジェクトがツリーに加わる
2. モデル、許可の扱い、自動で処理する段階、実装の同時実行、merge、設計書の反映のしかたなどを設定する。次に始まる AI からその設定で動く
3. 必要なら、全体かプロジェクトごとに自動フローを一時停止し、後で再開する
4. GitHub の open の issue から選んで、下書きとして取り込む
5. 利用量の画面で、利用枠の状態と、プロジェクトと issue ごとの利用量を見る

**主な決まり**:

- Git のリポジトリではないパスは登録しない
- 設定を変えても、動いている AI はそのまま動く。新しい設定は、次に AI を始めるか再開するときから使う
- 一時停止のあいだも、動いている AI は止めない。issue の状態をきっかけに AI を始めることと、自動の再開をしない (BR-064)
- 取り込んだ GitHub の issue は下書きにし、確定するまで AI は動かない。GitHub の issue は変えない (BR-065)
- 解除しても、リポジトリのファイルとアプリの記録は消さない。同じパスをもう一度登録すると、記録と設定が戻る (BR-066)
- 解除するときは、そのプロジェクトの会話の AI を止める。y / n の確認で、止める会話の件数を知らせる
- 利用量は、AI の実行が知らせる利用枠の状態と、AI の番ごとの使用トークン数から出す

## 入出力と振る舞い

### この機能の前提

- 自動フローが状態ごとに AI を始める規則、拾う順、同時に実装する件数の数え方は `features/issue-flow.md` と `features/implementation-flow.md` に従う。本書は、その規則が読む設定の値と、設定が変わったときの知らせ方を書く
- AI の実行の始め方 (Agent SDK に渡すモデルと許可の扱い) は `features/runtime.md` と `features/conversation.md` に従う。本書は、渡す値をどこから読むかを決める
- 下書きの issue の作り方と、題名・本文の長さの上限は `features/issue.md` に従う
- アプリ全体の設定の画面 (バックアップ、キーの割り当て) は `features/operations.md` が持つ。本書は、同じ設定の画面の「全体」の自動フローと、プロジェクトの節を持つ
- 画面の部品 (項目と値の行、メニューの行、y / n の確認、入力欄) は `features/buffer-ui.md` に従う

### 設定の項目

プロジェクトの設定は `projects` の列に持つ。表の項目の名前は、設定の画面の行の名前である。

| 項目 | 列 | 書ける値 | 画面に出す値の例 | 既定 |
| --- | --- | --- | --- | --- |
| モデル | `model` | `opus` / `sonnet` / `haiku` / 空 (Claude Code の既定) | `opus`。空なら `Claude Code の既定` | 空 |
| 許可の扱い | `permission_mode` | `bypassPermissions` / `acceptEdits` / `default`。日本語の名前 (`確認しない` / `編集だけ確認しない` / `毎回確認する`) でも書ける | `確認しない (bypassPermissions)` | `bypassPermissions` (BR-007) |
| 自動で処理する段階 | `auto_stages` | `精査`・`設計`・`実装` から 1〜3 個を `/` で区切って書く。0 個は `なし` と書く | `精査 / 設計 / 実装`。0 個なら `なし` | 3 つとも |
| 実装の同時実行 | `impl_concurrency` | 1〜20 の整数 | `5 件まで` | 5 (BR-042) |
| merge | `confirm_before_merge_default` | `自動` / `確認する` | `自動` | `自動` (BR-049) |
| 設計書の反映のしかた | `design_merge_mode` | `直接` (列の値は `direct`。既定ブランチへ直接入れる) / `PR` (`pr`。PR で入れる。GitHub を使うときだけ) | `直接` | `直接` |
| このプロジェクトの自動フロー | `flow_paused` | 書けない。メニューの行で切り替える (「一時停止」の節) | `動作中` / `停止中` | 動作中 |
| 名前 | `name` | 1〜40 字。空白と `/` を含まない。登録中のプロジェクトの中で重ならない | `shop-api` | パスの最後のディレクトリ名 |
| パス | `path` | 書けない。登録した時点で決まる | `/Users/me/src/shop-api` | — |
| GitHub を使う | `uses_github` | `使う` / `使わない` | `使う` | 登録のときに判定する |
| 既定ブランチ | `default_branch` | 手元のブランチ名。GitHub を使う場合は `origin` にあるブランチ名も指定できる | `main` | 登録のときに判定する |

全体の自動フローの一時停止は、`settings` の `flow_paused` に `true` / `false` で持つ。既定は `false` である。

- 許可の扱いの値は、Agent SDK の `permissionMode` の値をそのまま持ち、会話の実行を開くときにそのまま渡す (`features/runtime.md`「Agent SDK を包む Port」)。`plan` は選べない。AI がファイルを変えられず、自動フローが進まないためである
- 許可の扱いごとに、どの操作で許可の確認が出るかは `features/conversation.md` に従う
- merge は、このプロジェクトで新しく作る issue の「merge 前の確認」の初めの値を決める。`自動` ならしない、`確認する` ならする。開発者が作る issue、AI が作る issue、取り込んだ issue のどれにも当てる
- 作った issue の merge 前の確認は、issue ごとに直せる (`features/issue.md`)。プロジェクトの merge を変えても、作った issue の値は変わらない (BR-049)

設定の画面のプロジェクトの節は、上から次の順に並べる。

1. 見出し「プロジェクト <名前>」
2. 値の行。モデル、許可の扱い、自動で処理する段階、実装の同時実行、merge、設計書の反映のしかた、このプロジェクトの自動フロー、名前、パス、GitHub を使う、既定ブランチの順にする
3. 案内の行「値の行で i を押すと、その値を書けます。」
4. メニューの行。「このプロジェクトの自動フローを一時停止する」(停止中なら「このプロジェクトの自動フローを再開する」)、「GitHub の issue を下書きとして取り込む」、「利用量を見る」、「プロジェクトを登録する」、「このプロジェクトの登録を解除する」の順にする

設定の行の変え方:

| 操作 | 画面に起きること |
| --- | --- |
| 値の行で `Enter` か `i` | 今の値を書いた入力欄を開く (`features/buffer-ui.md`)。Normal モードの `Enter` で保存する |
| パスの行と、このプロジェクトの自動フローの行で `Enter` か `i` | 何もしない。パスは変えられず、自動フローはメニューの行で切り替える |

- ステータス行のキーの案内は、値の行では「i <項目>を書く / - 戻る」とする
- 設定は、次に開く実行から効く。新しく始める会話と、止まった会話の再開が当たる。動いている AI には、その実行を開いたときの設定が効き続ける
- 保存したら、お知らせに「<項目>を書き換えました」を出す。保存に失敗したら、`message` をエラーのお知らせに出し、入力欄は書いた値を残す
- モデルの行は空で保存でき、空は Claude Code の既定を指す。自動で処理する段階を 0 個にするときは `なし` と書く。どちらも `features/buffer-ui.md` の空の本文を断る決まりの例外である
- 画面は、書いた文を API の値に直して送る (例: `精査 / 設計` は `["triage", "design"]`、`5 件まで` は `5`)。直せない文は送らず、エラーのお知らせ「<項目>に書ける値: <書ける値>」を出す

**値の使われ方**:

- ランナーは会話の種類を問わず、AI の実行を開くたびにプロジェクトのモデルと許可の扱いを読む。停止・失敗・利用枠切れから会話を再開するときも、その時点の設定を使う。設定が変わっていれば前の実行を閉じて、同じ会話を開き直す。動いている実行には開始時の設定を使い続ける
- 自動で処理する段階から外した段階の issue には、自動フローは AI を始めない。issue はその状態のまま待つ。開発者は会話で `/dev-triage`、`/dev-feat-spec`、`/dev-impl` を自分で呼び出せる。開発者が始めた会話で手で呼び出しても、issue の状態は変わらない。issue の状態を移すのは、自動フローの会話の報告だけである (`features/issue.md`「AI に渡すツール」)。手で実装を終えた issue は、開発者が取り下げて閉じる
- 設計書の反映のしかたは、承認したときに読む (`features/design-review.md`)
- 同時に実装する件数を減らしても、動いている実装は止めない。件数が上限を下回るまで、新しい実装を始めない。増やしたときは、すぐに待っている issue を拾う

### 一時停止

| 一時停止したとき止めること | 止めないこと |
| --- | --- |
| issue の状態の変化をきっかけに、精査・設計・実装の AI を始めること | 動いている AI (BR-064) |
| 自動フローの会話の自動の再開 (利用枠が戻ったとき、ランナーの再起動のあと) | 開発者が会話に送った指示で AI が動くこと (差し戻しと、PR への指示を含む) |
| 承認のあと、設計書の PR を merge させる AI を始めること | 承認のあとの、アプリによる設計書の反映 (直接入れるとき) |

- 全体の一時停止とプロジェクトの一時停止は、どちらかが一時停止なら止まる
- 再開すると、ランナーの `flow` が、待っていた issue と、再開を待っていた自動フローの会話を、ふだんの規則で拾い直す。拾う順と件数の上限は `features/issue-flow.md` に従う
- 一時停止のあいだも、issue の状態は移る (例: 承認すると実装待ちになる)。AI が始まらないだけである
- 一覧は、一時停止で AI の開始を待つ issue を作業中に置き、状況を「自動フローを一時停止しています」にする (`features/inbox.md`)
- バックアップから復元すると、全体の自動フローが一時停止になる (`features/operations.md`「復元」)

一時停止の操作:

| 操作 | 画面に起きること |
| --- | --- |
| `:pause` / `:resume` | 全体の自動フローを一時停止する / 再開する (`PUT /api/settings/flow-paused`)。お知らせに「自動フローを一時停止しました」か「自動フローを再開しました」を出す |
| 設定の画面の「全体」の節のメニューの行「自動フローを一時停止する」/「自動フローを再開する」 | 同じ。メニューの行の説明は「全プロジェクトに効く」とする |
| 設定の画面のプロジェクトの節のメニューの行「このプロジェクトの自動フローを一時停止する」/「このプロジェクトの自動フローを再開する」 | そのプロジェクトの一時停止を切り替える (`PATCH /api/projects/:id` の `flowPaused`)。お知らせは全体と同じ文にする |

- 設定の画面の「全体」の節には、`自動フロー  動作中` か `自動フロー  停止中` の行と、上のメニューの行を 1 つ出す。値は `GET /api/settings` の `flowPaused` から読む (`features/operations.md`)

### 設定が変わったときの知らせ方

設定は画面のサーバーが `projects` と `settings` に書く。書いたら、次の 2 つを送る。

- ランナーのソケットの `POST /flow/notify` (`features/runtime.md`「画面のサーバーからランナーへの操作」)。`projects` に書いたとき (登録、戻す、設定の変更、一時停止、解除) は `project_id` を付け、全体の一時停止では何も付けない
- 配信の `inbox` の `changed` (`features/runtime.md`「配信」)。`projects` に書いたときは `project_ids` にそのプロジェクトを入れる。ツリー、一覧、プロジェクトの画面、設定の画面は、これを受けて読み直す

ランナーの `flow` は、知らせを受けたら、待っている issue を拾い直す (`features/issue-flow.md`「段階の AI を始める」)。登録で戻したプロジェクトも、この拾い直しで、まだ AI を始めていない issue を始める。知らせが届かなくても、`flow` は issue を拾う前に毎回 `projects` と `settings` を読む。そのため、知らせが落ちても次の拾い直しで追いつく。

### 登録

1. パスは、絶対パス、`~`、または `~/` で始まるものを受け付ける。`~` はホームディレクトリに置き換え、シンボリックリンクを解いた実際のパスにする
2. パスが無ければ、「パスがありません: <パス>」を返す
3. `git -C <パス> rev-parse --show-toplevel` が失敗すれば、「Git のリポジトリではありません: <パス>。リポジトリのパスを指定してください」を返して登録しない
4. リポジトリの中のディレクトリを指したときは、リポジトリの最上位のパスで登録し、応答でそのことを知らせる
5. 別のリポジトリの worktree を指したとき (`--git-dir` と `--git-common-dir` が違う) は、「これは worktree です。リポジトリ本体のパス <パス> を指定してください」を返す
6. 同じパスのプロジェクトが登録中なら `conflict` を返す。解除したプロジェクトなら、`removed_at` を消して戻す。名前、設定、issue、会話はそのまま戻る。元の名前を別の登録中のプロジェクトが使っていれば `conflict` を返す
7. `origin` が GitHub を指し、`gh repo view` が成功したら、GitHub を「使う」で登録する。GitHub の確認に失敗したら、「使わない」で登録し、応答の `notes` に理由を入れる
8. GitHub を使う場合は、`origin/HEAD` が指す実在のブランチを既定にする。その参照先が無い場合と GitHub を使わない場合は、リポジトリ本体で開いているブランチを使う。初回コミット前も `HEAD` の名前で登録できる。既定を決められなければ、リポジトリ本体でブランチを開くよう案内する
9. 登録したら、ツリーにプロジェクトを加え、設定の画面のそのプロジェクトの節を開く

### 解除

停止の対象を決めてから解除を書き込むまで、新しい会話と番の開始を断る。解除が完了したあとに、停止の対象から漏れた AI が動き続けるのを防ぐ。解除に失敗したとき、同じ利用枠待ちの会話は自動再開の対象に残る。

設計の承認と解除が重なったときは、先に予約を取った操作を進める。対象の期間は `features/design-review.md`「承認と反映」に従う。

1. 確認「このプロジェクトの登録を解除しますか? (y / n)」を出す。止める会話があれば「AI を止める会話 <件数> 件があります」を添える。件数は 2 の対象の会話の数で、`GET /api/projects/:id` の `stopTargetCount` から読む。リポジトリのファイルは消さないことも添える
2. y で答えると、ランナーがそのプロジェクトの会話を止める (下の「ランナーへの操作」)。対象は、作業中、質問か許可の確認を待っている、利用枠の戻りを待っている、ランナーの再起動で止まった (`stopped` (`restarted`)) 会話である。止め方は会話の停止と同じで、作業は保存する。止めた理由は `user` とし、利用枠の戻りを待つタイマーも外す
3. `projects.removed_at` に時刻を入れる。ツリー、一覧、プロジェクトの画面から外し、そのプロジェクトの会話と issue の通知を取り下げる。取り下げは `features/inbox.md`「ほかの端末の通知を消す」の口を呼ぶ
4. issue の状態、会話、worktree、ストックは変えない。開いているターミナルも終わらせない
5. 同じパスをもう一度登録しても、止めた会話は自動では続かない。自動フローの会話も、開発者が issue の会話に指示を送ると続く (`features/issue-flow.md`「ランナーの再起動のあと」)。まだ AI を始めていない issue は、登録し直したあとの評価で始まる

### GitHub の issue の取り込み

1. 設定の画面のメニュー「GitHub の issue を下書きとして取り込む」で、主のウィンドウに取り込みの画面を開く
2. `gh issue list --state open --limit 200 --json number,title,labels,createdAt,url` に、`--repo` で `origin` のリポジトリを指定する。結果を番号の大きい順に並べる。列は「番号と題名 / ラベル / 作った日 / 取り込み」とする。取り込み済みの行は「取り込み済み」と出し、薄くする。200 件あれば「新しい 200 件だけを並べています」を出す
3. カーソルの行か、V で選んだ範囲の行を、メニュー「選んだ issue を下書きとして取り込む」で取り込む
4. 選んだ番号ごとに `gh issue view <番号> --json number,title,body,state,url` に同じ `--repo` を付けて最新の内容を取り、open のものだけを下書きの issue として作る。本文の末尾に「GitHub から取り込んだ issue: <URL>」を足し、`issues.github_number` に番号を記録する
5. 結果を「3 件を下書きとして取り込みました (取り込み済みの 1 件は飛ばしました)」のお知らせに出し、一覧を取り直す

- 取り込み済みとは、そのプロジェクトに同じ `github_number` の issue があることを指す
- 題名か本文 (末尾に足す 1 行を含む) が `features/issue.md` の上限を超える issue は、取り込まずに飛ばす。理由は `too_long` とする
- 結果のお知らせでは、飛ばした件を理由ごとの件数で添える (例: 「上限を超えた 1 件は飛ばしました」)
- 取り込んだ issue を取り下げると、`flow` が `github_number` を空にする。同じ GitHub の issue を取り込み直せるようにするためである (一意の制約 `issues (project_id, github_number)`)
- 取り込むのは題名と本文だけで、コメント、ラベル、担当者は取り込まない
- GitHub の issue は閉じず、コメントも付けない (DESIGN.md「横断規約 > 自動フローと既存のスキル」)

### 利用量

利用量の画面は、設定の画面のメニュー「利用量を見る」か、コマンド `:usage` で主のウィンドウに開く。

| 部分 | 中身 |
| --- | --- |
| 利用枠 | 「余裕があります」「残りが少なくなっています」「上限に達しました。15:00 に戻ります」「超過分の利用で続けています」のどれかと、確かめた時刻。まだ記録が無ければ「まだ分かりません。AI が動くと分かります」 |
| プロジェクトと issue ごとの利用量 | 列は「名前 / 直近 5 時間のトークン / 直近 7 日のトークン / 直近 7 日の料金の目安」。プロジェクトの行の下に、issue の行と「issue の無い会話」の行を字下げして並べる |
| 注記 | 「料金の目安は API の料金に換算した値で、サブスクリプションの請求額ではありません」「目次などの更新に使った分は含みません」 |

**利用枠の状態**:

- ランナーは、AI の実行が知らせる利用枠の状態のイベント (`rate_limit_event`) を受けるたびに、その `rate_limit_info` を `settings` の `usage.rate_limit` に保存する。形は `{ "status": "allowed" | "allowed_warning" | "rejected", "resetsAt": <Unix ミリ秒 | null>, "overageStatus": <文字列 | null>, "observedAt": <Unix ミリ秒> }` とする。`resetsAt` は、イベントの Unix 秒を 1000 倍して入れる
- 画面の文は `status` から決める。`rejected` でも、`overageStatus` が `allowed` か `allowed_warning` なら「超過分の利用で続けています」とする (DESIGN.md「既知の制約」の利用枠切れの判定と同じ規則)
- `resetsAt` を過ぎていれば「戻る時刻を過ぎました。次に AI が動くと更新されます」を添える
- 利用枠の割合などを示す実験的な情報 (`usage_EXPERIMENTAL` で始まるもの) と、型の定義に無い項目は使わない

**プロジェクトと issue ごとの利用量**:

- 番の終わりの記録 (`conversation_events` の `turn_end`) を集計する。目次など、会話の番に記録しない処理の利用量は含めない
- トークン数は各番の入力、出力、キャッシュの作成、キャッシュの読み取りの合計とする
- 料金は、同じ会話で前の番が返した累計との差を数える。最初の番か、累計が減ってリセットされた番では、その番の値を使う
- 利用量の期間には、イベントの `created_at` が「今の時刻 − 5 時間」か「今の時刻 − 7 日」ちょうどを含む。直前の番が期間外でも、料金の差を出す基準には使う
- スレッドの利用量は、元の会話を辿り、いちばん上の会話の issue とプロジェクトに数える。料金の差は各スレッドで求める

トークンと料金の値の意味は [FEASIBILITY.md「PoC 結果 > usage-per-turn」](../FEASIBILITY.md#usage-per-turn--verified-confidence-095) に従う。記録する値の形は `features/runtime.md`「Agent SDK のメッセージからの写し方」を参照する。

## API

共通のエラー応答と接続範囲は DESIGN.md「横断規約 > エラー応答」「横断規約 > 接続範囲」参照。この機能だけのコードとして、`not_a_repository` (400。Git のリポジトリではない) と `github_unavailable` (502。`gh` が失敗した) を使う。

### POST `/api/projects`

- リクエスト: `{ "path": "~/src/shop-api", "name": "shop-api" }`。`name` は省略できる
- 応答: 201 (新しく登録) か 200 (解除したものを戻した)

```json
{
  "project": { "id": "01J...", "name": "shop-api", "path": "/Users/me/src/shop-api", "usesGithub": true, "defaultBranch": "main" },
  "restored": false,
  "notes": ["リポジトリの最上位のパスで登録しました"]
}
```

- 400 `invalid_input` — 「登録」のパス規則に合わない、パスが無い、worktree を指した、名前が規則に合わない、既定ブランチを決められない
- 400 `not_a_repository`: Git のリポジトリではない
- 409 `conflict`: 同じパスが登録中 / 名前が登録中のほかのプロジェクトと重なる

### GET `/api/projects/:id`

設定の画面が読む。

```json
{
  "id": "01J...", "name": "shop-api", "path": "/Users/me/src/shop-api",
  "usesGithub": true, "defaultBranch": "main", "model": null, "permissionMode": "bypassPermissions",
  "autoStages": ["triage", "design", "impl"], "designMergeMode": "direct", "implConcurrency": 5,
  "confirmBeforeMergeDefault": false, "flowPaused": false, "globalFlowPaused": false, "stopTargetCount": 2
}
```

- `stopTargetCount` は、解除で止める会話の数である。対象は「解除」の 2 と同じで、`run_state` が `working` / `waiting_answer` / `waiting_permission` / `usage_limited` の会話と、`stopped` (`restarted`) の会話である
- 解除したプロジェクトは 404 `not_found`

### PATCH `/api/projects/:id`

- リクエスト: 変える項目だけを送る。`{ "name"?, "usesGithub"?, "defaultBranch"?, "model"?, "permissionMode"?, "autoStages"?, "designMergeMode"?, "implConcurrency"?, "confirmBeforeMergeDefault"?, "flowPaused"? }`
- 応答: 200 で GET `/api/projects/:id` と同じ形
- 400 `invalid_input` — 値が「設定の項目」の範囲外か、その規則で指定できる既定ブランチが無い場合。GitHub を使わずに PR で反映するときや、GitHub を使うための `gh repo view` が失敗したときも返す。`message` に理由を書く
- 409 `conflict`: 名前が重なる
- 1 回の要求の項目をまとめて検査し、すべて通れば保存する。GitHub を使わない設定に変えるとき、既定ブランチが `origin` にしか無ければ、同じ要求で手元のブランチを指定する

### DELETE `/api/projects/:id`

- 応答: 200 `{ "stoppedConversationIds": ["01J..."] }`
- 404 `not_found`: 無いか、もう解除してある
- 409 `conflict`: 同じプロジェクトの解除、番の開始、設計の承認・反映と重なった。状態を確かめてから、もう一度操作できる
- 503 `runner_unavailable`: ランナーにつながらず、AI を止められない。解除しない

### ランナーへの操作

`src/shared/ipc.ts` に次を足す (`features/runtime.md`「画面のサーバーからランナーへの操作」)。

| メソッド | パス | 用途 | 主な入力 | 主な出力 |
| --- | --- | --- | --- | --- |
| POST | `/flow/projects/:id/stop` | 解除の前に、そのプロジェクトの会話を止める (「解除」の 2) | なし | `stopped_conversation_ids` |

- 画面のサーバーは、この操作が成功してから `projects.removed_at` を書く。失敗したら解除しない
- 止める会話が 0 件でも成功にする

### PUT `/api/settings/flow-paused`

全体の自動フローを一時停止するか、再開する。`settings` の `flow_paused` に書き、`/flow/notify` で知らせ、配信の `app` の `settings_changed` と `inbox` の `changed` を送る。

- リクエスト: `{ "paused": true }`。自動フローを再開するときは `false` を送る
- 応答: 200 `{ "paused": true }`。値は保存した真偽値
- 400 `invalid_input`: `paused` が無いか、真偽値でない

### GET `/api/projects/:id/github-issues`

取り込みの候補を返す。

```json
{
  "issues": [ { "number": 12, "title": "ログの保存期間", "labels": ["enhancement"], "createdAt": 1764000000000, "url": "https://github.com/o/r/issues/12", "imported": false } ],
  "truncated": false
}
```

- 409 `conflict`: GitHub を使わないプロジェクト
- 502 `github_unavailable`: `gh` が失敗した。`message` に `gh` の出力の最初のエラーの 1 行と、ログインの手順を書く

### POST `/api/projects/:id/github-import`

- リクエスト: `{ "numbers": [12, 13] }`。1〜100 件
- 応答: 200

```json
{
  "imported": [ { "githubNumber": 12, "issueId": "01J...", "issueNumber": 47 } ],
  "skipped": [ { "githubNumber": 13, "reason": "already_imported" } ]
}
```

- `skipped[].reason` は `already_imported` / `not_open` / `not_found` / `too_long` とする
- 400 `invalid_input`: 件数が範囲の外
- 409 `conflict`: GitHub を使わないプロジェクト
- 502 `github_unavailable`: 1 件も取得できなかった。取り込めた分があれば 200 で返し、取れなかった番号を `not_found` にする

### GET `/api/usage`

```json
{
  "rateLimit": { "status": "allowed_warning", "resetsAt": 1764118800000, "usingOverage": false, "observedAt": 1764110000000 },
  "now": 1764111000000,
  "projects": [
    {
      "projectId": "01J...", "name": "shop-api",
      "total": { "tokens5h": 1200000, "tokens7d": 8400000, "costUsd7d": 31.2 },
      "issues": [ { "issueId": "01J...", "number": 43, "title": "注文 CSV の文字化けを直す", "tokens5h": 900000, "tokens7d": 2100000, "costUsd7d": 8.4 } ],
      "withoutIssue": { "tokens5h": 300000, "tokens7d": 1500000, "costUsd7d": 5.1 }
    }
  ]
}
```

- `rateLimit` は、記録が無ければ `null` とする
- `usingOverage` は、保存した `overageStatus` が `allowed` か `allowed_warning` のとき `true` とする
- 直近 7 日に使った量が 0 のプロジェクトと issue は返さない。解除したプロジェクトも返さない

## 実装の配置

| 処理 | 層 | 実装先ファイル |
| --- | --- | --- |
| 設定の項目の検査と既定値、パスの受け付けの規則 | ドメイン | `src/server/modules/workspace/domain/project-settings.ts` |
| 登録・戻す → projects | ユースケース | `src/server/modules/workspace/usecase/register-project.ts` |
| 設定を読む、変える → projects | ユースケース | `src/server/modules/workspace/usecase/get-project.ts`、`src/server/modules/workspace/usecase/update-project.ts` |
| 解除 → projects (通知の取り下げは `features/inbox.md` の口を呼ぶ) | ユースケース | `src/server/modules/workspace/usecase/unregister-project.ts` |
| 全体の一時停止 → settings | ユースケース | `src/server/modules/settings/usecase/set-flow-paused.ts` |
| 取り込みの候補と取り込み → issues | ユースケース | `src/server/modules/issue/usecase/github-import.ts` |
| git の実行 (最上位のパス、既定ブランチ、ブランチの有無) | インフラ (git の Port) | `src/server/modules/workspace/adapter/git-cli.ts` |
| `gh` の実行 (リポジトリの確かめ、issue の一覧と取得) | インフラ (GitHub の Port) | `src/server/modules/issue/adapter/gh-cli.ts` |
| 利用量の集計 (期間、スレッドの付け替え) → conversation_events, conversations, issues, projects, settings | ドメイン / ユースケース | `src/server/modules/conversation/domain/usage.ts`、`src/server/modules/conversation/usecase/get-usage.ts` |
| API ハンドラ (プロジェクト、取り込み、利用量) | API ハンドラ | `src/server/modules/workspace/adapter/project-routes.ts`、`src/server/modules/issue/adapter/github-import-routes.ts`、`src/server/modules/conversation/adapter/usage-routes.ts` |
| `PUT /api/settings/flow-paused` のハンドラ | API ハンドラ | `features/operations.md` の設定の API ハンドラ (`src/server/modules/settings/adapter/routes.ts`) に足す |
| 設定の変化を受けて issue を拾い直す。一時停止と段階の検査 | ユースケース | `src/runner/modules/flow/usecase/flow-gate.ts` |
| 解除の前に会話を止める (`/flow/projects/:id/stop`) → conversations, conversation_events | ユースケース | `src/runner/modules/flow/usecase/stop-project.ts` |
| 利用枠の状態を保存する → settings | ユースケース | `src/runner/modules/conversation/usecase/record-rate-limit.ts` (`features/runtime.md` のランナーの会話の実行が作る。本機能は保存した値を読む) |
| 入出力の Zod のスキーマ | 共有 | `src/shared/api/project.ts`、`src/shared/api/usage.ts` |
| 設定の画面の「全体」の自動フローの行と、プロジェクトの節 | UI | `src/front/components/settings/project-section.tsx` (`features/operations.md` の設定の画面 `src/front/pages/settings.tsx` が並べる部品) |
| 取り込みの画面、利用量の画面 | UI | `src/front/pages/github-import.tsx`、`src/front/pages/usage.tsx` |

- 使う列 (`projects` の `model`・`auto_stages`・`confirm_before_merge_default`、`issues` の `github_number`) と一意の制約の定義は DESIGN.md「データスキーマ」参照

## エッジケースの決定

1. **空・最小データ**: プロジェクトが 0 件のとき、設定の画面はプロジェクトの節の代わりに「プロジェクトはまだありません」とメニュー「プロジェクトを登録する」を出す。GitHub の open の issue が 0 件なら「open の issue はありません」を出す。利用量が 0 なら「直近 7 日に AI は動いていません」を出す。自動で処理する段階を 0 個にしてもよく、そのときは自動フローの AI がそのプロジェクトで始まらない
2. **上限・境界値**: 名前は 1〜40 字、同時に実装する件数は 1〜20、取り込みの候補は 200 件まで、1 回の取り込みは 100 件までとする。期間の境目は「今の時刻 − 5 時間」「今の時刻 − 7 日」ちょうどを含む
3. **エラー時に利用者へ見えるもの**: 登録・設定・取り込みの失敗は、`message` をエラーのお知らせに出し、入力欄と書いた値を残す。`gh` にログインしていないときは「gh にログインしていません。ターミナルで gh auth login を実行してください」を出す。接続範囲は DESIGN.md「横断規約 > 接続範囲」参照
4. **並行操作・二重実行**: 同じパスを 2 つの端末から同時に登録すると、`projects.path` の一意の制約で後の方が `conflict` になる。同じ GitHub の issue を同時に取り込むと、`issues (project_id, github_number)` の一意の制約で後の方を `already_imported` にする。設定を 2 つの端末で同時に変えると、項目ごとに後から書いた値が残る
5. **再表示時の整合**: 設定の画面は、開くたびと、配信の `inbox` の `changed` の `project_ids` に開いているプロジェクトがあるたびに、GET `/api/projects/:id` を読み直す。全体の一時停止は `app` の `settings_changed` で読み直す。利用量の画面は開くたびに集計し、開いたままでは自動で更新しない。取り込みの画面は、取り込みの後に候補を取り直す
6. **表示の寿命**: 設定を変えたお知らせ「許可の扱いを書き換えました」は 4 秒で消える。一時停止のあいだは、ステータス行に「自動フロー停止中」を出し続ける。利用枠の状態は、次のイベントを受けるまで同じ表示を残す
7. **送る前のデータ**: 値の行の入力欄は、保存に失敗しても書いた値を残す。この入力は会話の書きかけの入力ではないので、サーバーには置かず、閉じると消える。一時停止は、メニューの行を選んだ時点で保存する
8. **状態の移り変わり**: プロジェクトは 登録中 → (解除) → 解除済み → (同じパスで登録) → 登録中 と移る。自動フローは 動作中 ⇄ 一時停止 を、全体とプロジェクトのそれぞれで持つ
9. **自動で進むこと**: 再開と、段階を戻したときと、同時に実装する件数を増やしたときは、待っていた issue の AI を開発者の操作なしに始める (方針 P2)。取り込みも、利用枠の状態の保存も、開発者の操作か AI の実行のイベントだけをきっかけにし、GitHub を定期的には読まない
10. **端末と画面をまたぐこと**: 設定と一時停止はサーバーに置き、どの端末でも同じにする。設定の画面でどのプロジェクトの節を開いているか、カーソルの位置は、ブラウザのタブごとに持つ (方針 P3)
11. **並びと数え方**: 設定の画面は「全体」の節の後に、いまのプロジェクトの節を出す。いまのプロジェクトが決まらない画面から開いたときは、ツリーの先頭のプロジェクトを出し、`:set <名前>` でほかのプロジェクトを開く。利用量は、プロジェクトも issue も直近 7 日のトークンの多い順に並べ、同じなら名前と番号の順とする。issue の無い会話の行は、プロジェクトの中の最後に置く。取り込みの候補は GitHub の番号の大きい順に並べる

## テスト方針

| 受け入れ基準 (docs/design/USECASES.md) | レベル |
| --- | --- |
| （US-001）リポジトリのパスを指定して登録すると、プロジェクトがプロジェクトの一覧に加わる | E2E |
| （US-001）Git のリポジトリではないパスを指定すると、リポジトリではないことが表示され、登録されない | 結合 |
| （US-001）プロジェクトを解除すると、プロジェクトの一覧から外れ、リポジトリのファイルは消えない | 結合 |
| （US-043）プロジェクトのモデル、許可の扱い、自動で処理する段階を設定すると、次に始まる AI からその設定で動く | 結合 |
| （US-043）自動で処理する段階から実装を外すと、実装待ちの issue に AI は始まらず、自分で `/dev-impl` を呼び出せる | 結合 |
| （US-042）自動フローを一時停止すると、動いている AI は続き、新しい AI は始まらない | 結合 |
| （US-042）一時停止を再開すると、待っていた issue の AI が始まる | 結合 |
| （US-035）取り込みで GitHub の issue を選ぶと、選んだ issue が下書きとして登録される | 結合 |
| （US-061）利用量を開くと、issue とプロジェクトごとの利用量が表示される | 結合 |

- 結合: 画面のサーバーとランナーを、本物の SQLite と、一時ディレクトリに作った本物の git のリポジトリで動かす。Agent SDK は台本どおりにイベントを流す偽物、GitHub の Port は決めた issue の一覧を返す偽物に差し替える
- 設定の行は、偽物の Agent SDK が受け取った実行の設定 (モデルと許可の扱い) の全体を比べる。設定を変える前に始めた会話には、前の値が渡り続けることも確かめる
- 実装を外す行は、実装待ちの issue に AI が始まらないことを、同じ時点で精査待ちの issue には AI が始まることと対にして確かめる。開発者の会話で `/dev-impl` を送ると、その指示が AI に届き、issue の状態は変わらないことも確かめる
- 一時停止の行は、動いている会話の実行が止められていないことと、精査待ちに移した issue に AI が始まらないことを確かめる。再開の行は、再開したあとにその issue の AI が始まることを確かめる
- 利用量の行は、`turn_end` の記録を前提データで入れ、スレッドの分が元の issue に数えられること、5 時間と 7 日の境目の内と外を確かめる。画面の数の書式 (桁の区切り、料金の小数 2 桁) は単体で確かめる
- 解除の行は、解除の後にプロジェクトの一覧に出ないことと、リポジトリのファイルが残っていることを確かめる。作業中の自動フローの会話が `stopped` (`user`) になり、同じパスを登録し直しても動かないことも確かめる
- E2E: 画面の設定の画面から「プロジェクトを登録する」を選び、一時ディレクトリに作ったリポジトリのパスを書いて登録し、ツリーにプロジェクトが加わるまでをキーボードで行う

E2E 対象動線: （US-001）リポジトリのパスを指定して登録すると、プロジェクトがプロジェクトの一覧に加わる
