# 画面のサーバーとランナーの土台

- 種別: 機能設計書
- 対象 UC: なし (タスク説明から起こした)

## 何を作るか

AI を動かすランナーと画面のサーバーを別々に動かし、AI の出力を保存して画面へ届ける土台を作る。

**使う人**: 開発者 (画面を通して間接に使う)。ほかの機能を実装する AI は、この土台の上に会話や自動フローを作る。

**流れ**:

1. Mac の起動時に、画面のサーバーとランナーが別々に起動し、どちらか先に起動した方がデータベースの形を最新にする
2. 開発者が画面で操作すると、画面のサーバーがランナーへ操作を頼む
3. ランナーが Claude Code を動かし、発言・ツールの実行・差分・質問・番の終わりを 1 件ずつ記録に保存する
4. ランナーは、どの会話が変わったかを画面のサーバーに知らせる
5. 画面のサーバーは記録を読み、その会話を開いている画面へ届ける

**主な決まり**:

- 画面のサーバーを入れ替えても、ランナーの AI は止まらない。入れ替えたあと、画面は続きから受け取る (BR-069)
- 会話の記録を書くのはランナーだけで、1 つの会話を動かすのは同時に 1 つだけである
- 画面は、つなぎ直したときに、最後に受け取った番号の続きから記録を受け取る。途切れが長いときは読み直す
- ランナーが再起動すると、開発者が始めた会話は止まった扱いになり、指示を送るまで動かない。自動フローの会話は続きから動く
- 利用枠切れで止まった会話は、枠が戻る時刻の 1 分後に自動で再開する。時刻が分からないときは 15 分ごとに試す。自動フローの会話は、一時停止のときと、その段階を自動で処理しないときは再開しない
- 作業中に届いた指示は、AI の番が正常に終わってから 1 通にまとめて届ける。止めたときと失敗したときは届けずに残す。割り込みで送った指示は、AI を止めてすぐに届ける
- テストでは本物の Claude を呼ばず、台本どおりに出力を流す偽物を使う

## 入出力と振る舞い

### この機能の前提

- 本書は、プロセスの間のやりとり、会話の記録の種類と形、画面への配信、AI を包む Port、ランナーの再起動の機構、マイグレーション、ログの正本である
- 本書は、書くプロセスの分担、`gh` の実行器とその偽物の正本でもある
- 環境変数の値の形、既定の値、読むプロセス、起動を失敗させる条件は `features/operations.md`「環境変数」が正本である
- 再起動のときの規則そのものは DESIGN.md「横断規約 > ランナーの再起動」が正本で、本書はその実現の手順を書く
- 配信の 1 件の形と本人の判定は DESIGN.md「横断規約 > 配信」「横断規約 > 本人の判定」参照
- エラーの形とコードは DESIGN.md「横断規約 > エラー応答」参照
- 会話の画面での見せ方、指示の送り方の UI は `features/conversation.md` が持つ。本書は、その下で動く仕組みだけを持つ

### プロセスと起動

画面のサーバーとランナーは、同じリポジトリの別の入口から起動する。どちらも `SUKUNA_HOME` の同じ SQLite のファイルを開く。

| 項目 | 画面のサーバー | ランナー |
| --- | --- | --- |
| 入口 | `src/server/main.ts` | `src/runner/main.ts` |
| 待ち受け | 0.0.0.0 の `PORT` (HTTP と `/ws`) | Unix ドメインソケット `SUKUNA_RUNNER_SOCKET` |
| 相手とのつながり | ランナーのソケットへ接続する側 | 接続を受ける側 |
| 落ちたとき | ランナーの AI は動き続ける | 画面のサーバーは API に 503 を返し続ける |

ソケットのパスは環境変数 `SUKUNA_RUNNER_SOCKET` で決め、権限は所有者だけの読み書き (0600) にする。macOS のソケットのパスは 104 バイト未満に限られる。パスが 103 バイトを超えたら、起動を失敗させて理由をログに出す。

ランナーは起動時に次の順で進む。

1. データベースを開き、マイグレーションを当てる (「マイグレーション」)
2. ソケットのファイルがあれば接続を試す。つながったらほかのランナーが動いているので、起動を失敗させる。つながらなければファイルを消す
3. 前回の起動で残った Claude Code の子プロセスを止める (「ランナーの再起動」)
4. 会話の状態を直す (「ランナーの再起動」)
5. 目次などの更新に反映していない番が残る会話を探し、更新を積み直す (`features/recap.md`「番ごとの更新」)
6. ソケットで待ち受けを始め、利用枠切れのタイマーと自動フローを始める

2 つ目のランナーを起動させないのは、同じ会話を 2 つのプロセスで動かさないためである (DESIGN.md「既知の制約」)。

ランナーは、終了の合図 (SIGTERM) を受けると、次の順で 20 秒以内に終わる。止め方を決めておくのは、復元とランナーの入れ替え (`features/operations.md`) がこの終わり方を前提にするためである。

1. ソケットの新しい操作を受け付けず、利用枠切れのタイマーと自動フローを止める
2. 動いている AI をすべて止め (`interrupt`)、それまでに届いた出力を記録に保存する
3. 子プロセスが終わるのを待ち、データベースを閉じて終わる

- 止めたことで届く番の終わりは記録に書かず、止まった理由も判定しない。`run_state` も書き換えず、次の起動の「会話の状態を直す」が `stopped` (`restarted`) にする
- 20 秒で終わらないときは launchd が強制で止める。残った子プロセスは次の起動で止める

画面のサーバーは、起動時にデータベースを開いてマイグレーションを当て、API と `/ws` の待ち受けを始める。構成は FEASIBILITY.md「PoC 結果 > vite-plus-node-stack」の推奨アプローチに従う。

- `/ws` は、`ws` の `WebSocketServer({ noServer: true })` を包んだ upgrade の受け口を 1 つ作る。開発 (`vp dev`) では自作の Vite プラグインが `upgrade` でこれを呼び、本番では `serve()` の戻り値に同じ受け口を付ける
- データベースの接続、配信、ランナーとのつながりは、プロセスに 1 つのモジュール `src/server/runtime.ts` に置く。`vp dev` で HTTP ハンドラだけを再評価するときは、既存の接続を保つ。`src/server/runtime.ts` 自身か、同モジュールが import する依存を再評価するときは、開発サーバーを再起動する (DESIGN.md「既知の制約」)。

画面のサーバーは、ランナーのソケットに、つながるまで 1 秒ごとに接続を試す。

### 環境変数

ランナーに固有の変数の使い方を次に書く。変数の表は `features/operations.md`「環境変数」にある。

- `SUKUNA_AGENT=fake` のとき、ランナーは Agent SDK の代わりに偽物を使い、`SUKUNA_AGENT_SCRIPT` の台本を読む。台本の形は「偽物 (`ScriptedAgent`)」にある
- `SUKUNA_GH` があると、両方のプロセスは `gh` の実行器を偽物にし、そのファイルを台本として読む。台本の形は「`gh` の偽物」にある
- 環境変数の読み取りと起動を失敗させる検査は、両方のプロセスが `src/shared/env.ts` で行う

### 書くプロセスの分担

書き手は列ごとに決め、1 つの列は原則として 1 つのプロセスだけが書く。行の状態で書き手が替わる列は、表の行を分ける。

| テーブル・列 | 書くプロセス | 理由 |
| --- | --- | --- |
| `conversations` の行の作成、`session_id`、`cwd`、`worktree_id`、`run_state`、`stop_reason`、`resets_at`、`last_seq`、`last_activity_at`、`title` | ランナー | 会話を始められないときに行を残さない。状態は AI の出力から決まる。`cwd` と `worktree_id` は、worktree の削除のときだけ画面のサーバーも書く (表の下の、2 つのプロセスが書く列) |
| `conversations` の `recap_seq`、`recap_failed_at` | ランナー | 目次などの更新はランナーで動く (`features/recap.md`) |
| `toc_entries` の行の追加 (番ごとの更新) | ランナー | 目次などの更新が章を足す (`features/recap.md`) |
| `toc_entries` の `title`・`start_seq` の修正 | 画面のサーバー | 開発者が目次を直す (`features/recap.md`) |
| `conversations` の `last_read_seq`、`last_position`、`closed_at` | 画面のサーバー | 開発者の操作で決まる |
| `conversation_events` | ランナー | 記録の `seq` を 1 か所で振る |
| `queued_instructions` の追加 (`stock_item_id` を含む) と、届けたときの削除 | ランナー | 預けるか届けるかは、ランナーだけが知る AI の状態で決まる |
| `queued_instructions` の編集と取り消し | 画面のサーバー | 開発者の操作。届けた行は残っていないので、409 になる |
| `pending_answers` の保存 | 画面のサーバー | 開発者の操作 |
| `pending_answers` の削除、`questions` の `answered` | ランナー | 回答を送ったときに書く。待ちの消えた選択式の質問は、回答以外の指示 (`origin` が `answer_text` 以外) を届けて AI が次の応答を始めたときに書く (BR-090、`features/conversation.md`) |
| `drafts` と貼り付けた画像のファイル | 画面のサーバー | 画面から受け取る |
| `stock_items` の行の追加、`text`、`state` (`stocked` と `cancelled` の行き来、届く前の指示の取り消しで `sent` から `stocked`)、`github_comment_url` | 画面のサーバー | 開発者の操作 (`features/stock-thread.md`、`features/pr-review.md`) |
| `stock_items` の `state` (`stocked` から `sent`)、`sent_at`、`sent_seq`、`thread_conversation_id` (送ったとき) | ランナー | 送ると届けるは、ランナーが会話ごとに 1 列で行う (`features/stock-thread.md`) |
| `issues` と `issue_dependencies` の、下書きの行 | 画面のサーバー | 下書きは開発者だけが書く (`features/issue.md`) |
| `issues` と `issue_dependencies` の、下書きでない行。下書きから精査待ちへ移す書き込み。`issue_events` | ランナー (自動フロー) | DESIGN.md「横断規約 > 自動フローと既存のスキル」 |
| `settings` のキー `usage.rate_limit` | ランナー | AI の実行の知らせから決まる (`features/project-settings.md`) |
| `settings` のキー `runner-release:<会話の id>` | ランナー | 終了保存までの実行の予約 (`features/stock-thread.md`「終了の予約に使う内部の口」) |
| `settings` のキー `runner-workspace-switch:<要求の UUID>` | ランナー、画面のサーバー | ランナーが切り替え結果を、画面のサーバーが取消しを書く (`features/worktree-terminal.md` の作業場所の切り替え API) |
| `settings` のキー `backup_status` | ランナー | バックアップはランナーがとる (`features/operations.md`) |
| `settings` のキー `last_restore` と、復元のときの `flow_paused` | 復元の処理と、起動時の後始末 (`db.lock` の中) | 2 つのプロセスを止めてから書く (`features/operations.md`) |
| `settings` のほかのキー、`projects` | 画面のサーバー | 開発者の操作 |
| `worktrees` の行の作成 (`origin = user`) | 画面のサーバー | 開発者が作った worktree と、一覧でアプリの外で作ったと分かった worktree (`features/worktree-terminal.md`「書くプロセス」) |
| `worktrees` の行の作成 (`origin = flow`) | ランナー (自動フロー) | 自動フローが段階の worktree を作る (`features/worktree-terminal.md`「書くプロセス」) |
| `worktrees` の `removed_at` | 消したプロセス | 開発者が消すと画面のサーバー、自動フローが片付けるとランナーが書く (`features/worktree-terminal.md`「書くプロセス」) |
| `notifications`、`push_subscriptions` | 画面のサーバー | 通知と Web Push を出すのは画面のサーバーだけである (`features/inbox.md`) |
| 削除する会話とスレッドの、全テーブルの行 | 画面のサーバー | ランナーが実行を手放したあとに消す (`features/conversation-lifecycle.md`) |

