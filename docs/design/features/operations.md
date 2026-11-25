# アプリの導入と保守

- 種別: 機能設計書
- 対象 UC: UC-015 (docs/design/USECASES.md)

## 何を作るか

アプリを Mac Studio に入れて常駐させ、開発者だけが使える状態を保ち、更新・バックアップ・復元・キーの割り当ての変更をできるようにする。

**使う人**: 開発者 (1 人)。導入と更新は Mac Studio の端末で、ほかは PC のブラウザで行う。

**流れ**:

1. 導入のコマンドを 1 回実行すると、画面のサーバーと AI を動かすプロセスが登録され、Mac にログインするたびに自動で動く
2. 別の端末から Tailscale 経由で開くと、本人なら画面が出て、本人でなければ「使えません」だけが出る
3. 更新のコマンドを実行すると、画面のサーバーだけが入れ替わり、動いている AI は作業を続ける。AI を動かすプロセスのコードが変わった更新だけは、開発者が選んだときに AI を止めて入れ替える
4. アプリは毎日 1 回データベースをバックアップして 7 日分を残し、設定の画面から issue・会話・ストックなどをその時点へ戻せる
5. :h でキーとコマンドを調べ、:map でキーの割り当てを変える

**主な決まり**:

- アプリは Tailscale の中にだけ公開し、接続元の本人情報が開発者と一致するときだけ使える。ログイン画面は作らない (BR-067, BR-068)
- 画面のサーバーと AI を動かすプロセスは別に動かし、画面のサーバーの入れ替えでは AI を止めない (BR-069)
- Mac が再起動すると、作業中だった AI はすべて止まる。自動フローの AI には続きの指示が届き、開発者が始めた会話は指示を送るまで動かさない
- バックアップから戻すときは、画面のサーバーと AI を動かすプロセスを止めてから戻し、戻したあとは自動フローを一時停止にする。同じ作業を二重に進めないためである
- キーの割り当てはサーバーに保存し、どの端末でもすぐに同じになる。ヘルプは今の割り当てを出す (BR-070, BR-071)
- 割り当てようとしたキーがすでに使われていれば、重なったキーを示し、どちらを使うかを選ばせる
- エージェントが 10 個以上動き、会話が長くても、キーを押してから 0.1 秒以内に画面が応じる (BR-072)

## 入出力と振る舞い

### この機能の前提

- 本人の判定の決まりは DESIGN.md「横断規約 > 本人の判定」が正本である。本書は、その判定を使う `/api/me`、拒否の画面、導入の設定を書く
- 環境変数の値の形、既定の値、読むプロセス、起動を失敗させる条件は、本書の「環境変数」が正本である。名前と用途の一覧は DESIGN.md「開発・検証コマンド」にある
- ランナーの再起動の扱いは DESIGN.md「横断規約 > ランナーの再起動」が正本である。Mac の再起動のあとも、この扱いで動く
- キーの割り当ての仕組み (既定の割り当て、動作の名前、コマンド行、キーの書き方) は `features/buffer-ui.md` が持つ。本書は、割り当ての保存・API・重なりの扱い・ヘルプの画面を持つ
- 設定の画面 (`:set`) の作りは本書が持つ。「通知」の節の中身は `features/inbox.md`、プロジェクトと自動フローの節の中身は `features/project-settings.md` が持つ
- 手本は UI_SKETCH.html の `pc-help` (ヘルプ)、`pc-settings` (設定)、アプリシェルの `Denied` (拒否の画面) である

### 導入

導入の前提:

- Mac Studio が Tailscale につながっている
- macOS の自動ログインを有効にしている。プロセスはログインしたユーザーのサービス (LaunchAgent) として動くので、ログインするまで起動しない。Claude Code のログイン情報もログインのキーチェーンにある
- Node.js、`git`、`gh`、Claude Code が入っていて、Claude Code にログインしている

導入の手順:

```sh
git clone <リポジトリ> ~/sukuna && cd ~/sukuna
vp install && vp build
node dist/server/install.js --port 4580 --login <開発者の Tailscale のログイン名>
```

導入のコマンド (`dist/server/install.js`) は次を行う。何度実行しても結果は同じになる。

1. `SUKUNA_HOME` (既定は `~/.sukuna`) と、下の「データの置き場所」のディレクトリを、持ち主だけが読み書きできる権限 (0700) で作る
2. VAPID の鍵が無ければ作り、`vapid.json` に権限 0600 で保存する
3. この Mac の Tailscale の持ち主のログイン名を、Tailscale のローカル API で調べる。`--login` と違えば、その旨を表示する。導入は止めない
4. `~/Library/LaunchAgents/` に、画面のサーバー (`dev.sukuna.server`)、ランナー (`dev.sukuna.runner`)、復元の処理 (`dev.sukuna.restore`) の 3 つの plist を書く。中身は下の表のとおり
5. `launchctl bootout` で前の登録を外してから、`launchctl bootstrap gui/<uid>` で 3 つを登録する。再実行では画面のサーバーとランナーが入れ替わる
6. ランナーの成果物のハッシュを `runner-build.sha` に書く (下の「更新」)
7. 30 秒以内に、指定したポートが待ち受けを始め、ランナーのソケットができることを確かめる。できたら `http://<MagicDNS の名前>:<port>` を表示する。できなければ、ログのファイルの場所を表示して失敗で終わる

plist の中身:

