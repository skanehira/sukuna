# 技術検証（Feasibility Check）

- 種別: 技術検証

## 対象機能

UC-001〜UC-016 の全部を対象にする。Mac Studio に常駐し、Claude Code のエージェントを会話と issue の単位で動かす Web アプリで、PC とスマホから Tailscale 経由で使う。

## 技術的不確実性

| ID | 不確実性 | 種類 | 影響度 | 発生確率 | リスクレベル |
|----|----------|------|--------|----------|-------------|
| R1 | Claude Agent SDK (TypeScript) で会話を動かし、発言・ツールの実行・差分を順に受け取れるか。skills とプラグインが端末の Claude Code と同じに動くか。選択式の質問に答えられるか | 技術的実現性 | 致命的 | 中 | 🔴 最優先 |
| R2 | AI を動かすプロセスを再起動したあとに、同じ会話を前の文脈で続けられるか。worktree を消したあとや、日数が経ったあとも続けられるか | 技術的実現性 | 致命的 | 中 | 🔴 最優先 |
| R3 | 作業中の AI を止めて次の指示をすぐ届けられるか。作業が終わるまで指示を預かり、まとめて届けられるか | 技術的実現性 | 重大 | 中 | 🟡 優先 |
| R4 | 元の会話の文脈を引き継いだ別の会話 (スレッド) を始められ、そのやりとりが元の会話に入らないか | 技術的実現性 | 重大 | 中 | 🟡 優先 |
| R5 | すべてのウィンドウを CodeMirror 6 と Vim の読み取り専用バッファにする作りが、長い会話と出力の追記、ほかの会話の更新を受けながらでも引っかからないか | パフォーマンス | 致命的 | 低 | 🟡 優先 |
| R6 | アプリを閉じていても、ブラウザの通知が PC と iPhone に届くか | 統合 | 重大 | 中 | 🟡 優先 |
| R7 | 利用枠切れを API のエラーと区別でき、枠が戻る時刻を取れるか | 統合 | 重大 | 中 | 🟡 優先 |
| R8 | Tailscale 経由のリクエストから本人のアカウントが分かり、本人以外を拒否できるか | セキュリティ | 重大 | 低 | 🟢 通常 |
| R9 | 目次・決まったこと・質問の一覧を、AI の番が終わるたびに別の AI で更新する時間と利用枠が許容できるか | コスト | 中程度 | 中 | 🟢 通常 |
| R10 | Vite+ で、React の SPA と Node.js で動く Hono の API を 1 つのプロジェクトとして開発・テスト・ビルドできるか (Cloudflare に依存しない構成) | 統合 | 重大 | 低 | 🟢 通常 |

ブラウザのターミナル (擬似端末とターミナルの部品) と、ファイルの検索 (`rg`) は、広く使われている作りなので対象から外した。

## 検証項目

### R1: Agent SDK で会話を動かす

**検証内容**:
- Agent SDK で 1 つの会話を始め、指示を送り、発言・ツールの実行・ファイルの編集の差分をイベントとして順に受け取る
- `~/.claude` の skills とプラグインを読み込ませ、スラッシュコマンド (例: `/dev-spec`) を呼び出す
- AI が選択式の質問を出したとき、選択肢と文章の回答を 1 回で返す
- 許可の確認を出さない設定 (bypassPermissions) で、ファイルの編集とコマンドの実行をさせる

**成功基準**:
- 発言・ツールの実行・差分の 3 種類が、種類を区別できる形で、発生した順に取れる
- skills の呼び出しが、端末の Claude Code と同じ手順で進む
- 選択式の質問 2 問に、選択 1 つと文章 1 つをまとめて返し、AI が続きを行う
- 許可の確認が 1 度も出ない

**失敗した場合の代替案**:
- Claude Code の CLI をヘッドレス (`claude -p` のストリーム出力) で起動し、出力を読んで画面に出す
- skills が動かない場合は、スキルの本文を指示文として渡す
- 選択式の質問に答えられない場合は、質問を文章で書かせ、回答を次の指示として送る

### R2: 再起動のあとに会話を続ける

**検証内容**:
- 会話の途中で AI を動かすプロセスを止め、起動し直してから、同じ会話に指示を送る
- 会話を動かしていた worktree を消し、別のディレクトリで同じ会話を続ける
- Claude Code が古い会話の記録を消す期間 (既定は 30 日) を、設定で延ばせるかを調べる

**成功基準**:
- 再起動の前に伝えた内容 (例: 合言葉) を、再起動のあとの応答が覚えている
- それまでの会話の記録を、画面に出せる形で読み出せる
- worktree を消したあとも、会話の記録から続きの指示を送れる
- 会話の記録が、日数が経っても自動では消えない設定にできる

**失敗した場合の代替案**:
- 会話の記録のファイルを、続けるディレクトリの側へ写してから再開する
- 会話の記録をアプリ側に保存し、再開のときに要約を新しい会話へ渡す
- worktree を消した会話は、読むだけにする

### R3: 停止・割り込みと、届く前の指示

**検証内容**:
- 時間のかかる作業をさせている途中で止め、すぐに別の指示を届ける
- 作業中に指示を 2 件預かり、作業が終わった時点で 1 通にまとめて届ける

**成功基準**:
- 止める操作から 3 秒以内に、AI の作業と実行中のコマンドが止まり、それまでの作業の記録が残る
- 止めた直後に届けた指示に、AI が前の文脈を保ったまま応答する
- 預かった 2 件が、作業の終わりのあとに 1 通で届く

**失敗した場合の代替案**:
- 止められない場合は、プロセスを終了して R2 の再開で続ける
- 預かりは、アプリ側で作業の終わりのイベントを待ってから送る

### R4: スレッド

**検証内容**:
- 元の会話から、その時点までの文脈を引き継いだ会話を分岐させ、質問を送る
- 分岐のあとで、元の会話に指示を送る
- 元の会話の AI が作業している途中に分岐させる

**成功基準**:
- 分岐した会話が、分岐の前に元の会話で伝えた内容を覚えている
- 分岐した会話でのやりとりを、元の会話が知らない
- 分岐した会話で、ファイルの読み取りとコマンドの実行ができる
- 元の会話の AI が作業中でも分岐でき、元の会話の作業が途切れない

**失敗した場合の代替案**:
- 元の会話の記録を要約して、新しい会話の最初の指示に付ける
- スレッドを、元の会話に入る通常の発言として扱う (スコープ縮小)

### R5: CodeMirror と Vim のバッファの性能

**検証内容**:
- 1 万行の会話 (発言、ツールの実行、差分を含む) を、行ごとの装飾付きで読み取り専用のバッファに出す
- 0.1 秒ごとに 1 行ずつ末尾に追記しながら、`j` `k` `gg` `G` `/` で移動する
- 同時に、ほかの 10 本の会話の状態の変化 (一覧の行の更新) を、ブラウザの中で模して受け続ける

**成功基準**:
- 行の移動の操作から描画までが、100 回の操作の 95 パーセンタイルで 50ms 以内
- 追記のたびに、カーソルの位置、Vim のモード、入力途中のキー (回数の指定) が保たれる
- 1 万行を開くまでが 1 秒以内

**失敗した場合の代替案**:
- 画面に出す行を直近の数千行に限り、古い部分は遡ったときに読み込む
- 追記を一定間隔 (例: 0.3 秒) にまとめる

### R6: アプリを閉じていても届く通知

**検証内容**:
- Tailscale の HTTPS で配信したページから、Web Push の通知を購読する
- ページを閉じた状態で、サーバーから通知を送る (PC の Chrome と、iPhone の Safari)

**成功基準**:
- PC で、ページを閉じていても、送ってから 30 秒以内に通知が出て、選ぶと該当の画面が開く
- iPhone で、ホーム画面に追加した状態なら、PC と同じく通知が出て、選ぶと該当の画面が開く
- 1 つの端末で通知を選ぶと、ほかの端末に残った同じ通知が 1 分以内に消える (どれかの端末で対応したら消す規則のため)