2 つのプロセスが同じ列やキーを書けるのは、次の箇所だけである。既存の行を更新するときは、元の値を条件に付け、後から書いた方が前の変化を上書きしないようにする。

- `stock_items` の `state` と `thread_conversation_id` (`features/stock-thread.md`)
- 下書きから精査待ちへ移す `issues` (`features/issue.md`)
- `toc_entries` の `title` と `start_seq`。ランナーが行を足し、画面のサーバーが開発者の修正を書く (`features/recap.md`)
- `conversations` の `cwd` と `worktree_id`。worktree の削除では、画面のサーバーが `cwd` が消した worktree のパスのときだけ書く。merge のあとの直しなど、自動フローが worktree を用意したときと、開発者が作業場所を切り替えたときはランナーが書く。切り替えでは、読んだときの `cwd` を条件に付ける (`features/worktree-terminal.md`、`features/implementation-flow.md`)
- `settings` の `runner-workspace-switch:` で始まるキー。ランナーは確定結果を、画面のサーバーは未確定の要求の取消しを書く。どちらも SQLite の書き込みロック内で同じ要求の行が無いことを確かめてから追加する。この名前で始まる期限切れの行だけを掃除する
- `worktrees` の `removed_at`。どちらのプロセスも、`removed_at` が空のときだけ書く (`features/worktree-terminal.md`「書くプロセス」)

貼り付けた画像は、画面のサーバーが `$SUKUNA_HOME/images/<conversation_id>/<ID>.<拡張子>` に書き、記録には `SUKUNA_HOME` からの相対のパスで残す。ランナーは、指示を送るときにこのファイルを読む。

- `<ID>` は画像の識別子 (ULID) で、`drafts.images` と `queued_instructions.images` に入る値である
- 拡張子は、保存するときの形式 (`image/png` なら `png`、`image/jpeg` なら `jpg`、`image/gif` なら `gif`、`image/webp` なら `webp`) から決める
- 識別子からファイルを引くときは、`images/<conversation_id>/` の中で `<ID>.` で始まるファイルを探す。無ければ、画像が見つからないとして扱う (`features/conversation.md`)

この表に無いテーブルと列の書き手は、そのテーブルを持つ機能設計書が決める。ストックとスレッドは `features/stock-thread.md`、目次と質問の一覧と決まったことのファイルは `features/recap.md` の「書く列の分担」の表にある。2 つのプロセスが書くテーブルは、SQLite の WAL と書き込みのロックで直列にする (「マイグレーション」の接続の設定)。

### 画面のサーバーからランナーへの操作

ソケットの上の HTTP で送る。入出力は JSON で、形は `src/shared/ipc.ts` の Zod のスキーマが正本である。API の名前空間 (`/api`) とは別の内部の口で、ブラウザからは呼べない。

| メソッド | パス | 用途 | 主な入力 | 主な出力 |
| --- | --- | --- | --- | --- |
| POST | `/conversations` | 会話を始める | `project_id`、`kind`、`cwd`、`worktree_id?`、`issue_id?`、`parent_conversation_id?`、`title`、`message?` | `conversation_id` |
| POST | `/conversations/:id/messages` | 指示を送る | `text`、`images`、`interrupt`、`client_id`、`origin` | `result` (`delivered` / `queued`)、`queued_id?`、`seq?` |
| POST | `/conversations/:id/queue/deliver` | 残った届く前の指示をいま届ける (BR-088) | なし | `seq` |
| POST | `/conversations/:id/stop` | AI を止める | なし | `run_state` |
| POST | `/conversations/:id/resume` | 止まった作業を再開する | なし | `seq` |
| POST | `/conversations/:id/fork` | 分岐して新しい会話を作る (スレッド) | `title`、`kind` | `conversation_id` |
| POST | `/conversations/:id/answers` | 選択式の質問に答える | `request_id`、`answers` (`pending_answers.answers` と同じ形) | `result` (`answered` / `delivered` / `queued`)、`seq?` |
| POST | `/conversations/:id/permissions/:requestId` | 許可の確認に答える | `behavior` (`allow` / `deny`)、`message?` | `seq` |
| GET | `/conversations/:id/commands` | スキルとスラッシュコマンドの候補 | なし | `commands` (`name`、`description`) |
| POST | `/conversations/:id/workspace` | 開発者が始めた会話の作業ディレクトリを切り替える。開いている実行を閉じる (`features/worktree-terminal.md`「作業場所の切り替え」) | `cwd`、`worktree_id?`、`attempt?` (要求 ID と有効期限) | `cwd` |
| POST | `/conversations/:id/release` | 実行を片付けて手放す (閉じる・削除の前)。利用枠の戻りを待つタイマーも外す | なし | `run_state` |
| POST | `/conversations/:id/release/reserve` | スレッドの終了保存まで操作を予約する (`features/stock-thread.md`「終了の予約に使う内部の口」) | なし | `token` |
| POST | `/conversations/:id/release/complete` | 終了の予約を解除する (同上) | `token` | なし |
| POST | `/conversations/:id/stock/send` | ストックを送る (`features/stock-thread.md`) | `kinds` | stock-thread.md の `POST /api/conversations/:id/stock/send` の 200 と同じ |
| POST | `/conversations/:id/recap/rebuild` | 反映していない番から目次などの更新をやり直す (`features/recap.md`) | なし | `state` |
| POST | `/flow/issues/:id/confirm` | 下書きを確定する (`features/issue.md`) | なし | `issue` |
| POST | `/flow/issues/:id/withdraw` | 取り下げる (`features/issue.md`) | なし | `issue`、`stopped_dependents` |
| POST | `/flow/issues/:id/reopen` | 再開する (`features/issue.md`) | なし | `issue` |
| PATCH | `/flow/issues/:id` | 確定した issue の親・依存・優先度・merge 前の確認を直す (`features/issue.md`) | `parent_number?`、`depends_on?`、`priority?`、`confirm_before_merge?` | `issue` |
| POST | `/flow/issues/:id/design/approve` | 設計を承認し、反映を始める (`features/design-review.md`) | `head_commit` | `status` |
| POST | `/flow/issues/:id/design/reject` | メニューから設計を差し戻す (`features/design-review.md`) | `text` | `delivered_stock_ids` |
| POST | `/flow/issues/:id/pr/allow-merge` | merge を許可し、実装の会話に merge の指示を届ける (`features/pr-review.md`) | `head_sha` | `state` |
| POST | `/flow/projects/:id/stop` | プロジェクトの解除の前に、そのプロジェクトの会話を止める (`features/project-settings.md`「解除」) | なし | `stopped_conversation_ids` |
| POST | `/flow/notify` | issue の項目、プロジェクトの設定、一時停止が変わったことと、PR が GitHub で merge されたのを見たことを自動フローに知らせる | `project_id?`、`issue_id?` | なし |
| GET | `/health` | 生きているかと版 | なし | `pid`、`started_at`、`version` |
| GET | `/changes` | ランナーからの変化の知らせを受け続ける | なし | 改行区切りの JSON の流れ |