| キー | 画面のサーバーとランナー | 復元の処理 |
| --- | --- | --- |
| `ProgramArguments` | Node.js の絶対パスと、`<リポジトリ>/dist/server/main.js` (ランナーは `dist/runner/main.js`) | Node.js の絶対パスと、`<リポジトリ>/dist/server/install.js`、`restore` |
| `WorkingDirectory` | リポジトリの絶対パス | 同じ |
| `EnvironmentVariables` | `NODE_ENV=production`、`PORT`、`SUKUNA_HOME`、`SUKUNA_LOGIN`、`HOME`、`PATH` (導入を実行した端末の値)、`CLAUDE_CONFIG_DIR` (導入を実行した端末に設定があるときだけ) | 同じ |
| `RunAtLoad` | `true` | `false` (画面のサーバーが復元のときだけ起動する) |
| `KeepAlive` | `true` (落ちたら起動し直す) | `false` |
| `ThrottleInterval` | `10` (秒) | なし |
| `ExitTimeOut` | `20` (秒。止める合図のあと、強制で止めるまでの時間) | なし |
| `StandardOutPath` / `StandardErrorPath` | `<SUKUNA_HOME>/logs/server.log` (ランナーは `runner.log`) | `<SUKUNA_HOME>/logs/restore.log` |

- plist には上の列の環境変数だけを書く。値の形と既定の値は下の「環境変数」に従う
- 開発者のログイン名は環境変数 `SUKUNA_LOGIN` で渡す。本人の判定がすべての API を塞ぐので、画面からは設定できないためである
- plist に `SUKUNA_DEV_IDENTITY` と偽物の指定 (`SUKUNA_AGENT`、`SUKUNA_AGENT_SCRIPT`、`SUKUNA_GH`) は書かない。本番の起動でこれらがあると、起動を失敗させる (下の「環境変数」)
- `SUKUNA_RUNNER_SOCKET` と `SUKUNA_LOG_LEVEL` は書かず、既定の値で動かす
- `install.js --uninstall` は、3 つの登録を外して plist を消す。データは消さない

### 環境変数

すべての環境変数の値の形、既定の値、読むプロセス、起動を失敗させる条件を次の表に決める。

| 環境変数 | 値の形 | 既定 | 読むプロセス | 起動を失敗させる条件 |
| --- | --- | --- | --- | --- |
| `SUKUNA_HOME` | データの置き場所のディレクトリのパス | `~/.sukuna` | 画面のサーバー、ランナー、導入のコマンド、復元の処理 | なし |
| `PORT` | 画面のサーバーが 0.0.0.0 で待ち受けるポートの番号 (1〜65535) | `4580` | 画面のサーバー | 番号として読めないか、そのポートで待ち受けられない (画面のサーバー) |
| `CLAUDE_CONFIG_DIR` | Claude Code の設定のディレクトリのパス | `~/.claude` | 画面のサーバー (タイムラインのファイルを探す。`features/work-monitor.md`)。ランナーは読まず、Claude Code の子プロセスにそのまま渡る | なし |
| `SUKUNA_LOGIN` | 開発者の Tailscale のログイン名 (例: `dev@example.com`) | 無し | 画面のサーバー | 本番の起動で無い (画面のサーバー)。だれでも通す状態で動かさないため |
| `SUKUNA_RUNNER_SOCKET` | ランナーのソケットのパス (103 バイトまで) | `$SUKUNA_HOME/runner.sock` | 画面のサーバー、ランナー | 103 バイトを超える (両方。`features/runtime.md`「プロセスと起動」) |
| `SUKUNA_AGENT` | `fake` で Agent SDK を偽物にする | 無し (実物を使う) | ランナー | 本番の起動である (ランナー) |
| `SUKUNA_AGENT_SCRIPT` | 偽物の AI の台本のファイルのパス。`SUKUNA_AGENT=fake` のときに要る | 無し | ランナー | 本番の起動である。`SUKUNA_AGENT=fake` なのに無いか読めない (どちらもランナー) |
| `SUKUNA_GH` | `gh` の偽物の台本のファイルのパス。あると `gh` を偽物にする | 無し (実物を使う) | 画面のサーバー、ランナー | 本番の起動である (両方) |
| `SUKUNA_DEV_IDENTITY` | 127.0.0.1 からの接続を本人として扱うときの、本人のログイン名 | 無し | 画面のサーバー | 本番の起動である (画面のサーバー) |
| `SUKUNA_LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` | 画面のサーバー、ランナー | なし |
| `NODE_ENV` | `production` のとき本番の起動とする | 無し | 画面のサーバー、ランナー | なし |

- 起動を失敗させるときは、理由をログに出して終わる。launchd は `ThrottleInterval` のあとに起動し直すが、設定を直すまで失敗が続く
- 偽物の台本の形は `features/runtime.md`「偽物 (`ScriptedAgent`)」と「`gh` の偽物」が持つ
- 環境変数の読み取りと、起動を失敗させる検査は、両方のプロセスが共有の 1 か所で行う (`features/runtime.md`「実装の配置」の `src/shared/env.ts`)

### データの置き場所

`SUKUNA_HOME` の中身:

| パス | 中身 | 書くプロセス |
| --- | --- | --- |
| `sukuna.db` (と `-wal`・`-shm`) | SQLite のデータベース | 両方 |
| `images/<conversation_id>/` | 貼り付けた画像。名前と記録の形は `features/runtime.md`「書くプロセスの分担」 | 画面のサーバー |
| `vapid.json` | Web Push の VAPID の鍵 (権限 0600) | 導入のコマンド |
| `runner.sock` | ランナーの Unix ドメインソケット (既定のパス。`features/runtime.md`「プロセスと起動」) | ランナー |
| `runner/children` | ランナーが起動した Claude Code の子プロセスの PID (`features/runtime.md`「ランナーの再起動」) | ランナー |
| `runner-build.sha` | 前回入れ替えたランナーの成果物のハッシュ (下の「更新」) | 導入のコマンド |
| `backups/` | バックアップ (下の「バックアップ」) | ランナー、復元の処理 |
| `logs/` | 3 つのプロセスのログ | launchd |
| `db.lock` | マイグレーションと復元の置き換えのあいだだけ取る、排他のロックのファイル (下の「データベースのロック」) | 両方、復元の処理 |
| `restore.json` | 復元の依頼 (復元のあいだだけある) | 画面のサーバーが書き、復元の処理か起動の処理が消す |

- ログのファイルは、各プロセスの起動時に 100 MB を超えていれば、`<名前>.1` に写して空にする。`.1` は 1 世代だけ残す
- Agent SDK の会話の記録と、タイムラインのファイルは `~/.claude` にあり、アプリのデータではない。バックアップにも含めない

### 本人の判定と拒否の画面

判定の結果を、API・画面・配信の接続にどう見せるかを次のとおり決める。

- API と `/ws` は、本人でなければ 401 と `unauthorized` を返す。`/ws` は接続を受け付けない
- API ではないパス (SPA の HTML と静的ファイル) も、本人でなければ配らない。代わりに 401 で、拒否の画面だけの小さな HTML を返す。issue も会話も、画面の部品も見せない
- 拒否の画面の文は「このアプリは使えません」「Tailscale の本人として確認できませんでした。自分のアカウントで Tailscale につないでから、再読み込みしてください。」とする (UI_SKETCH.html の `Denied`)
- Tailscale への問い合わせが失敗したときは、2 文目を「Tailscale に問い合わせできませんでした。Mac Studio の Tailscale が動いているかを確かめてから、再読み込みしてください。」にする
- 開いたあとに本人ではなくなったときは、画面が `/api/me` の 401 を受けて、アプリの代わりに拒否の画面を出す (DESIGN.md「アプリシェル」)
- whois の結果は、接続元の IP アドレスごとに 60 秒覚える。失敗した結果は覚えない

whois の呼び方は、FEASIBILITY.md「PoC 結果 > tailscale-identity」の推奨アプローチに従う。要点は次のとおりである。

- 接続元の IP アドレスは、ソケットの接続元から先頭の `::ffff:` を除いて IPv4 の形にしてから、範囲の判定と whois に使う
- whois は `127.0.0.1:<ポート>` の `/localapi/v0/whois?addr=<IP アドレス>:<接続元のポート>` に送り、`Host: local-tailscaled.sock` を付ける
- ポートは `/Library/Tailscale/ipnport` から読む。認証は Basic 認証で、ユーザー名は空、パスワードは `/Library/Tailscale/sameuserproof-<ポート>` の中身とする
- 200 で返った `UserProfile.LoginName` を本人のログイン名とする。404、接続の失敗、不一致は拒否する
- ポートとパスワードは起動時に固定しない。認証か接続に失敗したら読み直し、1 回だけ問い合わせ直す (DESIGN.md「既知の制約」)
- 待ち受けは 0.0.0.0 (IPv4) なので、Tailscale の IPv6 の範囲は見ない

### 更新

更新の手順:

```sh
cd ~/sukuna && git pull && vp install && vp build
node dist/server/install.js update
```

- `update` は、画面のサーバーだけを `launchctl kickstart -k gui/<uid>/dev.sukuna.server` で入れ替える。ランナーは止めない (BR-069)
- ランナーの成果物 (`dist/runner/`) の中身のハッシュを、前回入れ替えたときの値 (`SUKUNA_HOME/runner-build.sha`) と比べる。違えば「ランナーのコードが変わりました。動いている AI を止めてよいときに `install.js update --runner` を実行してください」と表示する
- `update --runner` は、2 つのプロセスを止めてから両方を起動し直し、ハッシュを `runner-build.sha` に記録する。ランナーは止める合図 (SIGTERM) で 20 秒以内に終わる (`features/runtime.md`「プロセスと起動」)。入れ替えたあとの会話の扱いは DESIGN.md「ランナーの再起動」に従う
- 画面のサーバーとランナーの成果物は、遅れて読み込むチャンクを持たない 1 つのファイルにする。動いているランナーが、`vp build` で消えたチャンクを読みに行かないためである
- ランナーを入れ替えない更新に入れるマイグレーションは、テーブルと列の追加だけにする。古いランナーが新しいスキーマのまま動けるためである。列の削除や型の変更が要る更新は `update --runner` で入れる
- 画面のサーバーが入れ替わるあいだ、開いている画面は「サーバーにつながらないとき」の表示になり、つながると読み直す (`features/inbox.md`)。AI の出力は、ランナーがデータベースに保存し続けるので欠けない
- `/api/me` の応答はビルドの識別子を含む。画面は、つながり直したときに、読み込んだときの識別子と違えば、「アプリが更新されました。再読み込みすると新しい版になります。」をエラーと同じく Esc で消すまで出す
- 画面が遅れて読み込むチャンクの取得に失敗したときも、同じ文を出す