**失敗した場合の代替案**:
- iPhone だけ、別の通知の手段 (例: ntfy のようなプッシュ通知のサービス) を使う
- 通知の取り下げができない場合は、対応済みの通知を選んだときに「対応済み」と表示する

### R7: 利用枠切れの検知

**検証内容**:
- 利用枠切れのときに Agent SDK が返すイベントとエラーの形を調べる
- 枠が戻る時刻が、その中に含まれるかを調べる

**成功基準**:
- 利用枠切れを、API のエラーや失敗と区別できる
- 枠が戻る時刻が取れる

**失敗した場合の代替案**:
- 時刻が取れない場合は、一定の間隔 (例: 15 分) で再開を試みる
- 区別できない場合は、自動では再開せず、開発者が再開を選ぶ

### R8: Tailscale の本人情報

**検証内容**:
- `tailscale serve` で配信したサーバーに届くリクエストから、アクセスした人のアカウントを読む
- 別のアカウントの端末からアクセスする
- 端末から、本人情報のヘッダーを偽って付けたリクエストを送る

**成功基準**:
- リクエストから、Tailscale のログイン名が取れ、別のアカウントでは別のログイン名になる
- 偽のヘッダーを付けて送っても、サーバーには Tailscale が付けた値が届く
- サーバーはループバックだけで待ち受け、Mac の外からは Tailscale を経由しないと届かない

同じ Mac で動くプロセスはループバックへ直接送れるので、ヘッダーを偽れる。この範囲を信頼するかは、横断設計で決める。

**失敗した場合の代替案**:
- Tailscale の ACL で、自分の端末だけがアクセスできるようにする
- Tailscale のローカル API に、接続元の IP アドレスの持ち主を問い合わせる

### R9: 目次などを更新する AI の費用

**検証内容**:
- 20 往復と 100 往復の会話を入力にして、目次・決まったこと・質問の一覧を小さいモデルで更新する
- 更新 1 回の時間と、使ったトークンの量を測る

**成功基準**:
- 100 往復の会話でも、更新 1 回が 10 秒以内
- 更新 1 回に使うトークンが、同じ番で会話の本体が使ったトークンの 1 割以内

**失敗した場合の代替案**:
- 更新を、AI の番ごとではなく、開発者が直近や目次を開いたときに行う
- 質問の一覧だけを毎回更新し、目次と決まったことは間隔を空ける

### R10: Vite+ と Node.js の構成

**検証内容**:
- `fullstack-worker-template` の構成から、Cloudflare に依存する部分 (`@cloudflare/vite-plugin`、wrangler、D1) を外す。代わりに、Node.js で動く Hono と SQLite (Drizzle ORM) を使う
- `vp dev` で SPA と API を同時に動かし、`vp test`、`vp check`、`vp build` を通す
- API から画面へ、WebSocket でイベントを流す
- SQLite のドライバと擬似端末の部品のような、ネイティブの部品をサーバーから使い、ビルドの成果物に含める

**成功基準**:
- `vp dev` の 1 回の起動で、SPA のホットリロードと API の再読み込みの両方が効く
- `vp test` で、画面のテスト (jsdom) とサーバーのテスト (本物の SQLite) が同じ設定で通る
- `vp build` の成果物を `node` で起動すると、SPA と API と WebSocket が 1 つのポートで動く
- ビルドの成果物から、ネイティブの部品 (SQLite のドライバ、擬似端末) が動く
- レイヤの境界 (domain / usecase / adapter) を破る import を置くと、`vp check` が失敗する

**失敗した場合の代替案**:
- 開発のときだけ、API を別のプロセスで動かし、Vite の proxy でつなぐ
- WebSocket が難しい場合は、サーバーからの一方向の配信 (Server-Sent Events) と通常のリクエストに分ける
- ネイティブの部品をまとめられない場合は、ビルドの成果物に含めず、インストールした場所から読み込む

## PoC計画

### PoC: Agent SDK で会話を動かす
<!-- POC_STATUS: id=agent-sdk-conversation, blocker=true, status=verified, confidence=0.88 -->

**id**: agent-sdk-conversation
**目的**: Claude Agent SDK (TypeScript) で会話を動かし、発言・ツールの実行・差分を順に受け取り、skills の呼び出しと選択式の質問への回答ができることを確かめる
**risk**: high
**blocker**: true

**スコープ**:
- 含む: 会話の開始、指示の送信、イベントの受け取り、skills とプラグインの読み込み、選択式の質問への回答、許可の確認を出さない設定
- 含まない: 画面、保存、複数の会話の同時実行

**実装内容**:
1. Agent SDK の最新のドキュメントで、会話の開始・イベント・質問への回答・設定の読み込みの API を確かめる
2. 一時ディレクトリの Git リポジトリで会話を始め、ファイルを 1 つ編集させて、イベントを種類ごとに記録する
3. skills を呼び出す指示と、選択式の質問を出させる指示を送り、回答を返す

**必要なリソース**:
- 技術: Claude Agent SDK (TypeScript)、Node.js
- 環境: Claude Code にログイン済みの Mac
- データ: 一時ディレクトリの Git リポジトリ

**成功基準**:
- 発言・ツールの実行・差分が、種類を区別できる形で、発生した順に取れる
- skills の呼び出しが動く
- 選択式の質問 2 問に、選択 1 つと文章 1 つをまとめて返せる
- 許可の確認が出ない

**判断**:
- 成功 → Agent SDK を実行方式に決める
- 失敗 → CLI のヘッドレス起動を試す

### PoC: 再起動のあとに会話を続ける
<!-- POC_STATUS: id=agent-sdk-resume, blocker=true, status=verified, confidence=0.85 -->

**id**: agent-sdk-resume
**目的**: AI を動かすプロセスを再起動したあと、および worktree を消したあとに、同じ会話を前の文脈で続けられることを確かめる
**risk**: high
**blocker**: true

**スコープ**:
- 含む: 会話の識別子の保存、プロセスの終了と再起動、会話の記録の読み出し、別のディレクトリでの再開、会話の記録を消す期間の設定
- 含まない: Mac 全体の再起動、自動フローの自動再開

**実装内容**:
1. 会話を始めて合言葉を伝え、会話の識別子をファイルに保存してプロセスを終了する
2. 新しいプロセスで識別子から会話を再開し、合言葉を尋ねる
3. worktree で始めた会話について、worktree を消してから同じことを行う
4. Claude Code の設定のドキュメントで、会話の記録を消す期間と、それを延ばす設定を確かめる

**必要なリソース**:
- 技術: Claude Agent SDK (TypeScript)
- 環境: Claude Code にログイン済みの Mac
- データ: 一時ディレクトリの Git リポジトリと worktree

**成功基準**:
- 再起動のあとの応答が合言葉を覚えている
- それまでの会話の記録を読み出せる
- worktree を消したあとも続きの指示を送れる
- 会話の記録が、日数が経っても自動では消えない設定にできる

**判断**:
- 成功 → 会話の識別子だけを保存し、会話の記録を消さない設定で動かす
- 失敗 → 会話の記録をアプリ側に保存する設計にする

### PoC: 停止・割り込みと、届く前の指示
<!-- POC_STATUS: id=agent-sdk-interrupt, blocker=true, status=verified, confidence=0.85 -->

**id**: agent-sdk-interrupt
**目的**: 作業中の AI を止めて次の指示をすぐ届けられること、作業の終わりまで指示を預かってまとめて届けられることを確かめる
**risk**: medium
**blocker**: true

**スコープ**:
- 含む: 作業中の停止、停止の直後の指示、作業の終わりのイベントの検知
- 含まない: 画面、預かった指示の編集

**実装内容**:
1. 時間のかかる作業 (例: 30 秒かかるコマンド) をさせ、途中で止める
2. 止めた直後に指示を送り、前の文脈で応答するかを見る
3. 作業中に指示を 2 件ためておき、作業の終わりのイベントを受けてから 1 通で送る

**必要なリソース**:
- 技術: Claude Agent SDK (TypeScript)
- 環境: Claude Code にログイン済みの Mac
- データ: 一時ディレクトリの Git リポジトリ