- 状態が合わない操作は 409 (`conflict`) を返す。例: 作業中でない会話の停止、再開できない状態の会話の再開、待っていない許可の確認への答え
- 再開できるのは、`stopped` (`restarted`)・`failed`・`usage_limited` の会話だけである (`features/conversation.md`)
- issue のいまの段階の担当でない会話への、指示を送る・再開・ストックの送信は、409 (`conflict`) を返す。`message` は「この issue はいま <段階> の会話で進んでいます」とする (`features/conversation.md`「指示を届ける規則」)
- issue が停止中 (`failed`、`cause` が `worktree_failed`) の段階の会話への指示と再開は、届ける前に `flow` の `retryStageWorktree` に回す (`features/issue-flow.md`「停止中から戻る」)。作り直しに失敗したときは、指示を届けず、記録も書かずに 500 `worktree_failed` を返す
- `/flow/notify` は、画面のサーバーが issue の項目、プロジェクトの設定、一時停止を書いたあとに送る。全体の一時停止のように対象のプロジェクトが無いときは、どちらの id も付けない
- PR の取得で GitHub で merge されたのを見たときも、画面のサーバーは `/flow/notify` を `issue_id` 付きで送る (`features/pr-review.md`「取得と最後に取得した内容」)
- ランナーにつながらない、10 秒以内に応答がない、または知らせの流れが切れた場合、画面のサーバーは API に 503 (`runner_unavailable`) を返す。`message` は「AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。」とする。作業場所の切り替えは共有 SQLite で確定を確認し、`features/worktree-terminal.md` の PUT の規則に従って応答する
- 手動の再開と作業場所の切り替えを確定する前に、IPC の切断と期限を確認する。画面のサーバーは、10 秒後の時刻を Unix ミリ秒で `x-sukuna-ipc-deadline` に渡す
- 質問と許可の確認の `request_id` は、ランナーが `question` / `permission_request` の記録の `payload` に入れる。画面のサーバーは、`pending_answers.question_seq` の記録から `request_id` を引いて回答の操作に渡す
- 回答の操作の `result` は、質問を待っている会話に答えを返したとき `answered` とする。待ちの消えた質問の回答を指示の文にして送ったときは、指示を送る操作と同じく `delivered` か `queued` とする。`seq` は、記録を書いたときだけ返す
- `/flow/projects/:id/stop` は、作業中と回答待ち・許可待ちの会話を止める。作業中でない `usage_limited` と `stopped` (`restarted`) の会話も、`stopped` (`user`) にし、利用枠の戻りを待つタイマーを外す
- `client_id` は、画面が送信ごとに作る ULID である (API の `clientMessageId`)。二重の送信の判定は、ランナーのこの操作の 1 か所だけで行う
- 同じ会話で、同じ `client_id` が 10 分以内に届いていたら、ランナーは何もせずに前の結果を返す。届いていたかは、届く前の指示の `client_id` と、記録の `user_message` の `client_receipts` で調べる
- 預けた指示は、`client_id` を `queued_instructions.client_id` に持つ。まとめて届けるときは、`user_message.client_receipts` に各指示の `client_id`、受付時刻、初回の結果を対応付けて残す。預けた指示には元の `queued_id` も保存する。番号のない指示は本文に含め、対応付けには含めない。`client_ids` と `queued_ids` は、まとめた指示の番号の一覧として残す
- 自動フローは同じランナーの中で動くので、これらの操作をソケットを通さずに直接呼ぶ
- 会話のモジュールは、自動フローだけが呼ぶ口として、段階の会話に止まった記録を書く操作を持つ。`stopped` の記録と `run_state` を 1 つのトランザクションで書く
- 段階の worktree を作れなかったとき、`flow` はこの口で `stopped` (`reason` は `error`) を書き、会話を `failed` にする。`detail` には worktree を作れなかったことを書く (`features/issue-flow.md`)
- `failed` は再開の操作を受け付ける状態なので、会話の末尾に「再開する」が出る (`features/conversation.md`「状態と止まった理由」)
- ほかの機能が操作を足すときは、その機能設計書に書き、`src/shared/ipc.ts` に足す

指示を送る操作の動きは、会話の状態で決まる。

| 会話の状態 | `interrupt` | 動き |
| --- | --- | --- |
| `idle` / `stopped` / `failed` / `usage_limited` | どちらでも | 残っている届く前の指示を書いた順に並べ、最後に新しい指示を付けて、すぐに 1 通で届ける。止まっていた会話はこの指示で再開する |
| `working` / `waiting_answer` / `waiting_permission` | `false` | `queued_instructions` に預ける |
| `working` / `waiting_answer` / `waiting_permission` | `true` | AI を止め、届く前の指示を書いた順に並べ、最後に新しい指示を付けて 1 通で届ける |

1 通にまとめるときは、各指示の本文を空行 1 つで区切ってつなぐ。画像は、まとめた指示の画像を書いた順に並べる。

質問か許可の確認を保留しているあいだに割り込みか停止が来たら、保留を拒否で解いてから AI を止める。拒否の理由は「開発者が割り込んだ」とする (`features/conversation.md`)。

`origin` は発言の出どころで、記録の `user_message` に残す。値は「会話の記録の種類」の表にある。

### ランナーからの知らせ

`GET /changes` の応答は終わらない流れで、1 行に 1 件の JSON を書く。中身は「どれが変わったか」だけで、画面のサーバーは中身を SQLite から読む。

```ts
type RunnerNotice =
  | { kind: "conversation"; conversation_id: string; seq: number; run_state: RunState; project_id: string; issue_id: string | null }
  | { kind: "delta"; conversation_id: string; text: string }
  | { kind: "conversation_parts"; conversation_id: string; parts: ("queue" | "answers" | "recap" | "stock" | "threads")[] }
  | { kind: "issue"; issue_id: string; project_id: string; seq: number }
  | { kind: "project"; project_id: string }
  | { kind: "notice"; level: "info" | "error"; message: string; conversation_id?: string; issue_id?: string };
```

- `conversation` は、記録を保存するたびに出す。`seq` はその会話の `last_seq` である
- `delta` は、AI の発言の書きかけの文字である。保存しない。会話ごとに 100 ミリ秒の間の分をまとめて 1 件にする
- `delta` を出すのは、サブエージェントでない AI の発言 (`parent_tool_use_id` が無いもの) だけにする。1 つの会話で同時に書きかけになる発言は 1 つである
- `conversation_parts` は、記録以外のものが変わったときに出す (届く前の指示、送る前の回答、目次など、ストック、スレッド)
- 目次などの更新が済んだときと失敗したときも、`conversation_parts` (`recap`) を出す。一覧は、これを受けて番の終わりの待ちを解く (`features/inbox.md`)
- `issue` は、`issue_events` に記録を足したときに出す (状態の移り変わり、`worktree_kept` など)。`seq` は `issue_events.seq` である
- `notice` は、画面へ出すお知らせである。例: 利用枠切れで止まった、自動で再開した
- 知らせには番号を振らない。画面のサーバーは、つなぎ直したときに、購読中の対象を SQLite から読み直す (「配信」)。知らせが欠けても記録は欠けない

### 会話の記録の種類

`conversation_events` の 1 行が 1 件である。列の定義は DESIGN.md「データスキーマ」参照。`seq` は会話の中で 1 から 1 ずつ増え、`created_at` はランナーの時計で付ける。`payload` の形は `src/shared/events.ts` の Zod のスキーマが正本である。

| `type` | いつ書くか | 主な `payload` |
| --- | --- | --- |
| `user_message` | ランナーが AI に指示を送る直前 | `text`、`images`、`origin`、`client_ids?`、`queued_ids?`、`client_receipts?` |
| `assistant_text` | AI の発言が 1 つ終わったとき | `text`、`parent_tool_use_id` |
| `tool_use` | AI がツールを呼んだとき | `tool_use_id`、`name`、`input`、`parent_tool_use_id` |
| `tool_result` | ツールの結果が届いたとき | `tool_use_id`、`is_error`、`content`、`truncated`、`bytes` |
| `diff` | ファイルの編集の結果が届いたとき (`tool_result` の直後) | `tool_use_id`、`path`、`change` (`edit` / `create` / `update`)、`hunks`、`content?`、`truncated` |
| `question` | AI が選択式の質問を出したとき | `request_id`、`questions` |
| `answer` | 開発者の回答を AI に渡したとき | `request_id`、`answers`、`as_message` |
| `permission_request` | AI がツールの実行の許可を求めたとき | `request_id`、`tool_name`、`input`、`title?`、`reason?`、`blocked_path?` |
| `permission_decision` | 開発者が許可か拒否をしたとき | `request_id`、`behavior`、`message?` |
| `turn_end` | AI の番が終わったとき | `subtype`、`usage`、`cost_usd`、`duration_ms`、`permission_denials`、`terminal_reason?` |
| `stopped` | 作業が止まったとき | `reason`、`detail?`、`resets_at?` |
| `resumed` | 止まった作業を再開したとき | `by` (`developer` / `usage_limit` / `flow`) |

```ts
type UserMessage = {
  text: string;
  images: { path: string; media_type: string }[]; // path は SUKUNA_HOME からの相対
  origin: "developer" | "queued" | "interrupt" | "stock" | "resume" | "flow" | "answer_text" | "finish_proposal";
  client_receipts?: ({ client_id: string; received_at: number } & ({ result: "queued"; queued_id: string } | { result: "delivered" }))[];
  client_ids?: string[]; // 1 通にまとめた指示の client_id (届く前の指示の分を含む)
  queued_ids?: string[]; // まとめて届けた届く前の指示の id
};
type Diff = {
  tool_use_id: string;
  path: string;
  change: "edit" | "create" | "update";
  hunks: { old_start: number; old_lines: number; new_start: number; new_lines: number; lines: string[] }[]; // lines は "+" / "-" / " " で始まる
  content?: string; // change が create のときのファイルの全体
  truncated: boolean;
};
type TurnEnd = {
  subtype: string;
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }; // SDK の result の usage
  cost_usd: number; // SDK の result の total_cost_usd
  duration_ms: number;
  permission_denials: number;
  terminal_reason?: string;
};
type Question = {
  request_id: string;
  questions: { question: string; header: string; options: { label: string; description: string }[]; multi_select: boolean }[];
};
type Stopped = {
  reason: "user" | "restarted" | "api_error" | "error" | "credits_required" | "usage_limit"; // conversations.stop_reason と同じ値
  detail?: string; // 開発者に見せる文
  resets_at?: number; // Unix ミリ秒。usage_limit のときだけ
  previous_run_state?: RunState; // restarted のときだけ。再起動の前の run_state
};
```