### バックアップ

- ランナーが、毎日 03:00 (Mac の時刻) に、SQLite のバックアップの機能 (`better-sqlite3` の `backup()`) でデータベースを写す。写し先は `backups/sukuna-<YYYY-MM-DD>.db` で、一時ファイルに書いてから名前を変える
- 日ごとのバックアップは新しい 7 つを残し、古いものを消す (UC-015 B)
- ランナーの起動時に、いちばん新しい日ごとのバックアップが 24 時間より古ければ、すぐに 1 回とる。03:00 に Mac が止まっていた日の分を補うためである
- 同じ日付のファイルがすでにあれば、上書きする
- バックアップの id は、ファイル名から先頭の `sukuna-` と末尾の `.db` を外したものとする。`sukuna-2026-11-26.db` は `2026-11-26`、`before-restore-20261125-101500.db` は `before-restore-20261125-101500` になる
- 結果は `settings` の `backup_status` (`{ "lastAt": <時刻>, "lastError": <文か null> }`) に書く。失敗しても、次の 03:00 まで取り直さない
- 貼り付けた画像 (`images/`) は含めない。復元したあとに無い画像は、会話の表示で見つからないと出す (`features/conversation.md`)

### 復元

設定の画面のメニューの行「バックアップから復元する」から行う。

1. 右のウィンドウに、バックアップを新しい順にメニューの行で並べる。1 行は `<MM/DD HH:MM>  <大きさ MB>` で、復元の直前の写しには `(復元の直前)` を付ける
2. 行を選ぶと、y / n の確認を出す。文は「<MM/DD HH:MM> の内容に戻します。動いている AI <件数> 件を止めます。」とする (P6)。件数は、確認を出す直前に読み直した `GET /api/settings` の `runningAiCount` である
3. y で `POST /api/backup/restore` を送る。画面は「復元しています。再起動のあと自動でつながります。」を出し、つながらない表示へ移る
4. つながったら、依頼した画面が「<MM/DD HH:MM> のバックアップから戻しました。自動フローを一時停止しています。:resume で再開します。」を出す。失敗していたら、その理由を出す

サーバーの中の手順:

決定: 復元は、画面のサーバーとランナーの外の「復元の処理」が、2 つのプロセスを止めてから行う。
理由: 動いているプロセスにロックを持たせずに、データベースを開いているプロセスが無いことを確かめられる (下の「データベースのロック」)。
採らなかった案: 動いているプロセスが共有のロックを持ち続け、起動の処理が排他のロックを待つ (画面のサーバーの入れ替えが、動いているランナーに待たされる)。

1. 画面のサーバーは、`restore.json` (`{ "backupId", "requestedAt" }`) を書き、`launchctl kickstart gui/<uid>/dev.sukuna.restore` で復元の処理を起動して、202 を返す
2. 復元の処理は、起動から 2 秒待ってから、`launchctl bootout` でランナーと画面のサーバーの登録を外して止める。2 秒待つのは、202 の応答を画面に届けるためである。ランナーは止める合図 (SIGTERM) を受けると、すべての AI を止めて記録を保存し、データベースを閉じて終わる (`features/runtime.md`「プロセスと起動」)。`ExitTimeOut` の 20 秒で終わらなければ、launchd が強制で止める
3. 2 つのプロセスが終わったことを PID で確かめてから、`db.lock` の排他のロックを取る
4. 今のデータベースを、SQLite のバックアップの機能で `backups/before-restore-<YYYYMMDD-HHMMSS>.db` に写す
5. バックアップを一時ファイルに写し、`PRAGMA integrity_check` で確かめる。通ったら、一時ファイルの `settings` の `flow_paused` (全体の一時停止) を `true` にし、`last_restore` に結果を書く
6. 一時ファイルの名前を変えてデータベースを置き換え、`-wal` と `-shm` を消す。ロックを外し、`restore.json` を消す
7. `launchctl bootstrap` で 2 つを登録し直す。2 つはふだんの起動と同じくマイグレーションを当てて動き出す。ランナーは、残った子プロセスを止め、会話を DESIGN.md「ランナーの再起動」のとおりに扱う

- 復元で戻るのは、アプリのデータベースにある issue・会話・ストックなどである (UC-015 B)。リポジトリ、worktree、PR、Agent SDK の会話の記録は戻らない
- 戻したあとに自動フローを一時停止にするのは、データベースの状態がリポジトリと PR より古くなるためである。そのまま進めると、merge 済みの issue を実装し直すことがある
- 復元の直前の写しは、いちばん新しい 1 つだけを残す。日ごとの 7 つには数えない
- バックアップが壊れていて確かめに落ちたら、置き換えずに、今のデータベースの `last_restore` に失敗と理由を書く。ロックを外し、`restore.json` を消してから、手順 7 で 2 つを登録し直す
- 全体の一時停止と `last_restore` を置き換えの前に一時ファイルへ書くのは、名前を変えた時点で復元が全部終わった状態にするためである。途中で Mac が止まっても、データベースは前のものか、一時停止まで済んだものかのどちらかになる
- 復元の途中で Mac が止まると、ログインのあとに launchd が 2 つのプロセスを起動する。起動の処理は `restore.json` が残っていれば消し、`last_restore` が依頼より古ければ、失敗と理由「復元の途中で止まりました」を書く

### データベースのロック