**成功基準**:
- 止める操作から 3 秒以内に、作業と実行中のコマンドが止まる
- 止めた直後の指示に、前の文脈を保って応答する
- 預かった 2 件が、作業の終わりのあとに 1 通で届く

**判断**:
- 成功 → 停止と預かりを SDK の機能で作る
- 失敗 → プロセスの終了と再開で代える

### PoC: スレッド
<!-- POC_STATUS: id=agent-sdk-thread, blocker=true, status=verified, confidence=0.9 -->

**id**: agent-sdk-thread
**目的**: 元の会話の文脈を引き継いだ別の会話を始められ、そのやりとりが元の会話に入らないことを確かめる
**risk**: medium
**blocker**: true

**スコープ**:
- 含む: 会話の分岐、分岐した会話でのツールの実行、元の会話への影響の有無
- 含まない: 分岐した会話の確定事項を元の会話へ戻す操作

**実装内容**:
1. 元の会話で合言葉 A を伝える
2. 元の会話から分岐した会話を作り、合言葉 A を尋ね、合言葉 B を伝える
3. 元の会話で合言葉 B を尋ねる
4. 元の会話に時間のかかる作業 (例: 30 秒かかるコマンド) をさせ、その途中で分岐させる

**必要なリソース**:
- 技術: Claude Agent SDK (TypeScript)
- 環境: Claude Code にログイン済みの Mac
- データ: 一時ディレクトリの Git リポジトリ

**成功基準**:
- 分岐した会話が合言葉 A を答える
- 元の会話が合言葉 B を知らない
- 分岐した会話でファイルの読み取りとコマンドの実行ができる
- 元の会話の AI が作業中でも分岐でき、元の会話の作業が途切れない

**判断**:
- 成功 → スレッドを会話の分岐で作る
- 失敗 → 元の会話の要約を付けた新しい会話で代える

### PoC: CodeMirror と Vim のバッファの性能
<!-- POC_STATUS: id=codemirror-vim-buffer, blocker=true, status=verified, confidence=0.85 -->

**id**: codemirror-vim-buffer
**目的**: 1 万行の会話を行ごとの装飾付きの読み取り専用バッファに出し、追記しながら Vim の操作をしても引っかからないことを確かめる
**risk**: medium
**blocker**: true

**スコープ**:
- 含む: 1 万行の表示、行ごとの装飾、末尾への追記、ほかの 10 本の会話の更新、Vim の移動と検索、描画までの時間の計測
- 含まない: サーバーとの通信、スマホの画面

**実装内容**:
1. UI スケッチのバッファの作り (CodeMirror 6 と `@replit/codemirror-vim`、行と列の装飾) を取り出し、1 万行の見本データを作る
2. ほかの 10 本の会話の状態の変化を、ブラウザの中で一定の間隔で起こし、一覧の行を更新する
3. 0.1 秒ごとに 1 行ずつ追記しながら、Playwright で `j` `k` `gg` `G` `/` を 100 回ずつ送り、操作から描画までの時間を測る
4. 追記の前後で、カーソルの位置、Vim のモード、入力途中の回数の指定を比べる

**必要なリソース**:
- 技術: CodeMirror 6、`@replit/codemirror-vim`、Playwright
- 環境: Chrome
- データ: 生成した 1 万行の会話

**成功基準**:
- 行の移動の操作から描画までが、100 回の操作の 95 パーセンタイルで 50ms 以内
- 追記のたびに、カーソルの位置、Vim のモード、入力途中の回数の指定が保たれる
- 1 万行を開くまでが 1 秒以内

**判断**:
- 成功 → スケッチの作りのまま実装する
- 失敗 → 出す行を直近に限るか、追記をまとめる

### PoC: アプリを閉じていても届く通知
<!-- POC_STATUS: id=web-push-tailscale, blocker=true, status=fallback_adopted, confidence=manual -->

**id**: web-push-tailscale
**目的**: Tailscale の HTTPS で配信したページから Web Push を購読し、ページを閉じた状態で PC と iPhone に通知が届くことを確かめる
**risk**: medium
**blocker**: true

**スコープ**:
- 含む: Tailscale の HTTPS、Service Worker、通知の購読と送信、通知を選んだときの遷移、通知の取り下げ
- 含まない: 通知の文面、通知を出す条件

**実装内容**:
1. `tailscale serve` で、通知を購読するだけの小さなページを HTTPS で配信する
2. PC の Chrome と、ホーム画面に追加した iPhone の Safari で購読し、ページを閉じてからサーバーで通知を送る
3. PC で通知を選んだあと、iPhone に残った同じ通知をサーバーから取り下げられるかを試す

**必要なリソース**:
- 技術: Web Push (VAPID)、Service Worker、`tailscale serve`
- 環境: Tailscale につないだ Mac と iPhone。iPhone での確認は開発者が行う
- データ: なし

**成功基準**:
- PC で、ページを閉じていても、送ってから 30 秒以内に通知が出て、選ぶと該当の画面が開く
- iPhone で、ホーム画面に追加した状態なら、PC と同じく通知が出て、選ぶと該当の画面が開く
- 1 つの端末で通知を選ぶと、ほかの端末に残った同じ通知が 1 分以内に消える

**判断**:
- 成功 → 通知を Web Push で作る
- iPhone で通知が出ない → iPhone だけ別の通知の手段を使う
- 取り下げだけができない → 対応済みの通知を選んだときに「対応済み」と表示する

### PoC: 利用枠切れの検知
<!-- POC_STATUS: id=usage-limit-detect, blocker=false, status=verified, confidence=0.7 -->

**id**: usage-limit-detect
**目的**: 利用枠切れを API のエラーや失敗と区別でき、枠が戻る時刻を取れることを確かめる
**risk**: medium
**blocker**: false

**スコープ**:
- 含む: 利用枠切れのときのイベントとエラーの形、戻る時刻の有無
- 含まない: 利用量の表示

**実装内容**:
1. Agent SDK のドキュメントと型定義で、利用枠切れのときのイベントとエラーの形を調べる
2. Claude Code の会話の記録に残った利用枠切れの例を探し、形を照らす

**必要なリソース**:
- 技術: Claude Agent SDK (TypeScript)
- 環境: Claude Code にログイン済みの Mac
- データ: 過去の会話の記録

**成功基準**:
- 利用枠切れを、ほかのエラーと区別できる
- 枠が戻る時刻が取れる

**判断**:
- 成功 → 戻る時刻に合わせて自動で再開する
- 時刻が取れない → 一定の間隔で再開を試みる
- 区別できない → 自動では再開せず、開発者が再開を選ぶ

### PoC: Tailscale の本人情報
<!-- POC_STATUS: id=tailscale-identity, blocker=false, status=verified, confidence=0.9 -->

**id**: tailscale-identity
**目的**: Tailscale 経由のリクエストから本人のアカウントが分かり、本人以外を拒否できることを確かめる
**risk**: low
**blocker**: false

**スコープ**:
- 含む: `tailscale serve` が付ける本人情報、Tailscale を経由しないリクエストの扱い
- 含まない: 複数人での利用

**実装内容**:
1. `tailscale serve` で配信した小さなサーバーで、届いたリクエストのヘッダーを記録する
2. 自分の端末と、別のアカウントの端末からアクセスし、ログイン名を比べる
3. 偽の本人情報のヘッダーを付けたリクエストを端末から送り、サーバーに届いた値を確かめる
4. サーバーをループバックだけで待ち受けさせ、別の端末から Mac のアドレスへ直接送っても届かないことを確かめる

**必要なリソース**:
- 技術: `tailscale serve`
- 環境: Tailscale につないだ Mac と端末。別のアカウントの端末 (Mac を共有して用意する)
- データ: なし

**成功基準**:
- リクエストから Tailscale のログイン名が取れ、別のアカウントでは別のログイン名になる
- 偽のヘッダーを付けて送っても、サーバーには Tailscale が付けた値が届く
- Mac の外からは、Tailscale を経由しないとサーバーに届かない