`origin` の値の意味は次のとおりである。

| `origin` | 出どころ |
| --- | --- |
| `developer` | 開発者が入力欄で書いて送った。開発者が書いた文にアプリが前置きを付けて送った指示も含む (メニューからの設計の差し戻し、merge のあとの直し。`features/design-review.md`、`features/pr-review.md`)。会話には、前置きも含めて開発者の発言として出す |
| `queued` | 届く前の指示を、番の終わりにまとめて届けた |
| `interrupt` | 割り込みで、届く前の指示と新しい指示をまとめて届けた |
| `stock` | ストックの指示を送った (`features/stock-thread.md`) |
| `resume` | 再開の操作で、アプリが決まった文を送った |
| `flow` | 開発者が文を書かずに、自動フローが文を作って送った。段階の最初の指示、報告の催促、依存先の取り下げが解けたときの続きの指示、再起動のあとの続きの指示、設計書の PR の merge を頼む指示 (`features/issue-flow.md`)、merge の許可の指示 (`features/pr-review.md`)、worktree を作り直したときの最初の指示 (`features/issue-flow.md`「停止中から戻る」)。会話には「自動フローが指示を送りました」の区切りの行で出す |
| `answer_text` | 停止か再起動で待ちが消えた質問への回答を、指示として送った |
| `finish_proposal` | スレッドを終えるときに、確定事項の案を求める決まった文を送った (`features/stock-thread.md`) |

### Agent SDK のメッセージからの写し方

SDK のメッセージは、まず Port の出力 (「Agent SDK を包む Port」の `AgentOutput`) に写し、次に記録に写す。2 段に分けるのは、偽物が SDK の形を作らずに済み、写し方を SDK の見本で単体テストできるためである。

| SDK のメッセージ | `AgentOutput` | 記録 |
| --- | --- | --- |
| `system` の `init` | `init` (スキルとコマンドの一覧、`session_id`) | 書かない。一覧はランナーが会話ごとに覚える |
| `stream_event` の `content_block_delta` の `text_delta` | `text_delta` | 書かない。サブエージェントでなければ知らせの `delta` にする |
| `assistant` の `content` の `text` | `assistant_text` | `assistant_text` |
| `assistant` の `content` の `tool_use` | `tool_use` | `tool_use` |
| `user` の `content` の `tool_result` | `tool_result` | `tool_result` |
| `user` の `tool_use_result` の `structuredPatch` (Edit、Write の `update`) | `tool_result` の `diff` | `diff` (`hunks`) |
| `user` の `tool_use_result` の `type: "create"` (Write) | `tool_result` の `diff` | `diff` (`content`) |
| `result` | `turn_end` (`usage` と `total_cost_usd` を写す) | `turn_end` (`usage`、`cost_usd`)。止まった理由があれば続けて `stopped` |
| `assistant` の `error` | `assistant_error` | 書かない。番の終わりの理由の判定に使う |
| `rate_limit_event` | `rate_limit` | 書かない。会話ごとに最後の 1 件を覚え、受け取ったままの形をログに出す。`settings` の `usage.rate_limit` に保存する (形は `features/project-settings.md`「利用量」) |
| `system` の `task_started`、`background_tasks_changed` | `background_task` | 書かない。止めるときに使う |
| `canUseTool` の `AskUserQuestion` | Port の `onQuestion` | `question` |
| `canUseTool` のほかのツール | Port の `onPermission` | `permission_request` |
| 上のどれでもない `type` | 出さない | 書かない |

- SDK のメッセージの流れには、開発者の指示は出てこない。ランナーは指示を送る直前に `user_message` を自分で書く
- `sdk_uuid` は SDK の `uuid` に、ブロックの種類と 0 始まりの番号を付けて作る (例: `<uuid>:text:0`)。1 件の SDK メッセージに複数のブロックが入るためである。同じ識別子の 2 件目は書かない。差分は、ツールの結果の識別子に `:diff` を付ける
- `parent_tool_use_id` がある発言とツールは、サブエージェントのものである。同じ種類で保存し、`parent_tool_use_id` で親のツールの実行に結びつける
- `tool_result` の `content` は、文字に直して 64 KiB までを保存する。超えた分は切り、`truncated: true` と元の `bytes` を入れる
- `diff` の `hunks` は合わせて 5,000 行までを保存する。`create` の `content` も 5,000 行までとする。超えた分は切り、`truncated: true` を入れる
- `tool_use` の `input` は、文字の値ごとに 16 KiB までとし、超えた分は切る
- `turn_end` の `usage` と `cost_usd` は、SDK の値をそのまま写す。1 回の番の値か累計かの扱いは `features/project-settings.md`「利用量」が決める

番の終わりの理由は、次の順に判定して `stopped` を書く。利用枠の判定は FEASIBILITY.md「PoC 結果 > usage-limit-detect」の推奨アプローチに従う。

| 条件 | `stopped.reason` | `run_state` |
| --- | --- | --- |
| 開発者の停止の操作のあとの `result` | `user` | `stopped` |
| 割り込みのあとの `result` | 書かない (`turn_end` だけを書く) | 続けて書く `user_message` で `working` |
| 最後の `rate_limit` が `status: "rejected"` で、`overageStatus` が `allowed` / `allowed_warning` でなく、`errorCode` が `credits_required` | `credits_required` | `failed` |
| 最後の `rate_limit` が `status: "rejected"` で、`overageStatus` が `allowed` / `allowed_warning` でない | `usage_limit` (`resets_at` は `resetsAt` の 1000 倍) | `usage_limited` |
| `result` の `terminal_reason` が `api_error`、または `assistant_error` が `overloaded` / `server_error` などの API の失敗 | `api_error` | `failed` |
| `result` の `subtype` がほかの `error_*` | `error` | `failed` |
| `result` の `subtype` が `success` | 書かない | `idle` |
| ランナーの再起動で止めた (「ランナーの再起動」) | `restarted` | `stopped` |

`stopped.reason` と `run_state` の組は、`features/conversation.md`「状態と止まった理由」の表と同じである。

割り込みで止めた番は、止まったとは扱わない。`stopped` の記録も、ランナーの中の合図 `stopped` も出さず、届く前の指示と新しい指示をまとめた `user_message` をすぐに書く。

`assistant` の `error` が `rate_limit` であることだけでは、利用枠切れと判定しない (DESIGN.md「既知の制約」)。

### 会話の状態の移り変わり

`run_state` は、記録を保存するのと同じトランザクションで更新する (DESIGN.md「トランザクション境界」)。

| きっかけの記録 | 移った先 |
| --- | --- |
| `user_message` | `working` |
| `question` | `waiting_answer` |
| `permission_request` | `waiting_permission` |
| `answer`、`permission_decision`、`resumed` | `working` |
| `turn_end` (`success`) | `idle` |
| `stopped` | 上の表の `run_state` |

- `stop_reason` と `resets_at` は `stopped` を書くときに入れ、次の `user_message` か `resumed` で空にする
- `last_activity_at` は、すべての記録の保存で、その記録の `created_at` にする

### ランナーの中の合図

ランナーの中のほかのモジュールは、ソケットを通さずに、会話のモジュールが出す合図を受ける。

| 合図 | 出すとき | 主な受け手 |
| --- | --- | --- |
| `turnEnded` (`conversation_id`、番の最初と最後の `seq`、`subtype`) | `turn_end` を保存したあと | `features/recap.md` (目次などの更新)、`features/issue-flow.md` |
| `runStateChanged` (`conversation_id`、前と後の `run_state`) | `run_state` が変わったあと | `features/issue-flow.md` |
| `stopped` (`conversation_id`、`reason`、`previous_run_state?`) | `stopped` を保存したあと | `features/issue-flow.md` |
| `inputRecorded` (`conversation_id`、記録の `seq` と `type`) | `origin` が `developer`・`stock`・`queued`・`interrupt`・`answer_text` の `user_message` か、`answer` か、`resumed` を保存したあと | `features/issue-flow.md` (停止中から戻す) |

合図の受け手が失敗しても、記録の保存は取り消さない。失敗はログに出す。

### 届く前の指示と番の終わり

- 番が `success` で終わったとき、`queued_instructions` に行があれば、`position` の順に 1 通にまとめて届ける
- 画像を準備したあと、配達を確定するトランザクションの中で、控えた指示の ID・本文・画像 ID・順序・受付情報・相談コメント・ストック参照を照合する。一致したときだけ実行を開き、指示の削除と `user_message` の追加、`stock_items.sent_seq` の更新を行う。変わっていれば確定せずにトランザクションを抜け、現在の作業場所と最新の指示・画像でやり直す (DESIGN.md「トランザクション境界」)
- 番が `stopped` で終わったときは届けない (BR-088)。開発者が `queue/deliver` か、指示の送信で届ける
- SDK の `priority` は使わない。届けるのは番の終わりを受けてからだけにする (FEASIBILITY.md「PoC 結果 > agent-sdk-interrupt」)

### 配信 (`/ws`)

画面のサーバーは、ランナーの知らせと自分の書き込みを受けて、購読している接続へ配信する。1 件の形と本人の判定は DESIGN.md「横断規約 > 配信」参照。メッセージの形は `src/shared/ws.ts` の Zod のスキーマが正本である。

画面から送るメッセージは次の 4 つである。