決定: 両方のプロセスは、起動時のマイグレーションのあいだだけ `db.lock` の排他のロックを取る。動いているあいだはロックを持たない (DESIGN.md「データスキーマ」)。
理由: 画面のサーバーの入れ替えを、動いているランナーが待たせないためである (BR-069)。

- ロックは、`db.lock` を排他の作成 (`open` の `wx`) で作り、中に PID を書いて取る。外すときはファイルを消す
- ファイルがあれば、0.5 秒ごとに取り直す。中の PID のプロセスが生きていなければ、落ちたプロセスが残したものとして消してから取る
- 60 秒たっても取れなければ、起動を失敗させて理由をログに出す。launchd が `ThrottleInterval` のあとに起動し直す
- 未適用のマイグレーションは、ロックの中で `features/runtime.md`「マイグレーション」の手順で当てる。後から取ったプロセスは、当てる分が無いことを確かめて進む
- 起動の処理は、ロックを取ったあとに `restore.json` を見る (上の「復元」の途中で止まったときの扱い)
- 復元の処理も、データベースを置き換えるあいだ同じロックを取る


### Mac の再起動のあと

- launchd が、ログインのあとに 2 つのプロセスを起動する (`RunAtLoad`)。起動の順は問わない。マイグレーションは、先に `db.lock` を取ったほうが当てる (上の「データベースのロック」)
- ランナーは、DESIGN.md「ランナーの再起動」のとおりに動く。作業中・回答待ち・許可待ちだった会話は、種類を問わずすべて `stopped` (`stop_reason` は `restarted`) になる (`features/runtime.md`「ランナーの再起動」)
- 自動フローの会話には、`flow` が続きの指示を送る (`features/issue-flow.md`「ランナーの再起動のあと」)。開発者が始めた会話は、指示を送るまで動かさず、一覧では判断待ちに出る (`features/inbox.md`)
- 開発者が止めていた会話は、止まったときの扱いのまま残す。利用枠切れで止まっていた会話は、保存してある戻る時刻から待ち直す
- 画面は、つながったら一覧と会話を読み直す。会話と issue は、データベースにあるとおりに出る

### キーの割り当ての設定

キーの割り当ては、既定の割り当てとの違いだけを、`settings` のキー `keymap` に保存する。保存する 1 行の形 (`KeymapEntry`)、既定の割り当ての表、今の割り当ての作り方は `features/buffer-ui.md`「キーの割り当て」が正本である。

```json
{
  "version": 1,
  "entries": [
    { "keys": "<Space>T", "context": "normal", "to": { "action": "timeline.open" } },
    { "keys": "<Space>t", "context": "normal", "to": null }
  ]
}
```

割り当てを変える操作:

| 操作 | 画面に起きること |
| --- | --- |
| `:map <キー> <動作の名前か Vim のキー列>` | Normal のキーを割り当てる。重なりがあれば、下の「割り当てが重なったとき」の確認を出す |
| `:unmap <キー>` | Normal のキーの割り当てを外す |
| `:tmap <キー> <動作の名前>` | ターミナルの入力中のキーを割り当てる。重なりがあれば、`:map` と同じ確認を出す |
| `:tunmap <キー>` | ターミナルの入力中のキーの割り当てを外す |
| 設定の画面のメニューの行「キーの割り当てを既定に戻す」 | y / n の確認のあと、`entries` を空にする |

- 保存する行の `context` は 4 つ (`normal`・`visual`・`prompt`・`terminal`) である。コマンドで作るのは、`:map` と `:unmap` の `normal` の行と、`:tmap` と `:tunmap` の `terminal` の行である
- ターミナルの入力から Normal へ戻るキー (既定 `Ctrl+]`、動作 `terminal.normal`) も割り当ての項目で、`context` が `terminal` の行で保存する (BR-061)
- コマンドの書き方と読み取り (場所の指定、キーの書き方、動作の名前の確かめ) は `features/buffer-ui.md` が行う。読めないときのお知らせも同書に従う
- 画面は、新しい行を今の `entries` の末尾に足して、`PUT /api/settings/keymap` で丸ごと送る。200 を受けたらすぐに今の割り当てを作り直す。新しいキーはその場で効き、ヘルプも作り直す
- サーバーは保存したら、配信の `app` の `settings_changed` を全部の接続へ送る (`features/runtime.md`「配信」)。ほかのタブと端末は `GET /api/settings` を読み直し、割り当てを作り直す (BR-071)
- 2 つの端末で同時に変えたときは、後から保存したほうを残す

### 割り当てが重なったとき

- 重なりは、`features/buffer-ui.md` の重なりの判定で求める。同じ `context` で、キーが同じか、一方がもう一方の先頭に当たる割り当て (例: `<Space>s` と `<Space>sa`) が当たる
- 重なりがあれば、保存の前に確認の行を出す。文は「<キー> は「<動作>」に使われています。新しい割り当てを使いますか? (y: 新しい割り当て / n: 今のまま)」とする。重なりが複数なら「、」で並べる (UC-015 E2)
- y なら、重なった割り当てを外す行と新しい行を合わせて保存する。n なら何も変えない
- サーバーは `entries` の形だけを確かめ、重なりは確かめない。動作の一覧は画面にあり、重なりの確認は画面が保存の前に行うためである

### ヘルプの画面

`:h` で主のウィンドウにヘルプを開く。手本は UI_SKETCH.html の `pc-help` である。