**判断**:
- 成功 → ヘッダーの本人情報で判定する
- 失敗 → Tailscale のローカル API に接続元の持ち主を問い合わせる

### PoC: 目次などを更新する AI の費用
<!-- POC_STATUS: id=summary-ai-cost, blocker=false, status=verified, confidence=manual -->

**id**: summary-ai-cost
**目的**: 目次・決まったこと・質問の一覧を AI の番ごとに別の AI で更新したときの、時間と利用枠を測る
**risk**: low
**blocker**: false

**スコープ**:
- 含む: 小さいモデルでの更新 1 回の時間とトークンの量
- 含まない: 更新した内容の質の評価

**実装内容**:
1. 20 往復と 100 往復の会話の記録を用意する
2. 小さいモデルに、目次・決まったこと・質問の一覧を更新させ、時間とトークンの量を記録する
3. 会話の本体が最後の番で使ったトークンの量と比べる

**必要なリソース**:
- 技術: Claude Agent SDK (TypeScript)
- 環境: Claude Code にログイン済みの Mac
- データ: 20 往復と 100 往復の会話の記録

**成功基準**:
- 100 往復の会話でも、更新 1 回が 10 秒以内
- 更新 1 回に使うトークンが、同じ番で会話の本体が使ったトークンの 1 割以内

**判断**:
- 成功 → AI の番ごとに更新する
- 失敗 → 開発者が開いたときに更新する

### PoC: Vite+ と Node.js の構成
<!-- POC_STATUS: id=vite-plus-node-stack, blocker=true, status=verified, confidence=0.85 -->

**id**: vite-plus-node-stack
**目的**: React の SPA、Node.js で動く Hono の API、SQLite を、Vite+ の 1 つのプロジェクトとして開発・テスト・ビルドできることを確かめる。Cloudflare には依存しない
**risk**: low
**blocker**: true

**スコープ**:
- 含む: `vp dev` での同時起動、`vp test`、`vp check`、`vp build`、Node.js での起動、SQLite (Drizzle ORM)、WebSocket、ネイティブの部品、レイヤの境界の lint
- 含まない: 認証、アプリの機能

**実装内容**:
1. `fullstack-worker-template` を一時ディレクトリに写し、Cloudflare に依存する部分を外して、Node.js で動く Hono と SQLite に置き換える
2. サーバーから擬似端末の部品で 1 つのコマンドを動かす API を足す
3. `vp dev`、`vp test`、`vp check`、`vp build` を実行し、ビルドの成果物を `node` で起動する
4. API から画面へ WebSocket でイベントを流し、ブラウザで受け取る
5. レイヤの境界を破る import を 1 つ置き、`vp check` が失敗することを確かめる

**必要なリソース**:
- 技術: Vite+ (`vp`)、pnpm、Hono、SQLite、Drizzle ORM、React 19、擬似端末の部品
- 環境: Node.js
- データ: なし

**成功基準**:
- `vp dev` の 1 回の起動で、SPA のホットリロードと API の再読み込みの両方が効く
- `vp test` で、画面のテストとサーバーのテスト (本物の SQLite) が通る
- `vp build` の成果物を `node` で起動すると、SPA と API と WebSocket が 1 つのポートで動く
- ビルドの成果物から、ネイティブの部品 (SQLite のドライバ、擬似端末) が動く
- レイヤの境界を破る import を置くと、`vp check` が失敗する

**判断**:
- 成功 → この構成でプロジェクトを作る
- 失敗 → 開発のときだけ API を別のプロセスで動かす

### PoC: 会話の記録の保存の期間
<!-- POC_STATUS: id=session-retention, blocker=false, status=verified, confidence=0.9 -->

**id**: session-retention
**目的**: Claude Code が会話の記録を消す期間を、設定で延ばせることを確かめる
**risk**: medium
**blocker**: false

**スコープ**:
- 含む: 記録を消す期間の設定、設定を渡す方法 (ユーザーの設定を書き換えずに、アプリの実行にだけ効かせられるか)
- 含まない: 記録の形式

**実装内容**:
1. Claude Code の設定の公式ドキュメントで、記録を消す期間の設定の名前と、取りうる値を確かめる
2. アプリの実行にだけ、その設定を渡す方法を確かめる
3. 設定を渡した実行で、設定が効いていることを確かめる

**必要なリソース**:
- 技術: Claude Agent SDK (TypeScript)
- 環境: Claude Code にログイン済みの Mac
- データ: なし

**成功基準**:
- 記録を消さない設定か、1 年以上の期間の設定を、アプリの実行に渡せる
- ユーザーの `~/.claude` の設定を書き換えずに済む

**判断**:
- 成功 → 会話の識別子だけを保存し、記録を消さない設定で動かす
- 失敗 → 会話の記録をアプリの側へ複製し、消えた会話は要約を付けた新しい会話で続ける

### PoC: 番ごとの利用量
<!-- POC_STATUS: id=usage-per-turn, blocker=false, status=verified, confidence=0.95 -->

**id**: usage-per-turn
**目的**: 番の終わりのイベントが持つトークンの数と料金が、1 回の番の値か、実行を始めてからの累計かを確かめる
**risk**: low
**blocker**: false

**スコープ**:
- 含む: 番の終わりのイベントの利用量の値の意味
- 含まない: 利用量の画面の見た目

**実装内容**:
1. 1 つの実行で指示を 2 回送り、番の終わりのイベントを 2 件記録する
2. 2 件の値を比べ、2 件目が 1 件目を含むかを確かめる

**必要なリソース**:
- 技術: Claude Agent SDK (TypeScript)
- 環境: Claude Code にログイン済みの Mac
- データ: なし

**成功基準**:
- 値が番ごとか累計かが分かる

**判断**:
- 番ごと → そのまま足し合わせる
- 累計 → 同じ実行の 1 つ前の値との差を番の値とする

### PoC: ランナーの子プロセスの後始末
<!-- POC_STATUS: id=runner-child-cleanup, blocker=false, status=verified, confidence=0.9 -->

**id**: runner-child-cleanup
**目的**: Claude Code の子プロセスの PID を取り、ランナーの次の起動で止められることを確かめる
**risk**: medium
**blocker**: false

**スコープ**:
- 含む: 子プロセスの PID の取得と記録、次の起動での停止
- 含まない: Mac 全体の再起動

**実装内容**:
1. 子プロセスの起動を差し替える口から PID を取り、ファイルに記録する
2. ランナーを強制終了し、次の起動で、記録した PID のプロセスを止める
3. 止めたあとに会話を再開し、記録が欠けていないことを確かめる

**必要なリソース**:
- 技術: Claude Agent SDK (TypeScript)
- 環境: Claude Code にログイン済みの Mac
- データ: 一時ディレクトリの Git リポジトリ

**成功基準**:
- 強制終了のあとに残った子プロセスを、次の起動で止められる
- 止めたあとの再開で、会話の記録が欠けない

**判断**:
- 成功 → PID の記録で止める
- 失敗 → プロセスの一覧から、会話の識別子を引数に持つものを探して止める

## 技術スタック（案）

`fullstack-worker-template` の構成を出発点にし、Cloudflare に依存する部分を Node.js の部品に置き換える。