```ts
type ClientMessage =
  | { op: "subscribe"; topic: string; after?: number } // after は最後に受け取った seq
  | { op: "unsubscribe"; topic: string }
  | { op: "shown"; topics: string[] } // 主のウィンドウか右のウィンドウに出している対象の topic をすべて
  | { op: "visibility"; visible: boolean }; // ページが見えているか (document.visibilityState)
```

`topic` の一覧と、つなぎ直したときの扱いは次のとおりである。

| `topic` | 配信する `type` | `seq` の意味 | つなぎ直したとき |
| --- | --- | --- | --- |
| `inbox` | `changed` (`conversation_ids`、`issue_ids`、`project_ids`) | 画面のサーバーの中の通し番号 | 画面が API で読み直す |
| `conversation:<id>` | `event` (記録の 1 行)、`delta`、`state` (`run_state`、`stop_reason`、`resets_at`)、`changed` (`parts`)、`resync` (`last_seq`) | `event` は記録の `seq`。ほかはその時点の `last_seq` | `after` より後の `event` を順に再送する。`state` と `changed` の分は画面が API で読み直す |
| `issue:<id>` | `event` (`issue_events` の 1 行)、`changed` | `event` は `issue_events.seq` | `after` より後の `event` を再送する。ほかは画面が API で読み直す |
| `app` | `notice` (お知らせ)、`runner` (`connected`)、`settings_changed`、`ping` (死活確認) | 画面のサーバーの中の通し番号 | 画面が API で読み直す |

`conversation:<id>` の `changed` の `parts` は、次の値の配列である。

| `parts` の値 | 変わったもの | 出すプロセス |
| --- | --- | --- |
| `queue` | 届く前の指示 | ランナー、画面のサーバー (編集と取り消し) |
| `answers` | 送る前の回答 | ランナー、画面のサーバー (保存) |
| `draft` | 書きかけの入力 (`features/conversation.md`) | 画面のサーバー |
| `recap` | 直近・目次・決まったこと・質問の一覧 (`features/recap.md`) | ランナー、画面のサーバー (手で直したとき) |
| `stock` / `threads` | ストック、スレッド (`features/stock-thread.md`) | ランナー、画面のサーバー |
| `timeline` | タイムラインのファイル (`features/work-monitor.md`) | 画面のサーバー |

`app` の `notice` の `payload` は次の形である。

```ts
type AppNotice = {
  level: "info" | "error";
  message: string;
  conversation_id?: string;
  issue_id?: string;
  notification?: { tag: string; url: string }; // 通知と同じ中身のお知らせのとき (features/inbox.md)
};
```

- 一覧、ツリー、プロジェクトの画面は `inbox` を購読する。`changed` を受けたら、表示している一覧を API で読み直す
- 画面のサーバーは、ランナーの `conversation`・`conversation_parts`・`issue`・`project` の知らせを受けるたびに、`inbox` へ `changed` を出す。`run_state` が変わらない記録の保存でも出す。作業中の行の「最後にしたこと」が変わるためである (`features/work-monitor.md`)
- 画面のサーバーが自分で一覧の行を変える書き込み (既読の位置、閉じる・開き直す・削除、プロジェクトの設定) をしたときも、`inbox` へ `changed` を出す。プロジェクトの設定を書いたときは `project_ids` を付ける
- 再送は 1 回の購読で 1,000 件までとする。超えるときは再送せずに `resync` (`last_seq`) を送り、画面は API で記録を読み直す
- 画面は `event` の `seq` が飛んだら (受け取った最大の `seq` + 1 でない)、間の分を API で読み直す
- 画面は `delta` の文字を、会話の末尾の書きかけの発言として逐次出す (`features/buffer-ui.md`「末尾の区画」)
- `delta` は再送しない。画面は、その会話の次の `assistant_text` か `turn_end` の `event` が届いたら、書きかけの表示を消す
- 購読を受けたら、画面のサーバーは対象を開ける権限を確かめない (使うのは本人 1 人)。存在しない対象の購読は、何も配信しない
- 画面のサーバーは 20 秒ごとに `{ topic: "app", seq: <通し番号>, type: "ping", payload: {} }` を全接続へ送る。購読が無い接続にも送る。`seq` はほかの `app` の配信と同じ通し番号を使う。画面は受信時刻だけを更新し、通知の表示・API の読み直し・保存は行わない。最後の受信から 45 秒何も届かなければ接続を閉じてつなぎ直す
- 送り待ちが 8 MiB を超えた接続は、画面のサーバーが閉じる。画面はつなぎ直し、続きから受け取る
- 画面のつなぎ直しの間隔は、0.5 秒から倍にして 8 秒までとし、つながったら 0.5 秒に戻す
- 切れてから 3 秒つながらないとき、画面はつながらないことを表示する (表示は DESIGN.md「アプリシェル」)

ランナーとのつながりが切れていたあいだの分は、つなぎ直したときに、画面のサーバーが購読中の `conversation:<id>` と `issue:<id>` を SQLite から読み、最後に配信した `seq` の続きを配信する。`inbox` には `changed` を、`app` には `runner` を送る。

#### いま見ているもの

画面は、次の対象を開いているあいだだけ、その `topic` を購読する。

- 主のウィンドウか右のウィンドウに出している会話・スレッド・issue (`conversation:<id>`、`issue:<id>`)。右のウィンドウのスレッドとタイムラインを含む (`features/stock-thread.md`、`features/work-monitor.md`)
- ファイルの表示を開いている会話と、そのスレッド (`features/files.md`)

画面は、購読のうち主のウィンドウか右のウィンドウに出しているものの `topic` を、出すものが変わるたびに `shown` で送る。つなぎ直したときも、購読と一緒に送り直す。ファイルの表示のためだけの購読は `shown` に入れない。

画面のサーバーは、`visibility` が `true` の接続が `shown` で送った `conversation:<id>` と `issue:<id>` を「いま見ているもの」とする。`features/inbox.md` は、通知を出さない判定 (BR-086) にこれを使う。

### Agent SDK を包む Port

AI の実行は `AgentPort` で受け、組み立ての場所で実物か偽物を渡す。実物は、FEASIBILITY.md「PoC 結果」の 4 項 (`agent-sdk-conversation`、`agent-sdk-resume`、`agent-sdk-interrupt`、`agent-sdk-thread`) の推奨アプローチに従う。

```ts
interface AgentPort {
  open(params: OpenParams): AgentSession; // 新しい会話も再開も open で行う
  fork(sessionId: string, opts: { dir: string }): Promise<Result<{ sessionId: string }, AgentError>>;
  complete(params: CompleteParams): Promise<Result<{ text: string; inputTokens: number; outputTokens: number }, AgentError>>; // ツールを持たない 1 回きりの呼び出し
}
type CompleteParams = { model: "haiku"; system: string; prompt: string; title: string; purpose: string; signal?: AbortSignal };
type OpenParams = {
  sessionId: string; // 新しい会話はランナーが作った UUID、再開は保存した session_id
  resume: boolean;
  cwd: string;
  model: "opus" | "sonnet" | "haiku" | null; // projects.model。null は Claude Code の既定
  permissionMode: "bypassPermissions" | "default" | "acceptEdits" | "plan";
  appendSystemPrompt: string; // 追加の指示 (features/conversation.md「AI の実行の設定」)
  additionalDirectories?: string[];
  appTools: AppTool[];
  context: { conversationId: string; projectId: string; issueId: string | null };
  onQuestion(req: QuestionRequest): Promise<Record<string, string>>; // 回答がそろうまで保留する
  onPermission(req: PermissionRequest): Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }>;
};
interface AgentSession {
  readonly output: AsyncIterable<AgentOutput>;
  send(msg: { text: string; images: { data: Buffer; mediaType: string }[] }): void;
  interrupt(): Promise<void>; // 前景のツールを止め、番を終わらせる。バックグラウンドのタスクも止める
  commands(): Promise<{ name: string; description: string }[]>;
  close(): void;
}
type AgentOutput =
  | { kind: "init"; sessionId: string; commands: { name: string; description: string }[] }
  | { kind: "text_delta"; text: string; parentToolUseId: string | null }
  | { kind: "assistant_text"; uuid: string; text: string; parentToolUseId: string | null }
  | { kind: "tool_use"; uuid: string; toolUseId: string; name: string; input: unknown; parentToolUseId: string | null }
  | { kind: "tool_result"; uuid: string; toolUseId: string; isError: boolean; content: string; diff: DiffOutput | null; parentToolUseId: string | null }
  | { kind: "assistant_error"; error: string }
  | { kind: "rate_limit"; status: "allowed" | "allowed_warning" | "rejected"; resetsAt: number | null; overageStatus: string | null; errorCode: string | null; raw: unknown }
  | { kind: "background_task"; taskId: string; running: boolean }
  | { kind: "turn_end"; subtype: string; usage: TokenUsage; costUsd: number; durationMs: number; permissionDenials: number; terminalReason: string | null }; // costUsd は total_cost_usd
type TokenUsage = { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number };
```

実物 (`ClaudeAgentSdk`) の決まりは次のとおりである。