- 行は、`features/buffer-ui.md`「ヘルプの中身」の決まりで、今の割り当てから作る。変えたキーは新しいキーで出す (BR-070)
- 列は「キー / 動作 / 使える場所」の 3 つにし、キーは読みやすい書き方 (`Space t`、`Ctrl+w h`) で出す
- カーソルのある行の動作の名前を、ステータス行に `名前: <動作の名前>  (:map <キー> <動作の名前> で割り当てる)` と出す
- 開いているあいだに割り当てが変わったら、作り直す

### 設定の画面

`:set` で主のウィンドウに設定の画面を開く。値の行は `Enter` でも `i` でも変えられ、メニューの行で操作する (UI_SKETCH.html の `pc-settings`)。値の行ごとの変え方は `features/project-settings.md` の書き方に従う。

| 節 | 行 | 持ち主 |
| --- | --- | --- |
| 全体 | 自動フロー (動作中か停止中)、一時停止と再開のメニューの行 | `features/project-settings.md` |
| 全体 | `バックアップ  毎日 03:00 (最終: <日時>、<件数> 日分)`。失敗していれば `(最終: 失敗 <日時> <理由>)` | 本書 |
| 全体 | メニューの行「バックアップから復元する」 | 本書 |
| 全体 | `キーの割り当て  既定から <件数> 件を変更 (:map で変える)` と、メニューの行「キーの割り当てを既定に戻す」。変更が無ければ `既定のまま` | 本書 |
| 通知 | 通知の状態と、有効にする方法 | `features/inbox.md` |
| プロジェクト | プロジェクトごとの設定、登録と解除 | `features/project-settings.md` |

### エージェントが多いときの応答

BR-072 は、次の作りで満たす。

- キーの処理は、ネットワークの往復を待たない。画面の状態を先に変え、API の応答は後から反映する
- 配信で届いたイベントは、画面が描画の 1 回 (`requestAnimationFrame`) ごとにまとめて反映する。10 個の会話から同時に届いても、キーの処理の間に割り込む反映は 1 回に収める
- 画面のサーバーは、購読している対象の変化だけを配信する (DESIGN.md「配信」)。一覧の同じ行の配信は 1 秒に 1 回にまとめる (`features/inbox.md`)
- バッファへの追記は transaction の dispatch で行い、エディターの状態を作り直さない (DESIGN.md「既知の制約」)。長い会話の読み込みは範囲を指定して取る (`features/conversation.md`)
- AI の実行とイベントの保存はランナーが行い、画面のサーバーの処理を塞がない
- 画面のサーバーのデータベースの読み取りは、DESIGN.md「データスキーマ」のインデックスを使う問い合わせだけにする

## API

共通の規約 (本人の判定、エラーの形) は DESIGN.md「横断規約」の「本人の判定」と「エラー応答」に従う。

### GET /api/me

本人の判定の結果を返す。本人なら 200 で次を返し、本人でなければ 401 `unauthorized` を返す。

```json
{ "login": "dev@example.com", "device": "macbook-air", "build": "20261126-1a2b3c4" }
```

- `login` は Tailscale のログイン名、`device` は接続元の端末の名前である。開発用の `SUKUNA_DEV_IDENTITY` で通した接続では、`login` をその値に、`device` を `local` にする
- `build` はビルドの識別子で、`vp build` のときに埋め込む

### GET /api/settings

アプリの設定を返す。

```json
{
  "keymap": { "version": 1, "entries": [] },
  "flowPaused": false,
  "runningAiCount": 3,
  "backup": {
    "schedule": "03:00",
    "lastAt": 1764093600000,
    "lastError": null,
    "items": [
      { "id": "2026-11-26", "kind": "daily", "createdAt": 1764093600000, "sizeBytes": 12582912 },
      { "id": "before-restore-20261125-101500", "kind": "before_restore", "createdAt": 1764033300000, "sizeBytes": 12320768 }
    ]
  },
  "lastRestore": { "backupId": "2026-11-25", "at": 1764033300000, "status": "done", "message": null },
  "push": { "vapidPublicKey": "BEl6…" }
}
```

- `flowPaused` は全体の自動フローの一時停止 (`settings` の `flow_paused`) で、設定の画面の「全体」の行に使う。値の意味と変え方は `features/project-settings.md` が持つ
- `runningAiCount` は、解除していない全プロジェクトの会話のうち、`run_state` が `working` / `waiting_answer` / `waiting_permission` のものの数である。復元の確認の件数に使う
- `backup.items` は新しい順に返す。`id` はバックアップの id (上の「バックアップ」)、`kind` は `daily` か `before_restore` である
- `lastRestore` は、復元をしたことが無ければ `null` にする。`status` は `done` か `failed` である
- `push.vapidPublicKey` は、通知の購読に使う VAPID の公開鍵である (`features/inbox.md`)

### PUT /api/settings/keymap

キーの割り当ての `entries` を丸ごと置き換える。

```json
{ "entries": [ { "keys": "<Space>T", "context": "normal", "to": { "action": "timeline.open" } } ] }
```

- 応答: 200 で、保存した `keymap` (`{ "version": 1, "entries": [...] }`) を返す
- 失敗: 行の形が `features/buffer-ui.md` の `KeymapEntry` に合わないか、`keys` が空なら 400 `invalid_input`

### POST /api/backup/restore

バックアップから復元する。

```json
{ "backupId": "2026-11-25" }
```