| レイヤー | 技術 | 選定理由 |
|----------|------|----------|
| ツール | Vite+ (`vp`)、pnpm、lefthook | テンプレートと同じ。開発・テスト・lint・ビルドを `vp` に揃える |
| 画面 | React 19 (SPA)、React Router、SWR、Tailwind CSS v4 | テンプレートと同じ |
| 画面のバッファ | CodeMirror 6、`@replit/codemirror-vim` | UI スケッチで、すべてのウィンドウを Vim のバッファとして動かせた |
| サーバー | Node.js、Hono | テンプレートの Hono を、Workers ではなく Node.js で動かす。Mac Studio に常駐させるため |
| AI の実行 | Claude Agent SDK (TypeScript) | 第一候補。PoC `agent-sdk-conversation` の結果で決める |
| データ | SQLite、Drizzle ORM | テンプレートの D1 と Drizzle を、ローカルの SQLite に置き換える。1 台で動かすので別のデータベースのサーバーが要らない |
| 画面との通信 | WebSocket | AI の出力と状態の変化を、開いている画面へすぐ届けるため |
| 検証と型 | Zod、neverthrow、ulid | テンプレートと同じ |
| テスト | Vitest (`vp test`)、Testing Library、Playwright | テンプレートと同じ。サーバーのテストは本物の SQLite を使う |
| 認証 | Tailscale の本人情報 | テンプレートの自前の認証 (パスワードと確認コード) は使わない |
| 通知 | Web Push | PoC `web-push-tailscale` の結果で決める |
| ターミナル | 擬似端末と、ブラウザのターミナルの部品 | 広く使われている作り |

## 次のステップ

1. [x] blocker=true の PoC 7 件を検証する (dev-spec のフェーズ 5)
2. [x] blocker=false の PoC 3 件を検証する

## PoC 結果

### usage-per-turn — verified (confidence 0.95)
- 検証日: 2026-11-28
- 観測した事実: Claude Agent SDK 0.3.332 と Claude Code 2.1.332 を使い、既知のトークン数を返すローカル Messages API に接続した。同じ実行で 2 番を送り、同じ会話の再開と、その会話から分岐したスレッドでも各 1 番を送った。4 番の `result.usage` の入力は 201、102、53、43 で、各番の応答と一致した。出力とキャッシュの作成・読み取りも各番の応答に一致した。同じ会話の `result.total_cost_usd` は 0.00036335、0.00052980、0.00062445 で、再開をまたいで累計になった。分岐先の最初は 0.00007445 で、その番の料金だけだった
- 結論: トークン数は番ごと、料金は会話ごとの累計だった。スレッドには元の会話の料金が継承されなかった。既知の応答を使って SDK の集計を検証した
- 推奨アプローチ: トークンは各番の値を足す。料金は、同じ会話の前の番との差を足す。集計の開始時刻より前の番も料金の差の基準にする。スレッドの料金の差を求めてから、元の会話の利用量に足す


### agent-sdk-conversation — verified (confidence 0.88)
- 検証日: 2026-11-26
- 観測した事実: Agent SDK 0.3.332 で 1 つの会話に 4 つの指示を順に送り、読み取り・編集・コマンドの実行・発言・番の終わりが発生した順に届いた。編集の差分は行単位で取れた。プラグインの skill と `~/.claude/skills` の skill の両方が、スラッシュコマンドで端末と同じに動いた。`/dev-spec` は端末と同じ最初の手順 (回し方を選ぶ質問) まで進んだ。選択式の質問 2 問に、選択 1 つと文章 1 つをまとめて返すと、AI が続きを行った。許可の確認は、質問のとき以外は 1 度も出なかった。追加で、アプリが定義したツール (issue の読み書きの見本) を AI が呼べること、タイムラインのプラグインのツールが動き、タスクの木が `~/.claude/timeline/sessions/<会話の識別子>.json` に保存されること、許可の確認を 60 秒待ってから許可・拒否できることを確かめた。認証は Claude Code のログイン (サブスクリプション) で動いた
- 結論: 成功基準 4 つをすべて満たした
- 推奨アプローチ: Agent SDK (@anthropic-ai/claude-agent-sdk 0.3.x) を実行方式にする。1 つの会話を query({ prompt: AsyncIterable<SDKUserMessage>, options }) の streaming input で開き、開発者の指示は { type:'user', message:{ role:'user', content }, parent_tool_use_id:null, origin:{ kind:'human' } } として送る。options は cwd に worktree、permissionMode:'bypassPermissions' と allowDangerouslySkipPermissions:true、includePartialMessages:true、canUseTool を指定する。settingSources は省略し、~/.claude の skills・プラグイン・CLAUDE.md・hooks を端末と同じに読み込む。skills は '/dev-spec ...' のように指示の文字列で送れば呼び出せる。補完の一覧は supportedCommands() か system:init の slash_commands / skills で取る。画面に出す種類は次のメッセージで分ける。発言: type 'assistant' の content の text (逐次表示は stream_event の content_block_delta / text_delta)。ツールの実行: type 'assistant' の content の tool_use (id, name, input) と、type 'user' の content の tool_result。この 2 つは tool_use_id で対応づける。差分: tool_result と一緒に届く user メッセージの tool_use_result。Edit では structuredPatch (hunk ごとの oldStart / newStart / lines)、Write では type が 'create' なら content 全体、'update' なら structuredPatch を使う。番の終わり: type 'result' (subtype success / error_*、total_cost_usd、permission_denials)。選択式の質問は canUseTool(toolName === 'AskUserQuestion') で input.questions を画面に渡す。開発者の回答がそろうまで Promise を保留し、{ behavior:'allow', updatedInput:{ questions, answers: { [question]: 選んだ label または自由記述の文字列 } } } を 1 回で返す。それ以外の toolName で canUseTool が呼ばれたとき (bypassPermissions でも、settings.json の ask ルールや、重要なパスへの rm は canUseTool に回る) は allow を返すか、画面で確かめる。どちらにするかは設計で決める。system:init は番ごとに届き、rate_limit_event も流れに混ざるので、知らない type は読み飛ばす。SDK のメッセージの流れには、開発者が送った指示 (スラッシュコマンドを展開した skill の本文を含む) は出てこないので、画面にはアプリが送った文字列を自分で出す。追加の 4 項目から設計へ渡すこと。(1) アプリが管理する issue は、createSdkMcpServer({ name, version, tools: [tool(name, description, zod の形, handler)] }) で作ったプロセス内の MCP サーバーを options.mcpServers に渡す。AI からは mcp__<サーバー名>__<ツール名> (例 mcp__issues__issue_get) として見え、handler の戻り値 { content: [{ type: "text", text }], isError? } がそのまま tool_result になる。ツールは既定で後から読み込まれ、AI は先に ToolSearch で探す。毎回確実に使わせたいツールは tool() の 5 番目の引数 { alwaysLoad: true } を検討する。(2) timeline プラグインは、ユーザー設定を読み込んだ SDK の会話でも端末と同じに読み込まれ、mcp__timeline__timeline_tasks / mcp__timeline__timeline_read を AI が呼べる。タスクの木は、セッションごとに ${CLAUDE_CONFIG_DIR または $HOME/.claude}/timeline/sessions/<session_id>.json に保存される。形は { version: 1, journal: [{ at, toolUseId, agentId?, ops: [{ op: add|update|remove, id, parent?, title?, status?, weight?, description?, note?, done? }] }], reports: [{ at, text }], comments: [] } で、木は journal の ops を順に適用して作り直す。アプリの画面は、このファイルか、流れてくる timeline_tasks の tool_use の input から木を組める。ただしタイムラインの区画を開く画面 ($.ui) は端末の画面にしかない。(3) bypassPermissions を使わない設定では、permissionMode: "default" と canUseTool を指定する。許可の確認は canUseTool(toolName, input, { signal, suggestions, displayName, title?, decisionReason?, blockedPath? }) で届き、{ behavior: "allow", updatedInput } か { behavior: "deny", message } を返す。返すまで AI は待つ (60 秒待っても失敗しなかった。型定義には、許可の確認には待ちの期限が無いとある)。拒否は tool_result の is_error と result.permission_denials に出る。ユーザー設定の permissions.defaultMode が bypassPermissions でも、SDK に渡した permissionMode が優先された。(4) 今回の PoC は Claude Code のログイン (サブスクリプション) で動いた。公式ドキュメントは、サブスクリプションのログインを第三者の製品で提供することを、事前の承認がない限り認めていない (原文は investigation_steps の最後)。本人が自分の Mac で自分のアカウントで使う場合がこの制限に当たるかは、ドキュメントに書かれていない。どの認証で動かすかは、設計で決める必要がある