| 操作 | SDK での作り |
| --- | --- |
| 会話の開始 | `query({ prompt: <非同期の入力の流れ>, options })` で開く。`options.sessionId` に UUID を渡す。`conversations.session_id` は `init` を受けるまで空にし、受け取った識別子を保存する。`init` より前に失敗した実行は、新しい会話として開き直す |
| 再開 | `options.resume` に保存した `session_id`、`cwd` に `conversations.cwd` を渡す。許可の設定・アプリのツールは毎回同じものを渡す |
| 共通の `options` | `cwd`、`model` (`null` なら渡さない)、`permissionMode` (既定は `bypassPermissions` と `allowDangerouslySkipPermissions: true`)、`includePartialMessages: true`、`canUseTool`、`mcpServers`。`settingSources` は渡さない (端末と同じ設定を読む) |
| 追加のディレクトリ | `OpenParams.additionalDirectories` があれば `options.additionalDirectories` に渡す。渡す条件は `features/recap.md`「会話の AI が一覧を読む」に従う |
| 追加の指示 | `systemPrompt: { type: "preset", preset: "claude_code", append: <appendSystemPrompt> }` で、Claude Code のシステムプロンプトの末尾に足す。再開のたびに同じ文を渡す |
| 指示の送信 | `{ type: "user", message: { role: "user", content }, parent_tool_use_id: null, origin: { kind: "human" } }` を入力の流れへ足す。画像は base64 の `image` ブロックにする |
| 停止 | `Query.interrupt()` を呼ぶ。続けて、動いているバックグラウンドのタスクごとに `stopTask(taskId)` を呼ぶ |
| 分岐 | `forkSession(元の session_id, { dir: 元の cwd })`。元の会話の履歴が成立していなければ 409 にする。返った ID は成立済みとしてスレッドの会話の行に保存し、最初の指示から `resume` で送る |
| 質問への回答 | `canUseTool` の `AskUserQuestion` を `onQuestion` が返すまで保留し、`{ behavior: "allow", updatedInput: { questions, answers } }` を返す |
| 許可の確認 | `AskUserQuestion` 以外の `canUseTool` は、許可の扱いに関係なく `onPermission` に回し、開発者に確かめる |
| 候補の一覧 | 実行中なら `supportedCommands()`。実行が無ければ、同じプロジェクトで最後に受けた `init` の一覧を返す |
| 1 回きりの呼び出し | `query` を `tools: []`、`settingSources: []`、`persistSession: false`、`maxTurns: 1`、`effort: "low"` と `title` を付けて呼び、最後の発言の文字を返す (FEASIBILITY.md「PoC 結果 > summary-ai-cost」)。目次などの更新 (`features/recap.md`) が使う |
| 1 回きりの呼び出しの中断 | `CompleteParams.signal` があれば SDK の `options.abortController` と結び付ける。要約の期限は `features/recap.md`「番ごとの更新」に従う |

1 つの会話の実行 (`AgentSession`) は、最初の指示を送るときに開き、番が終わっても閉じない。会話を手放すときか、作業場所が変わったときに閉じる。作業場所が変わったときは、古い出力の消費を終えてから、保存した会話の識別子で現在の作業場所に開き直す。ランナーは会話ごとに操作を 1 列に並べて処理し、同じ会話の実行を 2 つ開かない。

配達直前に、worktree の共有排他の中で作業場所を確かめ、検証で得た worktree の識別子を実行に使う。古い実行を閉じて出力の消費を待つ間は、共有排他を外す。待機後は作業場所と届く前の指示・画像を読み直し、終了中なら配達しない。共有排他の範囲は `features/worktree-terminal.md`「実装の配置」に従う。

#### アプリのツールの受け渡し

ランナーの各モジュールは、AI に渡すツールを `AppToolRegistry` に登録する。ツールの中身は `features/issue.md`「AI に渡すツール」が持つ。

```ts
type AppTool = {
  name: string; // AI からは mcp__sukuna__<name> に見える
  description: string;
  input: ZodRawShape;
  alwaysLoad: boolean;
  handler(input: unknown, ctx: { conversationId: string; projectId: string; issueId: string | null }): Promise<{ text: string; isError: boolean }>;
};
```

実物は、会話ごとに `createSdkMcpServer({ name: "sukuna", tools })` で MCP サーバーを作り、`options.mcpServers` に渡す。会話ごとに作るのは、ツールの処理が呼び出し元の会話と issue を知るためである。

#### 偽物 (`ScriptedAgent`)

テストと E2E は、台本どおりに `AgentOutput` を流す偽物を使う。

- ランナーは、環境変数 `SUKUNA_AGENT=fake` のときに偽物を使い、`SUKUNA_AGENT_SCRIPT` の台本のファイルを読む (「環境変数」)
- 台本は JSON で、`e2e/agent-scripts/` と各テストの近くに置く。形は `src/shared/agent-script.ts` の Zod のスキーマが正本である
- アプリのツールの呼び出しは、登録した処理を実際に通す。精査・設計・実装の報告で issue が移る流れを、結合のテストと E2E で確かめるためである

```json
{
  "rules": [
    {
      "match": "^/dev-spec",
      "steps": [
        { "text": "設計を始めます。" },
        { "tool": "Edit", "input": { "file_path": "src/a.ts" }, "result": "ok", "diff": { "path": "src/a.ts", "change": "edit", "hunks": [] } },
        { "shell": "git add -A && git commit -m 'design'" },
        { "ask": [{ "question": "どちらにしますか?", "header": "方針", "options": [{ "label": "A", "description": "" }], "multi_select": false }] },
        { "hold": true },
        { "rate_limit": { "status": "rejected", "resetsAt": 1764000000 } },
        { "end": "success" }
      ]
    }
  ],
  "fallback": [{ "text": "了解しました。" }, { "end": "success" }],
  "completions": [{ "purpose": "recap", "match": "", "text": "{\"toc\":[],\"decisions\":[],\"questions\":[]}" }]
}
```

| 段 | 動き |
| --- | --- |
| `text` | `text_delta` を 1 件と `assistant_text` を流す |
| `tool` | `tool_use` と `tool_result` を流す。`diff` があれば結果に付ける。名前が `mcp__sukuna__` で始まるツールは、`AppToolRegistry` に登録した処理を実際に呼び、その戻り値を結果にする。台本の `result` は使わない |
| `shell` | 会話の `cwd` でコマンドを実際に実行し、`Bash` の `tool_use` と、標準出力と標準エラーをつないだ `tool_result` を流す。終了コードが 0 でなければ `is_error` を真にする |
| `ask` | `onQuestion` を呼び、回答が返るまで次へ進まない |
| `permission` | `onPermission` を呼び、答えが返るまで次へ進まない |
| `hold` | 停止の操作が来るまで次へ進まない。止まると `turn_end` (`error_during_execution`) を流す |
| `rate_limit` | `rate_limit` を流す。続けて `end` を書くと、その番が終わる |
| `end` | `turn_end` を流す。値は `subtype` に入る。API の失敗を表すときは `terminal_reason: "api_error"` を添える |

- 指示を受けるたびに、本文が `match` の正規表現に合う最初の規則の `steps` を流す。合う規則が無ければ `fallback` を流す
- 1 回きりの呼び出しには、`purpose` が同じで、`prompt` が `match` に合う最初の `completions` の `text` を返す。合うものが無ければ空の文字を返す。`text` の中身の形は、呼び出す機能が決める
- 時間を待つ段は持たない。作業中の状態は `hold` で作り、実時間を待たずにテストを進める
- `shell` は、偽物の AI に git の操作 (コミット、push、merge) をさせるためにある。自動フローのテスト (`features/implementation-flow.md`、`features/design-review.md`) は、この段を使うか、テストのコードが先に git を操作する
- `fork` は新しい UUID を返し、元の会話の規則をそのまま使う。再開は同じ台本の続きを使う
- 時計とタイマーは `Clock` の Port で受け、テストでは進められる偽物を渡す

#### `gh` の偽物

両方のプロセスは、`gh` の実行を共有の実行器 `GhRunner` で行う。各機能の GitHub の Port の実物 (`gh-cli.ts`) は、この実行器を使う。テストと E2E は、実行器を台本どおりに答える偽物に差し替え、本物の GitHub を呼ばない。

```ts
interface GhRunner {
  run(args: string[], opts: { cwd: string; stdin?: string }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
```

```json
{
  "responses": [
    { "match": "^pr view ", "stdout": "{\"state\":\"OPEN\"}", "exit_code": 0 },
    { "match": "^pr review ", "stdout": "", "exit_code": 0 }
  ],
  "fallback": { "stdout": "", "stderr": "no response in script", "exit_code": 1 }
}
```

- 両方のプロセスは、`SUKUNA_GH` があると、そのファイルを台本として読む。形は `src/shared/gh-script.ts` の Zod のスキーマが正本である
- 引数を空白 1 つでつないだ文字列が `match` の正規表現に合う、最初の応答を返す。合うものが無ければ `fallback` を返す
- 偽物は受けた引数と `stdin` を順に覚え、テストが投稿の中身を確かめられるようにする
- 台本の中身 (どの `gh` の呼び出しに何を返すか) は、`gh` を呼ぶ機能が決める

### ランナーの再起動

規則は DESIGN.md「横断規約 > ランナーの再起動」参照。ランナーは起動時に次を行う。

**残った子プロセスを止める**: ランナーは、Claude Code の子プロセスを SDK の `spawnClaudeCodeProcess` で起動し、PID を `$SUKUNA_HOME/runner/children` に 1 行ずつ書く。起動時はこのファイルの PID のうち、生きていてコマンドが Claude Code のものに SIGTERM を送る。5 秒たっても残るものには SIGKILL を送り、ファイルを空にする。`spawnClaudeCodeProcess` で PID を取れないときは、`ps` の一覧から、引数に保存済みの `session_id` を含む Claude Code のプロセスを探して止める。

子プロセスの PID は `spawnClaudeCodeProcess` の戻り値から取得する。この方法で止めた会話も、保存した識別子で再開する (PoC `runner-child-cleanup`)。

**会話の状態を直す**: 子プロセスを止めたあと、会話ごとに次のように扱う。会話の種類で扱いを分けない。

| 再起動の前の状態 | 扱い |
| --- | --- |
| `working` / `waiting_answer` / `waiting_permission` | `stopped` (`restarted`、`previous_run_state` に前の状態) を書き、指示が届くまで動かさない |
| `usage_limited` | `resets_at` の 1 分後にタイマーを張り直す。閉じた会話には張らない |
| `idle` / `stopped` / `failed` | 何もしない |