- 応答: 202 で `{ "restarting": true }` を返し、上の「復元」の手順で 2 つのプロセスを起動し直す
- 失敗: バックアップが無ければ 404 `not_found`。復元の依頼 (`restore.json`) がすでにあれば 409 `conflict`。復元の処理 (`dev.sukuna.restore`) が launchd に登録されていなければ 409 `conflict` で、`message` に導入のコマンドを実行し直すことを書く。2 つのプロセスを止めて起動し直す手段が無いためである

### 配信

キーの割り当てを保存したら、`app` の `settings_changed` を送る (`features/runtime.md`「配信」)。画面は `GET /api/settings` を読み直す。

## 実装の配置

| 処理 | 層 | 実装先ファイル |
| --- | --- | --- |
| 導入・更新・登録の解除のコマンド、plist の生成 | インフラ | `src/server/install.ts`, `src/server/modules/settings/domain/launchd-plist.ts` |
| 復元の処理 (`install.js restore`。2 つのプロセスを止める、置き換える、登録し直す) → settings | ユースケース | `src/server/modules/settings/usecase/run-restore.ts` |
| launchd の操作の Port と実物 (`launchctl`) | アダプター | `src/server/modules/settings/domain/launchd-port.ts`, `src/server/modules/settings/adapter/launchctl.ts` |
| 本人の判定のミドルウェア、拒否の HTML、`/api/me` | API ハンドラ | `src/server/modules/identity/adapter/middleware.ts`, `src/server/modules/identity/adapter/routes.ts` |
| whois の結果の覚え方 (60 秒) | ユースケース | `src/server/modules/identity/usecase/resolve-identity.ts` |
| `db.lock` の取り方、ロックの中でのマイグレーションの呼び出し (当て方は `features/runtime.md` の `migrate.ts`)、途中で止まった復元の後始末 → 全テーブル, settings | インフラ | `src/shared/db/startup.ts` |
| バックアップのタイマーと世代の管理 → settings | ユースケース | `src/runner/modules/settings/usecase/backup.ts` |
| 復元の依頼 (`restore.json` を書き、復元の処理を起動する) | ユースケース | `src/server/modules/settings/usecase/request-restore.ts` |
| `keymap` の形の Zod のスキーマ | 共有 | `src/shared/settings/keymap-schema.ts` |
| キーの割り当ての保存 → settings | ユースケース | `src/server/modules/settings/usecase/save-keymap.ts` |
| 設定の API ハンドラ | API ハンドラ | `src/server/modules/settings/adapter/routes.ts` |
| ログのファイルの大きさの管理 | インフラ | `src/shared/log/rotate.ts` |
| ヘルプの画面 | UI | `src/front/pages/help.tsx` |
| 設定の画面 | UI | `src/front/pages/settings.tsx` |
| `:map`・`:unmap`・`:tmap`・`:tunmap` の保存、重なりの確認の行 (重なりの判定は `features/buffer-ui.md` の `conflicts.ts`) | UI | `src/front/lib/keymap-commands.ts` |
| 拒否の画面 | UI | `src/front/components/denied.tsx` |
| 更新の案内 (ビルドの識別子の比較、チャンクの取得の失敗) | UI | `src/front/lib/build-check.ts` |

`src/server/install.ts` は、`vp build` の入力に足して `dist/server/install.js` に出す。

- 設定の画面は `src/front/pages/settings.tsx` の 1 つとする。「通知」と「プロジェクト」の節は、持ち主の機能設計書が決めた部品として、この画面が並べる
- `/api/settings` で始まる API のハンドラは `src/server/modules/settings/adapter/routes.ts` に置く。ほかの機能が `/api/settings` の下に足す API (例: `PUT /api/settings/flow-paused`) も、このファイルに足す

## エッジケースの決定