### agent-sdk-resume — verified (confidence 0.85)
- 検証日: 2026-11-26
- 観測した事実: 会話の識別子をファイルに保存してプロセスを終了し、別のプロセスから再開すると、合言葉を答えた。再開しない新しい会話は合言葉を知らなかった (陰性対照)。再開の前に、それまでの会話の記録を読み出せた。worktree を消したあと、メインのリポジトリと、Git 管理外のディレクトリのどちらからも再開でき、合言葉を答えた。追加の観察として、サーバーを強制終了すると、AI を動かす子のプロセスが残って作業を続け、記録へ追記してから終了した。記録を消す期間 (既定 30 日) を延ばす設定は確かめていない
- 結論: 成功基準 3 つをすべて満たした。記録の保存期間の設定は未検証で、実装で確かめる
- 推奨アプローチ: 会話の識別子 (session ID) と、いまの作業ディレクトリだけをアプリ側に保存する設計で進める。再開は query({ prompt, options: { resume: sessionId, cwd } }) で行い、別プロセスからでも、作業ディレクトリを変えても、元の worktree を消したあとでも同じ文脈で続く。開始時は Options.sessionId に自分で UUID を渡せば、最初のメッセージを待たずに ID を保存できる (型定義で確認、PoC 未実施)。画面に出す記録は getSessionMessages(sessionId) で読み、JSONL を直接読まない (形式は内部仕様)。注意点は 5 つ。(1) resume しても許可の設定・allowedTools・MCP・追加ディレクトリなどは戻らないので、再開のたびに同じ options を渡す。(2) 再開後の作業ディレクトリは渡した cwd になり、getSessionInfo().cwd は最初の cwd のまま変わらないので、いまの作業ディレクトリはアプリ側で持つ。(3) 1 つの会話を同時に 2 つのプロセスで再開しない (1 つの記録に 2 か所から書き込み、記録が欠ける)。サーバーを強制終了すると子の Claude Code プロセスが孤児として作業を続けて記録へ追記するため、起動時に前回の子プロセスを止めてから再開する (spawnClaudeCodeProcess で子の PID やプロセスグループを管理する案は未検証)。(4) 記録は既定 30 日 (cleanupPeriodDays) で消える (未検証)。保存期間を延ばすか、sessionStore で記録を複製する。(5) 作業ディレクトリをまたぐ再開には同梱 CLI 2.1.223 以降が要る (今回は SDK 0.3.332 / CLI 2.1.332)

### agent-sdk-interrupt — verified (confidence 0.85)
- 検証日: 2026-11-26
- 観測した事実: 前景で動く 30 秒のスクリプトを実行させ、3 秒後に止めると、16 ミリ秒後にその番が終わり、1 秒後にはスクリプトのプロセスも消えていた。止めた直後の指示に、止めたコマンドと最初に伝えた合言葉を正しく答えた。作業中に預かった 2 件を、番の終わりを受けてから 1 通につないで送ると、1 回の応答で両方に答えた。バックグラウンドへ移ったコマンドは、止める操作では止まらず、終わったときに AI の番が自動で始まった
- 結論: 成功基準 3 つをすべて満たした。バックグラウンドのコマンドを止める操作は型定義で確かめただけで、実装で確かめる
- 推奨アプローチ: 停止は Query.interrupt() で作る。ストリーミング入力 (prompt に非同期ジェネレーターを渡す) が前提で、呼ぶとフォアグラウンドのツールのプロセスごと数十 ms で止まり、その番は result (subtype=error_during_execution) で終わる。セッションはそのまま開いているので、止めた直後の指示は通常の SDKUserMessage として同じ入力ストリームに流せば、中断前の文脈を保って答える。作業の終わりは result メッセージ (success / error_*) で判定する。uuid を付けて送った指示は、command_lifecycle (queued → started → completed) で届いた時点を追える。預かりは、アプリ側で指示を保持し、result を受けた時点で 1 通に連結して送る方式を正とする (どのメッセージが何に答えたかがアプリから決まる)。SDK の priority:'later' でも、番の終わりまで保持して 2 件を 1 つの番でまとめて届けられることを確認しており、代替として使える。注意点が 3 つある。(1) interrupt() はバックグラウンドへ移ったシェルの実行を止めない。その完了通知で AI の番が自動で始まるので、停止操作では background_tasks_changed / task_started で追跡している task_id に stopTask(taskId) も呼ぶ。stopTask は PoC で未検証 (AI が TaskStop ツールで止められることは確認済み)。(2) priority:'now' は停止の手段に使わない。origin なしでは 2.1.332 で実行中のツールの終了まで待たされ、origin:human ではコマンドをバックグラウンドに移して指示を割り込ませる動きになる。(3) 作業中に送った指示は、priority を付けないか 'next' にすると実行中のツールが終わった時点で同じ番に入り、'later' だと番の終わりまで待たされる。どちらもエラーにはならない。

### agent-sdk-thread — verified (confidence 0.9)
- 検証日: 2026-11-26
- 観測した事実: 元の会話から分岐した会話を 3 通り (会話の完了後、作業中に 2 通り) 作り、どれも分岐の前の合言葉を答えた。元の会話は、分岐した会話で伝えた合言葉を知らず、記録にもその文字列は無かった。分岐した会話で、ファイルの読み取りとコマンドの実行ができた。元の会話が 30 秒のコマンドを実行している途中でも分岐でき、元の会話の作業はそのまま続いて正常に終わった。分岐の作成は数ミリ秒で終わった
- 結論: 成功基準をすべて満たした。分岐は会話の履歴だけを分け、ファイルは元の会話と共有する
- 推奨アプローチ: スレッドの作成には SDK の forkSession(元の会話の ID, { dir: <元の会話の cwd> }) を使う。この関数は API を呼ばずに数 ms で新しい会話の ID を返すので、その ID をスレッドの識別子として先に保存する。スレッドへの最初の指示とそれ以降の指示は、どれも query({ options: { resume: <スレッドの ID> } }) で送る (forkSession オプションは付けない)。この形なら、元の会話が AI の作業中でも分岐できる。ただし作業中に分岐すると、実行途中のツール呼び出しが「中断され結果不明」としてスレッドに写る。それを避けたい場合は、最後に完了したメッセージの uuid を upToMessageId に渡して、その位置で切る (この指定は今回の PoC では試していない)。分岐は会話の履歴だけを分け、ファイルは共有するので、スレッドでの編集は元の会話の worktree に実際に反映される。スレッドで行えることを読み取りとコマンドの実行に絞るかどうかは、設計で決める

### codemirror-vim-buffer — verified (confidence 0.85)
- 検証日: 2026-11-26
- 観測した事実: スケッチと同じ装飾の 1 万行を出し、0.1 秒ごとに追記しながら操作した。開くまでは最大 80 ミリ秒、操作から描画までは最大 21 ミリ秒だった。追記を transaction の dispatch で行う作りでは、カーソルの位置、スクロールの位置、入力途中の回数の指定、ビジュアルモード、検索の入力欄がすべて保たれた。スケッチの作り (追記のたびにエディターの状態を作り直す) では、時間の基準は満たしたが、入力途中の回数の指定・ビジュアルモード・検索の入力欄が消え、スクロールの位置も飛んだ。会話 10 本を同時に更新する負荷と、途中の行の書き換えは試していない
- 結論: 成功基準 3 つを、追記を dispatch で行う作りで満たした。スケッチの作りのままでは状態の基準を満たさないので、状態の更新のしかたを変えて実装する
- 推奨アプローチ: 成功基準 3 つは dispatch の作りで満たした。スケッチの作り (追記のたびに EditorState を作り直して setState する) は、時間の基準は満たすが状態の基準を満たさない。入力途中の回数・g・ビジュアルモード・検索の入力欄が消え、スクロール位置も飛ぶ。そのため FEASIBILITY.md の判断にある『スケッチの作りのまま実装する』は当てはまらず、状態の更新のしかたを次のように変えて実装する。(1) EditorView と EditorState は開くときに 1 度だけ作り、追記では setState を呼ばない。(2) 行の情報 (種類・桁・印など) と DecorationSet を 1 つの StateField に持ち、EditorView.decorations.from(field) で装飾を渡す。ガターの lineMarker とカーソルを置けない行の判定は、閉じ込めた配列ではなく view.state.field(...) から行を読む。(3) 追記は『changes: 文書末尾への改行 + 行の文字列の挿入』『effects: 新しい行の情報を載せた StateEffect』『annotations: 追記用の Annotation』を 1 つの transaction にして dispatch する。scrollIntoView と selection は付けない。(4) 読み取り専用は EditorState.readOnly と EditorView.editable(false) に加えて、changeFilter で『追記用の Annotation が付いた transaction だけ通す』にする。filter:false は他の拡張の transactionFilter まで止めるので使わない。(5) StateField の update では、DecorationSet を tr.changes で map し、前の最終行の先頭から文書末尾までを filterFrom/filterTo で消して、その範囲の装飾を作り直して add する。前の最終行を作り直すのは、発言の帯の終わり (turn-z)・メニューの枠の終わり (act-z)・下の隙間が次の行で決まるためである。発言の持ち主は、作り直す範囲の手前から発言者の札か区切りの行まで遡って求める。(6) React の Buffer は行の配列全体の sig を比べて作り直すのをやめ、届いた行の差分 (末尾の追加) を dispatch に変える