- 自動フローの会話 (`triage`、`design`、`impl`) の続きの指示は、`flow` が送る。`flow` は `stopped` の記録の `previous_run_state` で、前に何をしていたかを知る (`features/issue-flow.md`「ランナーの再起動のあと」)
- 開発者が始めた会話 (`chat`、`thread`) の扱いは `features/conversation.md`「停止・割り込み・再開」に従う
- 再起動と停止で、保留していた質問の待ちは消える。待ちの消えた質問に回答が届いたら、ランナーは回答を指示の文にして送る。記録には `answer` (`as_message: true`) と `user_message` (`origin: "answer_text"`) を書く
- 指示の文は、質問ごとに「Q: <質問の文>」の行と「A: <回答>」の行を並べ、質問の間に空行を入れる
- 待ちの消えた許可の確認に答えると、409 を返す。`message` は「AI を動かすプロセスが再起動したため、この確認は無効になりました。指示を送って続けてください。」とする
- 再開は、保存した `session_id` と `cwd` で `open` し、「再開」の文を送る (「再開と利用枠の戻り」)
- 届く前の指示は、再起動では消さない。止まった会話の分は、開発者が届けるまで残す

### 再開と利用枠の戻り

- 再開の操作は、`resumed` を書き、アプリが決めた文「中断したところから続けてください。」だけを `user_message` (`origin: "resume"`) として送る。届く前の指示は残し、再開した番が正常に終わってから届ける
- `usage_limited` の会話は、`resets_at` の 1 分後にタイマーで再開する (`resumed` の `by: "usage_limit"`)。その時刻が過ぎていたら、起動の直後に再開する
- 自動フローの会話 (`triage`、`design`、`impl`) は、再開の前に、再開してよいかを `flow` に問う。一時停止のときと、その段階を自動で処理する段階から外しているときは、`flow` が断り、再開しない。解除か段階を戻したあとの評価が再開を呼ぶ (`features/issue-flow.md`「AI が止まったとき」)
- `resets_at` が無いときは、15 分ごとに再開を試みる。再開して再び利用枠切れになったら、新しい `resets_at` でタイマーを張り直す
- 開発者の再開を受け付けた番が開き直しの前に利用枠切れになった場合も、その停止にタイマーを張る。期限に達したら、同じ停止の会話が開いていることを確かめてから再開する
- 枠が戻っても閉じたままなら、再開の受付から 15 秒まで開き直しを待つ。15 秒は、IPC の応答待ち 10 秒と SQLite の更新待ち 5 秒を合わせた時間である
- `credits_required` で止まった会話は、自動では再開しない
- 自動で再開したときは、知らせの `notice` を出す
- 実行を手放す操作 (`release`) は、その会話の利用枠の戻りを待つタイマーも外す。閉じた会話は、開発者が送るまで再開しない (`features/conversation-lifecycle.md`)

### マイグレーション

- Drizzle Kit で SQL を生成し、`src/shared/db/migrations/` に置く。テーブルの定義は `src/shared/db/schema.ts` に置く
- 両方のプロセスは、起動時にデータベースを開き、`PRAGMA journal_mode = WAL`、`PRAGMA busy_timeout = 5000`、`PRAGMA foreign_keys = ON` を設定する
- 当てるあいだだけ、`$SUKUNA_HOME/db.lock` の排他のロックを取る。当て終えたらすぐに外し、動いているあいだはロックを持たない (DESIGN.md「データスキーマ」)
- ロックの取り方と、取れないときに起動を失敗させるまでの時間は `features/operations.md`「データベースのロック」が持つ
- 未適用の分は、ロックの中の `BEGIN IMMEDIATE` のトランザクションで当てる。当て済みの記録を見て、当てる分が無ければ何もしない
- 当てるのに失敗したら、ロールバックしてロックを外し、プロセスの起動を失敗させる。理由はログに出す
- 動いているプロセスはロックを持たないので、画面のサーバーの入れ替えは、動いているランナーを待たない (BR-069)
- バックアップからの復元は、2 つのプロセスを止めてから行う。手順は `features/operations.md` が持つ
- 画面のサーバーだけを入れ替える更新のマイグレーションは、テーブルと列を足す変更に限る。古いランナーが新しいスキーマのまま動けるようにするためである (DESIGN.md「インフラ」)
- 列の削除や型の変更は、ランナーも入れ替える更新に入れる。手順は `features/operations.md` が持つ

### ログ

項目と出さないものは DESIGN.md「横断規約 > ログ」参照。本書は書き方と出す場面を決める。

- ロガーは `src/shared/log.ts` に 1 つ作り、両方のプロセスが使う。出力は標準出力に 1 行 1 件の JSON とする
- 項目は `time` (ISO 8601)、`level` (`debug` / `info` / `warn` / `error`)、`component`、`message` と、`conversation_id`、`issue_id`、`error` に限る。ほかの項目を足せない形の関数にして、本文が紛れ込まないようにする
- `error` は、エラーの名前とメッセージにする。スタックは `debug` のときだけ出す
- 出す水準は環境変数 `SUKUNA_LOG_LEVEL` で決める (`features/operations.md`「環境変数」)
- `component` は `server.api`、`server.ws`、`server.runner-link`、`runner.ipc`、`runner.agent`、`runner.flow`、`runner.recovery`、`db.migrate` とし、ほかの機能が足すときは `<プロセス>.<コンテキスト>` の形にする

| 場面 | `level` | `component` |
| --- | --- | --- |
| 起動と終了、待ち受けの開始 | `info` | 各プロセスの入口 |
| ランナーへの操作の受け付けと結果 (本文は出さない) | `info` | `runner.ipc` |
| 番の終わり (`subtype`、費用、時間) | `info` | `runner.agent` |
| 利用枠の知らせ (受け取ったままの形) | `info` | `runner.agent` |
| 止まった理由 | `warn` | `runner.agent` |
| 再起動のときに止めた子プロセスと、直した会話 | `info` | `runner.recovery` |
| ランナーとのつながりの切断と回復 | `warn` | `server.runner-link` |
| 例外を境界で捕まえたとき | `error` | 捕まえた場所 |

## API

利用者向けの API (`/api`) は持たない。会話の API は `features/conversation.md`、配信の `/ws` は「配信」節と DESIGN.md「横断規約 > 配信」が正本である。プロセスの間の口は「画面のサーバーからランナーへの操作」と「ランナーからの知らせ」に書いた。

## 実装の配置

| 処理 | 層 | 実装先ファイル |
| --- | --- | --- |
| 記録・操作・知らせ・配信の形 | 共有のスキーマ | `src/shared/events.ts`、`src/shared/ipc.ts`、`src/shared/ws.ts` |
| 偽物の台本の形 | 共有のスキーマ | `src/shared/agent-script.ts` |
| テーブルの定義、接続の設定、マイグレーションの当て方 (ロックを取って呼ぶのは `features/operations.md` の `startup.ts`) → 全テーブル | 共有 (インフラ) | `src/shared/db/schema.ts`、`src/shared/db/migrations/`、`src/shared/db/open.ts`、`src/shared/db/migrate.ts` |
| 環境変数の読み取りと、起動を失敗させる検査 (`features/operations.md`「環境変数」) | 共有 | `src/shared/env.ts` |
| `gh` の実行器と、その偽物の台本の形 | 共有 (インフラ) | `src/shared/gh/gh-runner.ts`、`src/shared/gh/scripted-gh.ts`、`src/shared/gh-script.ts` |
| git と `gh` を実行する口の土台。実行の口と偽物への差し替えだけを持ち、各機能が自分の関数を足す | インフラ | `src/server/modules/workspace/adapter/git-cli.ts`、`src/runner/modules/workspace/adapter/git-cli.ts`、`src/runner/modules/flow/adapter/gh-cli.ts` |
| ロガー | 共有 | `src/shared/log.ts` |
| ランナーの起動の順序と組み立て | ランナーの入口 | `src/runner/main.ts`、`src/runner/app.ts` |
| ソケットの待ち受けと操作の振り分け | インフラ (ランナー) | `src/runner/modules/conversation/adapter/ipc-routes.ts` |
| 知らせの流れ | インフラ (ランナー) | `src/runner/modules/conversation/adapter/change-feed.ts` |
| AI の Port と出力の型 | ドメイン | `src/runner/modules/conversation/domain/agent-port.ts` |
| 画像を読む Port と画像の型 | ドメイン | `src/runner/modules/conversation/domain/image-port.ts` |
| 会話専用ディレクトリからの画像の読み取り | インフラ | `src/runner/modules/conversation/adapter/image-files.ts` |
| 出力から記録への写し、状態の移り変わり、止まった理由の判定 | ドメイン | `src/runner/modules/conversation/domain/event-mapping.ts`、`src/runner/modules/conversation/domain/run-state.ts`、`src/runner/modules/conversation/domain/stop-reason.ts` |
| 開始・送信・停止・再開・分岐・回答・許可・手放す → `conversations`、`conversation_events`、`queued_instructions`、`pending_answers`、`questions` | ユースケース | `src/runner/modules/conversation/usecase/*.ts` |
| 再起動のときの直し → `conversations`、`conversation_events` | ユースケース | `src/runner/modules/conversation/usecase/recover.ts` |
| 利用枠の戻りを待つタイマー | ユースケース | `src/runner/modules/conversation/usecase/usage-limit-timer.ts` |
| 利用枠の状態の保存 → `settings` (`usage.rate_limit`) | ユースケース | `src/runner/modules/conversation/usecase/record-rate-limit.ts` |
| 記録の保存 → `conversation_events`、`conversations` | インフラ (Repository) | `src/runner/modules/conversation/adapter/sqlite-conversation-store.ts` |
| SDK の実物と、SDK のメッセージからの写し | インフラ | `src/runner/modules/conversation/adapter/claude-agent-sdk.ts`、`src/runner/modules/conversation/adapter/sdk-message-mapping.ts` |
| 偽物 | インフラ | `src/runner/modules/conversation/adapter/scripted-agent.ts` |
| アプリのツールの登録 | ユースケース | `src/runner/modules/conversation/usecase/app-tool-registry.ts` |
| 子プロセスの記録と停止 | インフラ | `src/runner/modules/conversation/adapter/child-processes.ts` |
| 時計とタイマー | ドメインの Port と実物 | `src/runner/modules/conversation/domain/clock.ts`、`src/runner/modules/conversation/adapter/system-clock.ts` |
| データベース・配信・ランナーとのつながりを 1 つ持つ場所 | 画面のサーバーの組み立て | `src/server/runtime.ts` |
| ランナーへの操作の呼び出しと、知らせの受け取り | 画面のサーバーの組み立て (インフラ) | `src/server/runner-link.ts` |
| `/ws` の受け口、購読、再送、いま見ているもの → `conversation_events`、`issue_events` (読み取り) | 画面のサーバーの組み立て (インフラ) | `src/server/ws-hub.ts` |
| 画面の `/ws` の接続、購読、つなぎ直し | UI | `src/front/lib/realtime.ts` |