1. 空・最小データ: バックアップが 1 つも無いときは、設定の画面に `バックアップ  毎日 03:00 (まだありません)` と出し、復元のメニューの行で「バックアップはまだありません」を出す。`entries` が空なら、キーの割り当ての行を `既定のまま` にする
2. 上限・境界値: 日ごとのバックアップは 7 つまでで、8 つ目をとった直後にいちばん古いものを消す。補いのバックアップは、最新が 24 時間ちょうどより古いときにとる。ログは 100 MB を超えたら写して空にする。whois の結果は 60 秒で忘れる
3. エラー時に利用者へ見えるもの: 本人でなければ拒否の画面だけを出す。Tailscale への問い合わせの失敗は、拒否の画面の文で区別する。復元の失敗は、つながり直したあとに理由をお知らせに出す。キーの割り当ての保存の失敗は、応答の `message` をお知らせに出し、画面の割り当ては変えない。導入のコマンドの失敗は、端末に理由とログの場所を出す
4. 並行操作・二重実行: 復元の依頼が 2 回届いたら、2 回目は 409 `conflict` を返す。2 つのプロセスのマイグレーションは `db.lock` の排他のロックで 1 つずつ当てる。動いているあいだはロックを持たないので、画面のサーバーの入れ替えはランナーを待たない。キーの割り当てを 2 つの端末で同時に変えたら、後から保存したほうを残す。バックアップの途中にランナーが止まったら、一時ファイルを残さずに次の起動で消す
5. 再表示時の整合: 画面は、つながり直すたびに `GET /api/me` と `GET /api/settings` を読み直す。ビルドの識別子が変わっていたら更新の案内を出す。キーの割り当ては、配信の `settings_changed` を受けたときにも読み直す
6. 表示の寿命: 更新の案内と復元の結果の文は、Esc で消すまで残す。キーの割り当ての保存の成功は、ほかのお知らせと同じく 4 秒で消す
7. 送る前のデータ: `:map` の入力はコマンド行にだけあり、Enter で送るか Esc で捨てる。重なりの確認のあいだは保存しない。復元は y を押すまで送らない
8. 状態の移り変わり: 復元すると、全体の自動フローが一時停止になり、開発者が `:resume` で戻す (`features/project-settings.md`)。Mac の再起動とランナーの入れ替えのあと、作業中だった会話はすべて `stopped` (`restarted`) になる。自動フローの会話には `flow` が続きの指示を送り、開発者が始めた会話は指示を待つ
9. 自動で進むこと: 次は開発者の操作なしに行う。毎日 03:00 と起動時の補いのバックアップ、古いバックアップの削除、落ちたプロセスの起動し直し (`KeepAlive`)、起動時のマイグレーション、途中で止まった復元の後始末。失敗したバックアップは、次の 03:00 まで取り直さない
10. 端末と画面をまたぐこと: キーの割り当てはサーバーに持ち、すべての端末で同じにする (BR-071)。ヘルプのカーソルの位置と、設定の画面で開いている右のウィンドウは、タブごとに持つ。本人の判定は、接続ごとに接続元で行う
11. 並びと数え方: バックアップの一覧は新しい順に並べる。保存する世代は日ごとのものだけを 7 つ数え、復元の直前の写しは数えない。キーの割り当ての変更の件数は `entries` の数を数える。ヘルプの行は見出しの中で動作の一覧の順に並べる

## テスト方針

| 受け入れ基準 (docs/design/USECASES.md) | レベル |
| --- | --- |
| （US-030）Tailscale の本人情報が開発者と一致する端末で開くと、画面が表示される | 結合 |
| （US-030）本人情報が一致しない端末で開くと、使えないことが表示され、issue も会話も表示されない | 結合 |
| （US-051）Mac が再起動すると、アプリが自動で起動し、会話と issue がそのまま表示される | 単体 |
| （US-051）Mac が再起動すると、止まった自動フローの AI が、止まった段階から始め直される | 結合 |
| （US-051）Mac が再起動しても、開発者が始めた会話の AI は、指示を送るまで動かない | 結合 |
| （US-052）AI が動いている間にアプリを更新しても、AI は作業を続け、画面を開き直すと続きが表示される | 結合 |
| （US-053）アプリのデータは 1 日 1 回バックアップされて 7 日分が残り、バックアップを選んで復元すると、その時点の内容に戻る | 結合 |
| （US-045）画面のサーバーが再起動した後で会話を開くと、それまでの会話が表示され、続けて指示を送れる | 結合 |
| （US-026）`:h` を実行すると、今の割り当てでのキーとコマンドの一覧が表示される | 単体 |
| （US-027）キーの割り当てを変えると、すぐに新しいキーで操作でき、ヘルプにも反映される | 結合 |
| （US-027）すでに使われているキーに割り当てようとすると、重なっているキーが示され、どちらを使うかを選べる | 単体 |
| （US-058）エージェントが 10 個以上動き、会話が長いときも、キーを押してから 0.1 秒以内に画面が応じる | E2E |

- 本人の判定の 2 行は、Tailscale のローカル API を Port の偽物にし、接続元の IP アドレスとログイン名を替えて、API・HTML・`/ws` の応答を確かめる。拒否の画面の単体テストは DESIGN.md「アプリシェル」の表が持つ
- 「Mac が再起動すると、アプリが自動で起動し」は、生成した plist の中身 (`RunAtLoad`、`KeepAlive`、絶対パス、環境変数) を単体テストで確かめる。Mac の再起動そのものは自動のテストで起こせない。会話と issue が残ることは、データベースのファイルを開き直す結合テスト (US-045 の行) が通る
- 再起動と更新の結合テストは、Agent SDK を Port の偽物にし、ランナーと画面のサーバーを別のプロセスとして起動し、片方だけを止めて起動し直す
- バックアップの結合テストは、時計の Port を 8 日分進め、日ごとのファイルが 7 つ残ることと、復元のあとにその時点の行に戻ることを確かめる。launchd の操作は Port の偽物にする
- キーの割り当ての変更の行は、`PUT /api/settings/keymap` で保存し、`settings_changed` の配信を受けた別のタブが割り当てとヘルプの行を作り直すことを結合で確かめる。新しいキーで動作が呼ばれることは、`features/buffer-ui.md` の割り当ての単体テストが確かめる
- 0.1 秒の行は、キーを押してから描画までの時間をブラウザでしか測れないので E2E にする。10 個以上のエージェントを同時に動かすことがこのアプリの前提で、遅くなれば全部の操作が使えなくなるためである。性能の測定として E2E の仕組みで流す
- 0.1 秒の E2E は、偽物の Agent SDK で 12 個の会話に 1 秒 10 件のイベントを流し、1 万行の会話を開いて `j` を 50 回押す。キーを押してから次の描画までの時間の 95 パーセンタイルが 100 ミリ秒以下であることを確かめる

E2E 対象動線: （US-058）エージェントが 10 個以上動き、会話が長いときも、キーを押してから 0.1 秒以内に画面が応じる