### usage-limit-detect — verified (confidence 0.7)
- 検証日: 2026-11-26
- 観測した事実: Agent SDK の型定義と公式ドキュメントで、利用枠の状態を知らせるイベントの形を確かめた。状態は 3 種類 (余裕がある / 残りが少ない / 上限に達した) で、枠が戻る時刻が秒単位で入る。実際に 1 回の会話を動かし、このイベントを受け取り、枠が戻る時刻が入っていることを確かめた。この Mac の会話の記録 1982 件に、利用枠切れの実例は無かった。実際に利用枠を使い切った状態は起こしていない
- 結論: 利用枠切れとほかのエラーを区別する手段と、戻る時刻の取得は確かめた。上限に達したときのイベントの実物は未観測で、実装の初期にログを残して確かめる
- 推奨アプローチ: SDK のメッセージの流れで rate_limit_event を見張り、最後に受けた rate_limit_info を会話ごとに持っておく。利用枠切れは rate_limit_info.status === 'rejected' で判定する。ただし overageStatus が 'allowed' / 'allowed_warning' なら超過分の利用で続くので、利用枠切れとは扱わない。errorCode === 'credits_required' (クレジットの購入が要る) は、時刻を待っても戻らないので自動では再開しない。ほかの失敗とは次の値で分ける。assistant メッセージの error が 'overloaded' / 'server_error' / 'authentication_failed' / 'billing_error' / 'account_on_hold' などの場合と、result の terminal_reason === 'api_error' かつ api_error_status が 429 以外の場合は、利用枠切れではない。assistant の error === 'rate_limit' だけでは判定しない (クレジット不足の 429 にも付くため)。戻る時刻は rate_limit_info.resetsAt (Unix 秒。Date にするには 1000 倍する) を使い、その時刻に自動で再開する。resetsAt は型の上で省略可能なので、無いときは一定の間隔 (例: 15 分) で再開を試みる。エラーの本文にある 'resets 3:45pm' のような表示用の文字列は、日付が無く地域で書式が変わるので解析しない。usage_EXPERIMENTAL_... は experimental なので、使っても画面の表示の補助に留める。実際のイベントに付いていた unifiedWindows は型定義に無いので、これにも依存しない

### tailscale-identity — verified (confidence 0.9)
- 検証日: 2026-11-26
- 観測した事実: 0.0.0.0 で待ち受けるサーバーに、この Mac と、別の Tailscale の端末からリクエストを送り、接続元の IP アドレスの持ち主を Tailscale のローカル API に問い合わせると、ログイン名が取れた。問い合わせは 1 回 1 ミリ秒未満だった。127.0.0.1 と LAN の IP アドレスからのリクエストは、Tailscale の範囲に入らないので拒否できた。本人情報のヘッダーを偽っても、判定は変わらなかった。別のアカウントの端末からの確認はしていない
- 結論: 成功基準 2 つを満たした。`tailscale serve` を使わない構成で、本人の判定ができる
- 推奨アプローチ: tailscale serve のヘッダーではなく、ローカル API に接続元の持ち主を問い合わせて本人を判定する。リクエストごとに (a) ソケットの接続元 IP アドレス (::ffff: を除いたもの) が 100.64.0.0/10 に入るかを見て、外れたら whois を呼ばずに拒否する (tailnet 外の whois は失敗まで約 375 ms かかるため、先に弾く)。(b) 入っていれば 127.0.0.1:<ipnport> の /localapi/v0/whois?addr=<ip>:<port> を Basic 認証 (ユーザー名は空、パスワードは sameuserproof-<port> の中身) で呼び、Host: local-tailscaled.sock を付ける。(c) 200 で返った UserProfile.LoginName が許可するアカウントと一致すれば通し、それ以外 (404・接続失敗・不一致) は拒否する。X-Forwarded-For などのヘッダーは判定に使わない。ポート番号とトークンは Tailscale の再起動で変わるので、起動時に固定せず、認証失敗や接続失敗のときに /Library/Tailscale/ipnport と sameuserproof-<port> を読み直す。tailscale whois --json を毎回起動する方法でも動くが 1 回 30-45 ms かかるので、ローカル API の HTTP 呼び出し (1 ms 未満) を使う。0.0.0.0 (IPv4 のみ) で待ち受ける限り Tailscale の IPv6 (fd7a:115c:a1e0::/48) からは届かないので、IPv4 の範囲だけを見ればよい。:: で待ち受けるように変えるときは IPv6 の範囲も足す 残る論点: (1) この Mac の上で動く別のプロセスが Tailscale の IP アドレスから接続すると、この Mac の持ち主として扱われる (1 人で使う前提では問題にならない)。(2) LAN 上の攻撃者が接続元を 100.x に偽った TCP 接続は、応答が Tailscale 側に向かうためハンドシェイクが成立しない想定だが、PoC では確かめていない。必要なら接続先 (req.socket.localAddress) がこの Mac の Tailscale の IP アドレスであることも条件に足す。(3) ローカル API の sameuserproof 方式は Tailscale の内部実装で、公開された安定 API ではない。

### web-push-tailscale — fallback_adopted (判断: エージェント。ユーザーの就寝中に委任を受けて決め、起床後に確認する)
- 検証日: 2026-11-26
- 観測した事実: `http://macstudio:<port>` と Tailscale の IP アドレスのどちらで開いても、Chrome は安全なオリジンと扱わず、Service Worker が使えず、通知の許可も拒否になった。`http://localhost` では、購読・送信・ページを閉じた状態での受信・通知の表示・通知の取り下げまで通った。Chrome の例外指定 (`chrome://flags/#unsafely-treat-insecure-origin-as-secure` にアプリのオリジンを登録) をすると、`http://macstudio:<port>` でも Service Worker の登録・許可・購読が通った。通知を選んだときに該当の画面が開くことと、OS の通知センターへの表示は、ヘッドレスのブラウザでは確かめられなかった。iPhone は対象から外した (ユーザーの決定)
- 結論: 当初案 (Tailscale の HTTPS で配信して Web Push を使う) は、`tailscale serve` を使わないというユーザーの決定で前提が無くなった。HTTPS ではない `http://macstudio:<port>` のままでは、ブラウザの通知は使えない
- 推奨アプローチ: HTTP のまま http://macstudio:<port> を開くと、Chrome は Service Worker も通知の許可も使えない (実測: isSecureContext=false、navigator.serviceWorker なし、Notification.permission=denied)。PC の Chrome だけを対象にする今の範囲では、使う PC の Chrome で chrome://flags/#unsafely-treat-insecure-origin-as-secure にアプリのオリジン (例 http://macstudio:<port>、ポートまで一致させる) を登録して Web Push (VAPID、web-push パッケージ) で作るのを推奨する。理由: 例外指定で SW 登録・許可・購読 (FCM) が通ることを実測し、Tailscale の設定も証明書の管理も要らない。購読から送信・push イベント・通知の表示・取り下げまでは localhost で実測した。取り下げは Web Push の仕組みに無いので、取り下げ用の push を送り、SW が同じ tag の通知を getNotifications で探して close() する形で作る。この push で通知を 1 件も出さないと Chrome が代わりの通知を出すことがあるので、本実装で挙動を確かめる。本実装で確かめること: 通知を選んで該当の画面が開くこと (notificationclick → clients.openWindow、headless では未確認)、OS の通知センターに出ること、例外指定の操作を chrome://flags から行っても起動オプションと同じに効くこと。スマホ対応を再開すると iPhone の Safari には例外指定の手段が無い。そのときは HTTPS の証明書 (fallback の B) を持たせる必要がある
- 採用した判断: fallback 採用。通知は Web Push で作り、ページが安全なオリジンとして開かれているとき (Chrome の例外指定をしたとき、または HTTPS で開いたとき) だけ有効にする。そうでないときは、アプリを開いているあいだの画面の中のお知らせとタブの題名の印で知らせ、設定の画面に通知を有効にする方法を出す。例外指定と証明書のどちらを使うかを決めなくても実装でき、あとからどちらにも進めるため
- fallback: 採用した代替案は上のとおり。当初案 (Tailscale の HTTPS) は、`tailscale serve` を使わない決定と、証明書の発行でマシン名が公開の記録に残る点から採らなかった