作業場所の切り替えは `features/worktree-terminal.md` の処理を使う。ランナーの組み立てで `startRunnerApp` の `ipc.workspace` に渡し、`ipc-routes.ts` が入力と結果を振り分ける。

## エッジケースの決定

1. **空・最小データ**: 最初の指示なしで会話を始めると、行だけを作り、記録は 0 件で `run_state` は `idle` にする。記録の無い会話の購読は、再送を 0 件にする。偽物の台本に合う規則も `fallback` も無いときは、`turn_end` (`success`) だけを流す
2. **上限・境界値**: ツールの結果は 64 KiB、差分は 5,000 行、ツールの入力は値ごとに 16 KiB までを保存する。再送は 1 回の購読で 1,000 件まで、送り待ちは接続ごとに 8 MiB までとする。ソケットのパスは 103 バイトまでとする
3. **エラー時に利用者へ見えるもの**: ランナーにつながらないときは、操作の応答規則に従って画面にお知らせを出す。状態の合わない操作は 409 になる。AI の開始に失敗したとき (ログインの切れなど) は、`stopped` (`error`) にエラーの文を入れ、会話の末尾に止まった理由として出る
4. **並行操作・二重実行**: ランナーは会話ごとに操作を 1 列に並べて処理する。同じ会話で 10 分以内に届いた同じ `client_id` の送信は、1 回だけ届けるか預ける。2 つ目のランナーは起動を失敗させる。マイグレーションは `db.lock` の排他のロックの中で当て、2 つ目のプロセスは当て済みの記録を見て何もしない
5. **再表示時の整合**: 画面はつなぎ直すと、`after` で続きの記録を受け取り、記録以外は API で読み直す。画面のサーバーが再起動したときも同じで、ランナーの AI は動き続ける。ランナーとのつながりが戻ったら、購読中の対象を SQLite から読み直して配信する
6. **表示の寿命**: AI の書きかけの発言は、会話の末尾に逐次出し、同じ発言の保存か番の終わりで消える。保存しないので、画面を開き直すと書きかけは出ず、保存した発言から表示する
7. **送る前のデータ**: 届く前の指示はランナーが SQLite に置き、ランナーの再起動でも消えない。番が正常に終わるまで届けない。待ちの消えた質問への回答は、送る前の回答のまま残り、開発者が送ると指示の文として届く。回答以外の指示を届けて AI が次の応答を始めると、その質問は回答済みになり、送る前の回答は消える
8. **状態の移り変わり**: 「会話の状態の移り変わり」と「番の終わりの理由」の表のとおりにする。再起動のときは「ランナーの再起動」の表のとおりにする
9. **自動で進むこと**: 番の終わりに届く前の指示を届ける。利用枠切れは戻る時刻の 1 分後か 15 分ごとに再開する。自動フローの会話は、一時停止のあいだと、その段階を自動で処理しないあいだは再開しない。自動フローの会話は、再起動のあとに `flow` が続きの指示を送る。画面のサーバーはランナーへ 1 秒ごとにつなぎ直す。画面は `/ws` へ 0.5〜8 秒の間隔でつなぎ直す。開発者が書いた文を自動で送ることはしない
10. **端末と画面をまたぐこと**: 同じ会話を購読するすべてのタブとすべての端末に、同じ記録を配信する。「いま見ているもの」は、ページが見えているタブが主のウィンドウか右のウィンドウに出している対象だけから決める
11. **並びと数え方**: 記録は SDK から届いた順に保存し、`seq` は会話ごとに 1 から振る。`created_at` と `last_activity_at` はランナーの時計で付ける。1 通にまとめる届く前の指示は `position` の順に並べる

## テスト方針

| 確かめること (タスク説明から起こした) | レベル |
| --- | --- |
| SDK の発言・ツールの実行・ツールの結果・Edit と Write の差分・番の終わりの見本を写すと、決めた種類と形の出力になり、知らない種類は読み飛ばされる | 単体 |
| 利用枠の知らせが「上限に達した」で、超過分の利用が許されていないとき、番の終わりは利用枠切れと判定され、戻る時刻が入る。超過分が許されているときと、クレジットの購入が要るときは利用枠切れにならない | 単体 |
| 出力を記録に写すと、記録の追加と会話の状態・最後の番号の更新が 1 つのトランザクションで行われ、状態が表のとおりに移る | 結合 |
| 大きなツールの結果と差分を保存すると、上限で切られ、切ったことと元の大きさが記録に残る | 単体 |
| 画面のサーバーから指示を送ると、ランナーが記録を保存して知らせ、その会話を購読している接続に記録が届く | 結合 |
| 作業中の会話にツールの実行が保存されると、会話の状態が変わらなくても、一覧の購読に変化の知らせが届く | 結合 |
| 作業中に指示を送ると預けられ、番が正常に終わると書いた順に 1 通で届く。止めて終わったときは届かずに残る | 結合 |
| 作業中に割り込みで送ると、AI が止まり、届く前の指示のあとに新しい指示を付けた 1 通が届き、止まった理由の記録は書かれない | 結合 |
| 同じ送信の番号で 10 分以内に 2 回送っても、指示は 1 回だけ届くか預けられ、2 回目には 1 回目の結果が返る。預けた指示が届いたあとでも同じになる | 結合 |
| 選択式の質問が出ると会話は回答待ちになり、回答を送ると質問ごとの回答をまとめた形で AI に渡って続きが動く | 結合 |
| 許可の確認に許可か拒否で答えると、AI はその答えで続ける | 結合 |
| 分岐すると、新しい会話の行が元の会話を親として先に作られ、最初の指示がその会話に届く | 結合 |
| ランナーが止まっているときに画面のサーバーへ操作を送ると、503 と runner_unavailable が返る | 結合 |
| 購読を最後の番号つきでつなぎ直すと、その後の記録だけが順に届き、1,000 件を超えるときは読み直しの合図が届く | 結合 |
| 画面のサーバーを作り直しても、ランナーの作業は続き、つなぎ直した画面に途中の記録が届く | 結合 |
| ランナーが再起動すると、作業中・回答待ち・許可待ちだった会話は、前の状態を記録に残して止まった扱いになり、指示が届くまで動かない | 結合 |
| 作業中の会話があるランナーに終了の合図を送ると、届いた出力を保存して 20 秒以内に終わり、次の起動でその会話が止まった扱いになる | 結合 |
| 停止か再起動で待ちの消えた質問に回答を送ると、回答が指示の文として届く | 結合 |
| 利用枠切れで止まった会話は、時計を戻る時刻の 1 分後まで進めると再開し、時刻が無いときは 15 分ごとに再開を試みる | 結合 |
| 一時停止のプロジェクトの自動フローの会話は、時計を戻る時刻の 1 分後まで進めても再開しない | 結合 |
| 利用枠切れで止まった会話の実行を手放すと、時計を戻る時刻まで進めても再開しない | 結合 |
| 利用枠の知らせを受けると、`settings` の `usage.rate_limit` が最後の知らせの形で書かれる | 結合 |
| ランナーの起動時に、記録した子プロセスが生きていれば止められ、ファイルが空になる | 結合 |
| ソケットに別のランナーが待ち受けているときにランナーを起動すると、起動が失敗する | 結合 |
| 2 つのプロセスが同時に起動しても、マイグレーションは 1 回だけ当たる | 結合 |
| マイグレーションを当て終えたランナーが動いているあいだも、画面のサーバーはロックを待たずに起動できる | 結合 |
| 偽物は、台本の規則に合う指示に台本の出力を流し、止めるまで作業中のままでいられ、1 回きりの呼び出しには台本の文字を返す | 単体 |
| 偽物の台本で名前が mcp__sukuna__ で始まるツールを呼ぶと、登録した処理が呼ばれ、その戻り値がツールの結果になる | 結合 |
| 偽物の台本の shell の段は、会話の作業ディレクトリでコマンドを実際に実行し、出力と終了コードをツールの結果に写す | 結合 |
| gh の偽物は、引数が台本に合う最初の応答を返し、合わなければ fallback を返し、受けた引数を覚える | 単体 |
| 本番の起動で AI か gh の偽物が指定されていると、そのプロセスの起動が失敗する | 単体 |
| ランナーへの操作をログに出しても、指示の本文はログに出ない | 単体 |
| 見ているページの接続が主のウィンドウか右のウィンドウに出している会話は「いま見ているもの」になり、ページが隠れると外れる。ファイルの表示のためだけに購読している会話は入らない | 単体 |