### summary-ai-cost — verified (判断: エージェント。ユーザーの就寝中に委任を受けて決め、起床後に確認する)
- 検証日: 2026-11-26
- 観測した事実: 20 往復の見本の会話で、小さいモデルに目次・決まったこと・質問の一覧を更新させた。前回の一覧と新しい 1 往復だけを渡し、変更点だけを出させてアプリが一覧に当てる形は、1 回 3.4〜6.1 秒で、20 回とも 10 秒以内だった。一覧の全体を出し直す形は、14 往復目から 10 秒を超えた。会話の全部を渡す形は 1 回 18〜25 秒だった。更新 1 回のトークンは 2,000〜5,200 だった。会話の本体は、端末と同じ設定では 1 回の呼び出しごとに約 4 万 7 千トークンの固定の入力が乗るので、変更点だけを出させる形の 20 回の合計は、会話の本体が使う量の約 7% と見積もった (本体の量は 1 回の呼び出しの実測からの見積もり)。100 往復の会話では測っていない
- 結論: 時間の基準は、変更点だけを出させる形で満たした。トークンの基準 (同じ番で会話の本体が使ったトークンの 1 割以内) は、見積もりでは満たす。確信度は 0.65 で、自動の解決の基準 (0.7) に届かない
- 推奨アプローチ: AI の番が終わるたびに、Haiku をツールなし (tools: [])・settingSources: []・persistSession: false・maxTurns: 1・effort: 'low' で呼び、title を必ず渡して題名を作る補助の呼び出しを止める。入力は前回の目次・決まったこと・質問の一覧 (各項目に番号を付ける) と新しい 1 往復だけにし、出力は変更点 (目次の追加、決まったことの追加と書き換え、質問の追加と回答済みにする番号) だけにして、アプリが索引に当てる。この形で 1 回 3.4〜6.1 秒、入力+出力 2,000〜5,200 トークンだった。トークンの成功基準は分母を「会話の本体が実際に使うトークン」に直すことを呼び出し側で判断する。20 往復の会話の文字に対する 1 割は、SDK を使う限り構造的に満たせない。索引の全体を出し直す形は、決まったことが増えると出力が伸びて 14 往復目あたりから 10 秒を超えるので使わない
- 採用した判断: この結果で採用。AI の番ごとに、変更点だけを出させる形で更新する。blocker ではなく、合わなければ更新の間隔を空ける代替案へ切り替えられるため

### vite-plus-node-stack — verified (confidence 0.85)
- 検証日: 2026-11-26
- 観測した事実: テンプレートから Cloudflare に依存する部分を外し、Node.js で動く Hono、SQLite (`better-sqlite3` と Drizzle ORM)、WebSocket (`ws`)、擬似端末 (`node-pty`) に置き換えた。`vp dev` の 1 回の起動で、SPA のホットリロードと API の再読み込みが効き、再読み込みのあともデータベースの接続と WebSocket の購読が保たれた。`vp test --run` で、画面のテスト 2 件とサーバーのテスト 2 件 (本物の SQLite と擬似端末) が 1 つの設定で通った。`vp build` の成果物を `node` で起動すると、SPA・API・WebSocket・擬似端末が 1 つのポートで動いた。レイヤの境界を破る import を 2 つ置くと `vp check` が失敗し、消すと通った。擬似端末の部品は、導入のあとに補助の実行ファイルへ実行権限を付けないと動かなかった。Drizzle ORM の安定版には Node.js 組み込みの SQLite のドライバが無かった
- 結論: 成功基準をすべて満たした
- 推奨アプローチ: Vite+ の 1 プロジェクトで、開発中は 1 プロセスにする。vite.config.ts に @hono/vite-dev-server を entry: 'src/server/dev.ts'、exclude: [/^(?!\/api(\/|$)).*/]、injectClientScript: false で置き、/api だけを Hono に渡す。WebSocket は Hono の upgradeWebSocket を使わず、ws の WebSocketServer({ noServer: true }) を包んだ upgrade ハンドラを 1 つ作る。開発中は自作の Vite プラグインが httpServer の 'upgrade' でそのハンドラを呼び、本番は @hono/node-server の serve() の戻り値に同じハンドラを付ける。DB 接続・イベントの配信・upgrade ハンドラはプロセスに 1 つの module (src/server/runtime.ts) に置き、API のファイルを編集しても保たれるようにする。ビルドは vite.config.ts の environments (client → dist/client、server → dist/server、consumer: 'server'、input: src/server/main.ts) と builder.buildApp で、vp build 1 回にまとめる。本番は node dist/server/main.js で、serveStatic で dist/client を配り、/api と /ws も同じポートで受ける。better-sqlite3 と node-pty は成果物に同梱せず、node_modules から読み込む (FEASIBILITY の代替案 3 と同じ形)。なので配置先には node_modules が要る。テストは test.projects で 1 つの設定にまとめる (front: jsdom + setupFiles + globals、server: node + 本物の SQLite :memory:)。SQLite のドライバは better-sqlite3 を推奨する


### runner-child-cleanup — verified (confidence 0.9)
- 検証日: 2026-11-27
- 観測した事実: SDK 0.3.332 と Claude Code 2.1.332 を Mac で動かした。起動の差し替え口で子プロセスの PID を記録できた。ランナーの強制終了後も子プロセスは生きていた。次の起動の後始末でその子を停止し、PID のファイルを空にできた。停止前の記録 3 件は、再開後もすべて同じ識別子で残った。再開した AI は、停止前に伝えた合言葉を正しく答えた。
- 結論: PID の記録で孤児の子プロセスを停止でき、同じ会話を再開できる。
- 推奨アプローチ: `spawnClaudeCodeProcess` で起動したプロセスの PID を記録する。次の起動で、その PID のコマンドが Claude Code のものか確認してから停止する。停止後に、保存した会話の識別子と作業ディレクトリで再開する。

### session-retention — verified (confidence 0.9)
- 検証日: 2026-11-27
- 観測した事実: `settings: { cleanupPeriodDays: 36500 }` が起動引数に入り、初期化が完了した。実行中の設定更新でも 36,500 日が受理され、`0` は拒否された。一時的な設定ディレクトリにユーザーの設定ファイルは作られなかった。
- 結論: ユーザーの設定を書き換えずに、アプリの実行だけ保存期間を 1 年以上に延ばせる。
- 推奨アプローチ: 会話の開始と再開で `settings: { cleanupPeriodDays: 36500 }` を渡す。これは実行単位の設定なので、端末の Claude Code の設定ファイルに書き込まない。
