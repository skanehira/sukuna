# worktree とターミナル

- 種別: 機能設計書
- 対象 UC: UC-013 (docs/design/USECASES.md)

## 何を作るか

プロジェクトの worktree を一覧・作成・削除し、会話の作業場所か選んだ worktree でターミナルを開いてコマンドを実行する機能である。

**使う人**: 開発者

**流れ**:

1. Space k で、いまのプロジェクトの worktree の一覧を右のウィンドウに開く。ブランチ、使っている会話と issue が並ぶ
2. 名前を付けて worktree を作る。一覧の行で Enter を押すと、作業場所がその worktree に切り替わる
3. Space g で作業場所のターミナルを開き、コマンドを実行して出力を見る
4. Ctrl+] で Normal モードに移り、出力を Vim の操作で読む。箇所を選んで質問か指示をストックできる。i で入力に戻る
5. 要らなくなった worktree を選んで消す

**主な決まり**:

- 開発者が作った worktree は、開発者が消すまで残す (BR-059)
- 未コミットの変更か、未 push のコミットがある worktree は消さない。何が残っているかを表示する
- 自動フローが issue のために作った worktree は、その issue が閉じるまで開発者も消せない
- ターミナルは、会話が動いているディレクトリか、選んだ worktree で開く (BR-060)
- 開発者が始めた会話の作業場所は、worktree の一覧で切り替えられる。AI が動いているあいだは切り替えない
- ターミナルの入力中は、キーを中のプログラムへ送る。Ctrl+] (割り当てを変えられる) で Normal モードに戻り、Ctrl+[ は Esc としてプログラムへ送る (BR-061、BR-062)
- 画面を閉じても、ターミナルのプログラムは動き続ける。開き直すと続きが出る。ただし、アプリの更新などで画面のサーバーを入れ替えると、ターミナルは終わる
- ターミナルを使えるのは、本人と判定された開発者だけである

## 入出力と振る舞い

### この機能の前提

- worktree の作成と削除、ターミナルは、画面のサーバーが行う。自動フローが issue のために作る worktree の作成と片付けは、ランナーの `flow` が行う (`features/implementation-flow.md`、`features/design-review.md`)。どちらも、下の「作る場所と名前」と「消す」の規則に従う
- 擬似端末は `node-pty`、画面の端末は xterm.js で作る。`node-pty` はビルドの成果物に入れず、`node_modules` から読み込む。導入のあとの実行権限の付与は DESIGN.md「既知の制約」参照
- 画面の部品 (右のウィンドウ、メニューの行、y / n の確認、Normal モードのバッファ) と、キーの割り当ての変え方は `features/buffer-ui.md` に従う
- ストックの持ち方と送り方は `features/stock-thread.md` に従う

### 作る場所と名前

- worktree は `<プロジェクトのパス>/.claude/worktrees/<名前>` に作る。Claude Code が worktree を置く場所と同じにする
- 作る前に、リポジトリの `.git/info/exclude` に `.claude/worktrees/` が無ければ足す。プロジェクトの `.gitignore` は変えない

名前とブランチ:

| 作るもの | 名前 | ブランチ | 正本 |
| --- | --- | --- | --- |
| 開発者が名前を付けて作る worktree | 開発者が書いた名前 | 名前と同じ | 本書 |
| 会話を始めるときに名前を省いて作る worktree (`features/conversation.md` の `new_worktree`) | `chat-<YYYYMMDD-HHMM>` (作った時刻)。同じ名前の worktree かブランチがあれば、`-<k>` (k は 2 から、空いている最小の数) を付ける | 名前と同じ | 本書 |
| 設計の worktree | `design-<issue 番号>`。重なれば `design-<issue 番号>-<k>` | `sukuna/design-<issue 番号>`。名前に `-<k>` を付けたときは同じものを付ける | `features/design-review.md`「設計の作業場所」 |
| 実装の worktree | `issue-<番号>`。重なれば `issue-<番号>-<k>` | `sukuna/issue-<番号>`。名前に `-<k>` を付けたときは同じものを付ける | `features/implementation-flow.md`「worktree を作る」 |

- 開発者が書く名前は 1〜60 字で、英数字と `.`、`_`、`-` だけを使う。先頭は英数字とし、`.lock` で終わる名前と `main` は使えない
- `design-` と `issue-` で始まる名前は、自動フローの worktree のために取っておき、開発者は使えない
- `sukuna` も使えない。自動フローのブランチ (`sukuna/issue-<番号>` など) と同じ名前のブランチは、git が作れないためである
- 元にするのは既定ブランチの最新である。GitHub を使うプロジェクトは `git fetch origin <既定ブランチ>` のあと `origin/<既定ブランチ>` から作る。取得に失敗したら手元の既定ブランチから作り、「GitHub から取得できなかったので、手元の既定ブランチから作りました」のお知らせを出す。GitHub を使わないプロジェクトは手元の既定ブランチから作る
- 同じ名前のブランチがあり、どの worktree でも開かれていなければ、そのブランチで作る。このとき `worktrees.branch_created` を偽にし、ブランチはアプリが作ったものとして扱わない。ブランチを新しく作ったときは真にする。既存のブランチを使うときは fetch を行わず、`notice` は `null` にする
- 本書の作る処理は、作った後に依存の導入などのコマンドを実行しない。実装の worktree に固有の準備は `features/implementation-flow.md` に従う

### 消す

消す要求を受けたら、次の順に確かめ、1 つでも当てはまれば消さずに理由を返す。

| 順 | 当てはまるもの | 返す文の例 |
| --- | --- | --- |
| 1 | プロジェクトのディレクトリそのもの | 「プロジェクトのディレクトリは消せません」 |
| 2 | 自動フローが作り、その issue が完了か取り下げになっていない | 「issue #42 の自動フローが使っています。issue が閉じると片付けられます」 |
| 3 | この worktree で会話の AI が動いている (作業中、質問か許可の確認を待っている) | 「会話: 予約 API の壁打ち の AI が動いています。止めてから消してください」 |
| 4 | git でロックされている | 「この worktree はロックされています: <理由>」 |
| 5 | 未コミットの変更がある (追跡していないファイルを含む。無視するファイルは数えない) | 「未コミットの変更があるため消していません (src/a.ts ほか 2 件)」 |
| 6 | 未 push のコミットがある | 「未 push のコミットがあるため消していません」 |

- 未 push のコミットは、worktree の HEAD から辿れて、どのリモートのブランチにも、手元の既定ブランチにも含まれないコミットとする (`git rev-list --count HEAD --not --remotes refs/heads/<既定ブランチ>`)。リモートの無いプロジェクトでは、既定ブランチに入っていないコミットになる
- ただし、issue の worktree で、HEAD がその issue のどれかの merge 済みの PR の先頭のコミットと同じなら、未 push のコミットは無いとする。squash で merge してリモートのブランチを消すと、手元のコミットがどのリモートのブランチにも含まれなくなるためである
- 照合する PR は、その issue の全部の PR とする。`issues.pr_url` と、`issue_events` の `design_pr_created` の `prUrl`、`reopened_for_fix` の `previousPrUrl` が当たる
- PR ごとに `gh pr view <URL> --json state,headRefOid` で状態と先頭を取り、`state` が `MERGED` のものだけを使う
- 表の 1〜6 の判定と未 push の数え方 (上の例外を含む) は、`src/shared` の 1 つの関数に置き、画面のサーバーとランナーの `flow` の両方が使う (`features/implementation-flow.md`「worktree の片付け」)
- この関数は入出力を持たず、表の 1〜6 の材料と、HEAD がその issue のどれかの merge 済みの PR の先頭と同じかを受け取る。返すのは、消してよいかと理由である。git と `gh` で材料を集めるのは、それぞれのプロセスの Port である
- 消せるときは、その worktree で開いているターミナルを終わらせ、`git worktree remove <パス>` で消す。強制の指定は使わない
- ブランチは、アプリが worktree と一緒に作ったもの (`worktrees.branch_created` が真) だけを消す。worktree の現在の HEAD と、消すブランチの先端の両方で、未 push のコミットが無いことを確かめる。merge 済み PR の例外も、それぞれの先端との一致で判定する
- 画面のサーバーは、HEAD と参照をロックし、検査した先端が変わっていないことを確かめてから worktree を消す。所有ブランチの削除には `git update-ref --no-deref -d refs/heads/<ブランチ> <検査した先端>` を使う。検査後に先端が進めば削除せず、状態の変化を知らせる
- 保存してある所有ブランチが既に無ければ、その削除は行わない。ほかの worktree で開かれている場合は、worktree のフォルダを消す前に拒否する
- worktree のフォルダを消したら、`worktrees.removed_at` の記入と会話の移動を同じトランザクションで行う。その worktree を作業ディレクトリにしていた会話は、プロジェクトのディレクトリへ移し、`worktree_id` を空にする。トランザクションは、組み立て時に渡す Unit of Work をユースケースが呼び出す
- 画面のサーバーは、削除の途中経過を `.git/sukuna-worktree-removals/<worktree の id>.json` に置く。所有ブランチの先端、Git の管理ディレクトリの識別情報、フォルダの削除が済んだかを保存する。フォルダを消した後のブランチ削除か DB 更新に失敗しても、この記録を読んで同じ削除要求を再試行できる
- ブランチ削除に失敗しても、会話の移動を DB に反映してから失敗を返す。再試行では、既に消えた Git の記録とブランチを処理済みとして扱う。同じパスに作り直された別の worktree やフォルダがあれば触らずに拒否する。全て終わったら途中経過の記録を消す
- フォルダが外で消されて git の記録だけが残る worktree は、一覧に「フォルダがありません」と出す。消すと、git の記録だけを片付ける (`git worktree prune`)

### 書くプロセス

`worktrees` の行を作るプロセスは、`origin` で決まる。開発者の worktree と、一覧でアプリの外で作ったと分かった worktree (`origin = user`) は画面のサーバーが、自動フローの worktree (`origin = flow`) はランナーの `flow` が作る。

- `flow` は、`git worktree add` の前に `worktrees` の行を足す。add に失敗したら、その行の `removed_at` に時刻を入れる。一覧が、作っている途中の worktree を `user` として記録しないためである
- 一覧は、記録に無い worktree のうち、名前が `issue-` か `design-` で始まるものを記録に足さず、一覧にも出さない。自動フローの名前の worktree を `user` として記録すると、自動フローの記録と重なるためである
- 行を足すときは、一意の制約 `worktrees (project_id, path)` (`removed_at` が空の行だけ。DESIGN.md「データスキーマ」) に頼る。一覧を 2 つの端末から同時に開いても、同じ worktree の行は 1 つになる

- `removed_at` は消したプロセスが書く。閉じた issue の残した worktree は、開発者が消すと画面のサーバーが、片付けるとランナーが書く。どちらも `removed_at` が空のときだけ書く条件で更新する (DESIGN.md「データスキーマ」)
- 消した worktree を作業ディレクトリにしていた会話の `cwd` と `worktree_id` は、画面のサーバーが書く。ランナーも書く列なので、`cwd` が消した worktree のパスのときだけ書く条件で更新する

### worktree の一覧の画面

右のウィンドウ「worktree」である (UI_SKETCH.html の `pc-conv--worktree`)。列は「名前 / ブランチ / 使っているもの」とし、ウィンドウの見出しに列の見出しを置く。

- 先頭の行は「main」(プロジェクトのディレクトリ) とし、その後の並びは「エッジケースの決定」の「並びと数え方」に従う
- 「使っているもの」には、使っている issue (`#42`)、会話の件数 (`会話 2 件`)、どちらも無ければ「会話なし」を書く。未コミットの変更か未 push のコミットがあれば、「未コミット 3」「未 push 2」を添える
- いまの作業場所の行には、印 ● を付ける。作業場所は「作業場所の切り替え」の節で決まる
- worktree の行の後に、メニュー「worktree を作る」(説明は「名前を付けて作る」) を置く
- 最後に、説明の行「● は、いま開いている会話か issue が動いている場所です。」と「main はプロジェクトのディレクトリで、worktree を作らない会話はここで動きます。」を置く
- worktree の行にカーソルがあるとき、ステータス行のキーの案内は「Enter この worktree に切り替える / dd 消す / q 閉じる」とする

| 操作 | 画面に起きること |
| --- | --- |
| Space k | いまのプロジェクトの一覧を右のウィンドウに開く。プロジェクトが決まらない画面 (一覧、ヘルプ) では「プロジェクトを開いてから使えます」のお知らせを出す |
| 行で Enter | 作業場所をその worktree に切り替え、お知らせ「worktree <名前> に切り替えました」を出す。印 ● がその行へ移る (「作業場所の切り替え」) |
| 行で dd | 確認「この worktree を消しますか? (y / n)」を出す。使っている会話かターミナルがあれば「会話 n 件はプロジェクトのディレクトリで続きます。開いているターミナルは終わります」を添える |
| 確認で y | 消す。成功したら「worktree try-2 を消しました」、消せなければ理由をエラーのお知らせに出す |
| メニュー「worktree を作る」 | 1 行の入力欄を開く。Normal モードの Enter で作る。成功したら「worktree try-2 を作りました」のお知らせを出し、一覧を取り直して、作った worktree の行にカーソルを置く。失敗したら理由をエラーのお知らせに出し、入力欄と書いた名前を残す |

### 作業場所の切り替え

worktree の一覧の行で Enter を押すと、いま主のウィンドウに開いている画面の作業場所を、その worktree に切り替える。main の行は、プロジェクトのディレクトリに切り替える。

| 開いている画面 | 切り替えるもの | 印 ● を付ける行 |
| --- | --- | --- |
| 開発者が始めた会話 (`chat`) | 会話の作業ディレクトリ (`conversations.cwd` と `worktree_id`)。サーバーに保存し、どの端末でも同じになる | 会話の作業ディレクトリ |
| issue (会話・設計・差分の表示) | 切り替えない。お知らせ「issue の作業場所は自動フローが決めます」を出す | issue の担当の会話の作業ディレクトリ |
| そのほか (プロジェクトの画面など) | ブラウザのタブが覚える「選んだ worktree」。プロジェクトの画面の Space g が使う (方針 P3) | 選んだ worktree。選んでいなければ main |

- 会話の切り替えは、`PUT /api/conversations/:id/workspace` で行う。AI が動いているとき (`working` / `waiting_answer` / `waiting_permission`) は切り替えず、エラーのお知らせに `message` を出す
- 新しい作業ディレクトリは、次に会話の実行を開くときから効く。ランナーは開いている実行を閉じ、次の指示を、保存した `session_id` と新しい作業ディレクトリで再開して届ける (`features/runtime.md`「Agent SDK を包む Port」の再開)。会話の文脈は保つ
- 指示をまだ送っていない会話も切り替えられる。会話を始めてから最初の指示を送る前に切り替えると、既存の worktree で会話を始めたのと同じになる
- スレッドは切り替えられない。スレッドの作業ディレクトリは、分岐したときの元の会話のものである
- 会話の画面の見出しの右に、作業場所を「worktree: <名前>」か「worktree なし」で出す

### ターミナルの画面

主のウィンドウ「ターミナル」である (UI_SKETCH.html の `pc-terminal`)。見出しは「ターミナル  <プロジェクト> / <プロジェクトのディレクトリ | worktree: 名前>」とする。

**開く場所** (BR-060):

| 開いたところ | 作業ディレクトリ | ストックの送り先 |
| --- | --- | --- |
| 会話 (Space g) | その会話の作業ディレクトリ | その会話 |
| issue (Space g) | その issue の実装の会話の作業ディレクトリ。無ければ設計の会話、それも無ければプロジェクトのディレクトリ | その会話 |
| プロジェクトの画面 (Space g) | タブで選んだ worktree (「作業場所の切り替え」)。選んでいなければプロジェクトのディレクトリ | 前に同じ場所で開いたときの送り先。初めてなら無し |

- 同じ作業ディレクトリで動いているターミナルがあれば、新しく作らずにそれを開く。ターミナルは作業ディレクトリごとに 1 つとする
- 別の会話から同じ場所のターミナルを開いたときは、送り先をその会話に替える
- シェルは環境変数 `SHELL` (無ければ `/bin/zsh`) をログインシェルとして起動する。環境変数は画面のサーバーのものを引き継ぎ、`SUKUNA_` で始まるものを除き、`TERM=xterm-256color` を設定する

**モード**:

| モード | キーの行き先 | 表示 |
| --- | --- | --- |
| 入力 (ステータス行は TERMINAL) | すべてのキーを中のプログラムへ送る。例外は 2 つある。Ctrl+] (既定。`:tmap` で変えられる。`features/buffer-ui.md`「キーの割り当て」) は Normal モードへ移る。Cmd を押したキーはブラウザに渡す。Ctrl+[ は Esc (`\x1b`) としてプログラムへ送る | xterm.js の端末 |
| Normal | Vim の移動・検索・選択と、Space q / Space c / Space g などのアプリのキー | 端末の出力を行にした読み取り専用のバッファ |

- Normal モードへ移るとき、xterm.js のスクロールバックと画面の内容を、1 行ずつの文字列にしてバッファに入れる。折り返された行は 1 行につなぎ、行末の空白は削る。色は付けない
- Normal モードのあいだに届いた出力はバッファの末尾に足す。カーソルが末尾の行にあるあいだだけ、表示を末尾へついて行かせる (BR-093 と同じ)
- Normal モードで i を押すと入力のモードに戻り、端末の末尾を表示する
- 箇所を選んで Space q / Space c を押すと、選んだ出力の文を引用にしてストックに入れる。引用の種類は `terminal` で、文だけを持ち、出力の位置は持たない。形は `features/stock-thread.md`「引用の持ち方」に従う。送り先が無いときは「送り先の会話がありません。会話か issue を開いてから押してください」のお知らせを出す
- ステータス行のキーの案内は、入力のモードでは「<今のキー> Normal へ」(既定は「Ctrl+] Normal へ」)、Normal モードでは「i 入力へ戻る / Space q 質問 / Space c 指示 / - 戻る」とする

**画面を閉じたとき** (UC-013 C):

- 画面を閉じるか別の画面へ移ると、WebSocket だけを閉じる。プログラムは動き続け、出力は画面のサーバーが受け取り続ける
- 開き直すと、画面のサーバーが保持する端末の状態 (スクロールバック 10,000 行と画面) を最初に送り、続けて新しい出力を送る
- ブラウザのタブは、開いていたターミナルの id を覚える (方針 P3)。再読み込みしても同じターミナルにつなぐ
- プログラムが終わると「[終了しました (コード 0)]」を出す。入力のモードで i を押すと、同じ場所で新しいシェルを開く
- 画面のサーバーを入れ替えると、ターミナルのプログラムは終わる。つなぎ直したときに id が無ければ「ターミナルは終了しています (画面のサーバーが再起動しました)。i で新しく開きます」を出す。AI を止めないこと (BR-069) は、ターミナルには当てはめない

### ターミナルの持ち方

ターミナルは、データベースに記録せず、画面のサーバーのプロセスの中に持つ。プロセスが終わればプログラムも終わるので、記録しても開き直せないためである。

| 持つもの | 中身 |
| --- | --- |
| id | ULID |
| プロジェクト、作業ディレクトリ、送り先の会話 | 開いたときに決めたもの |
| 擬似端末 | `node-pty` のプロセス |
| 端末の状態 | `@xterm/headless` の端末。擬似端末の出力をすべて流し込み、つなぎ直したときに `@xterm/addon-serialize` で書き出して送る。スクロールバックは 10,000 行 |
| つないでいる WebSocket | 0 個以上 |
| 終わったときのコードとシグナル | 終わるまでは無し |

- 同時に動かせるターミナルは 20 個までとする。超えると開けず、「ターミナルが 20 個動いています。使わないシェルを exit で終えてください」を返す
- 終わったターミナルは、同じ作業ディレクトリで新しく開くまで残し、最後の出力を読めるようにする。20 個の数には入れない

## API

共通のエラー応答と本人の判定は DESIGN.md「横断規約 > エラー応答」「横断規約 > 本人の判定」参照。この機能だけのコードとして、`worktree_failed` (500。git が worktree を作れなかった) を使う。`features/conversation.md` の会話を始める操作も、同じコードと状態コードを使う。

### GET `/api/projects/:id/worktrees`

`git worktree list --porcelain` の結果を `worktrees` の記録と合わせて返す。git が知っていて記録に無い worktree (アプリの外で作ったもの) は、`origin = user` で記録に足してから返す。

```json
{
  "worktrees": [
    {
      "id": null, "name": "main", "path": "/Users/me/src/shop-api", "branch": "main", "origin": "main",
      "issue": null, "conversations": [{ "id": "01J...", "title": "予約 API の壁打ち", "runState": "idle" }],
      "uncommittedCount": 0, "uncommittedSample": [], "unpushedCount": 0, "locked": null, "missing": false, "terminalId": "01J..."
    },
    {
      "id": "01J...", "name": "try-cache", "path": "/Users/me/src/shop-api/.claude/worktrees/try-cache", "branch": "try-cache", "origin": "user",
      "issue": null, "conversations": [],
      "uncommittedCount": 3, "uncommittedSample": ["src/a.ts", "src/b.ts", "README.md"], "unpushedCount": 0, "locked": null, "missing": false, "terminalId": null
    }
  ]
}
```

- `origin` は `main` / `user` / `flow` とする。`issue` は `{ "id", "number", "title", "state" }` か `null` とする
- `branch` は、HEAD がブランチを指していなければ `null` とする
- `uncommittedSample` は、未コミットの変更のパスを先頭から 5 件まで返す
- `conversations` は、閉じていない会話のうち、作業ディレクトリがその worktree のものを並べる
- プロジェクトが無いか解除されていれば 404 `not_found`

### POST `/api/projects/:id/worktrees`

- リクエスト: `{ "name": "try-2" }`
- 応答: 201 で、一覧の 1 件と同じ形に `notice` を足す。`notice` は、fetch に失敗して手元の既定ブランチから作ったときの文「GitHub から取得できなかったので、手元の既定ブランチから作りました」で、それ以外は `null` にする。画面は `notice` をお知らせに出す
- 400 `invalid_input`: 名前が規則に合わないか、`design-` か `issue-` で始まるか、`main` か `sukuna` である。`message` に規則を書く
- 409 `conflict`: 同じ名前の worktree かフォルダがある / 同じ名前のブランチがほかの worktree で開かれている
- 500 `worktree_failed`: git が失敗した。`message` に git の出力の最初のエラーの 1 行を入れる

### DELETE `/api/worktrees/:id`

- 応答: 200 `{ "removedBranch": true, "movedConversationIds": ["01J..."] }`
- 409 `conflict`: 「消す」の表の 1〜6 に当てはまる。`message` に表の文を入れ、`error.details` に `{ "reason": "uncommitted" | "unpushed" | "flow" | "running" | "locked" | "main", "count": 3, "sample": ["src/a.ts"] }` を入れる
- 404 `not_found`: 記録が無いか、削除とその後の片付けが全て終わっている

### PUT `/api/conversations/:id/workspace`

開発者が始めた会話の作業場所を切り替える (「作業場所の切り替え」)。画面のサーバーは、worktree を確かめてから、ランナーの `POST /conversations/:id/workspace` に渡す。

- リクエスト: `{ "worktreeId": "01J..." | null }`。`null` はプロジェクトのディレクトリである
- 応答: 200 で `{ "conversation": <会話の状態> }` (`features/conversation.md` の `GET /api/conversations/:id` と同じ形)
- 404 `not_found`: 会話か worktree が無い / worktree を消してある / worktree のフォルダが無い / worktree が会話と別のプロジェクトのもの
- 409 `conflict`: 会話が `chat` ではない (「worktree を切り替えられるのは、開発者が始めた会話です」) / AI が動いている (「AI が動いているあいだは切り替えられません。止めてから切り替えてください」)
- 503 `runner_unavailable`: ランナーにつながらない。何も変えない

ランナーは、会話ごとの 1 列の処理の中で次を行う。

1. AI が `working` / `waiting_answer` / `waiting_permission` なら 409 を返す
2. 開いている実行があれば閉じる。利用枠の戻りを待つタイマーは外さない。戻ったときの再開は、新しい作業ディレクトリで開く
3. `conversations.cwd` と `worktree_id` を、読んだときの `cwd` を条件に付けて書く。同じときに worktree が消されて書けなければ 409 を返す。書けたら、配信で会話の変化を知らせる

### POST `/api/terminals`

- リクエスト: `{ "projectId": "01J...", "worktreeId": "01J..." | null, "conversationId": "01J..." | null, "cols": 120, "rows": 40 }`。作業ディレクトリは、`worktreeId`、`conversationId`、プロジェクトの順で決める。issue から開くときは、画面が実装の会話の id を渡す。無ければ設計の会話の id を渡し、どちらも無ければ `null` にする (「開く場所」の表)
- 応答: 201 (新しく開いた) か 200 (動いているものを開いた) で `{ "id": "01J...", "cwd": "/Users/...", "label": "worktree: try-2", "conversationId": "01J..." | null, "reused": true }`
- 400 `invalid_input`: `cols` が 2〜500、`rows` が 1〜200 の外
- 404 `not_found`: プロジェクト、worktree、会話のどれかが無い / worktree のフォルダが無い
- 409 `conflict`: 動いているターミナルが 20 個ある

### WebSocket `/ws/terminals/:id`

接続のたびに本人の判定を通す。本人でなければ upgrade を 401 で断り、擬似端末にはつながない。id のターミナルが無ければ upgrade を 404 で断る。

フレームはテキストの JSON とする。

| 向き | 形 | 意味 |
| --- | --- | --- |
| 画面 → サーバー | `{ "type": "input", "data": "ls -la\r" }` | キーの入力と貼り付け。`data` は 64 KiB まで。超える貼り付けは画面が分けて送る |
| 画面 → サーバー | `{ "type": "resize", "cols": 120, "rows": 40 }` | 端末の大きさ。最後に届いた大きさを擬似端末に当てる |
| サーバー → 画面 | `{ "type": "snapshot", "data": "<書き出した端末の状態>", "cols": 120, "rows": 40 }` | つないだ直後に 1 回だけ送る |
| サーバー → 画面 | `{ "type": "output", "data": "..." }` | 擬似端末の出力 |
| サーバー → 画面 | `{ "type": "exit", "code": 0, "signal": null }` | プログラムが終わった |
| サーバー → 画面 | `{ "type": "error", "message": "..." }` | 受け付けなかったフレーム (64 KiB を超える入力、形の誤り) |

- 同じターミナルに複数の画面がつながってもよい。出力はすべての画面に送り、どの画面の入力も受け付ける
- 終わったターミナルにつなぐと、`snapshot` と `exit` を続けて送る
- 入力と出力は、ログに出さない (DESIGN.md「横断規約 > ログ」の、会話の本文とファイルの中身と同じ扱い)

## 実装の配置

| 処理 | 層 | 実装先ファイル |
| --- | --- | --- |
| 名前の規則と既定の名前 | ドメイン | `src/server/modules/workspace/domain/worktree-rules.ts` |
| 消してよいかの判定 (「消す」の表の 1〜6、未 push の数え方と merge 済みの PR の例外) | 共有 (純粋な関数) | `src/shared/workspace/worktree-safety.ts` |
| 一覧 → worktrees, conversations, issues | ユースケース | `src/server/modules/workspace/usecase/list-worktrees.ts` |
| 作る → worktrees | ユースケース | `src/server/modules/workspace/usecase/create-worktree.ts` |
| 消す → worktrees, conversations, issues, issue_events | ユースケース | `src/server/modules/workspace/usecase/remove-worktree.ts` |
| git の実行 (`worktree list / add / remove / prune`、`status`、`rev-list`、`fetch`、先端の一致を条件にした `update-ref -d`) と、merge 済みの PR の先頭を取る `gh pr view` | インフラ (git と GitHub の Port) | `src/server/modules/workspace/adapter/git-cli.ts` |
| 画面のサーバーの worktree 削除の途中経過と、Git の管理ディレクトリの識別情報 | インフラ | `src/server/modules/workspace/adapter/worktree-removal-storage.ts` |
| ターミナルを開く、作業ディレクトリと送り先を決める、数の上限 | ユースケース | `src/server/modules/workspace/usecase/open-terminal.ts` |
| ターミナルの持ち方 (擬似端末と端末の状態) | インフラ (擬似端末の Port) | `src/server/modules/workspace/adapter/pty-session.ts` |
| `/ws/terminals/:id` の upgrade とフレームの処理 | API ハンドラ | `src/server/modules/workspace/adapter/terminal-ws.ts` |
| API ハンドラ (worktree の 3 本とターミナルを開く) | API ハンドラ | `src/server/modules/workspace/adapter/worktree-routes.ts` |
| 会話の作業場所の切り替え (確かめてランナーに渡す) と、その API ハンドラ | ユースケース、API ハンドラ | `src/server/modules/conversation/usecase/switch-workspace.ts`、`src/server/modules/conversation/adapter/http.ts` |
| 開いている実行を閉じ、作業ディレクトリを書く → conversations | ユースケース (ランナー) | `src/runner/modules/conversation/usecase/switch-workspace.ts` |
| 入出力とフレームの Zod のスキーマ | 共有 | `src/shared/api/worktree.ts`、`src/shared/api/terminal.ts` |
| 右のウィンドウ「worktree」と作業場所の切り替え。タブで選んだ worktree | UI | `src/front/components/worktree-window.tsx` |
| ターミナルの画面 (xterm.js、モードの切り替え、つなぎ直し) | UI | `src/front/pages/terminal/terminal-page.tsx` |
| 端末の内容を Normal モードの行に直す | UI | `src/front/pages/terminal/terminal-lines.ts` |

- `/ws/terminals/:id` の upgrade は、`/ws` と同じ `ws` の受け口に、パスで分けて足す (DESIGN.md「既知の制約」の `vp dev` の項)
- 使う列 (`worktrees` の `branch_created`・`port_slot`) の定義は DESIGN.md「データスキーマ」参照。`port_slot` は実装の worktree だけが使い、決め方は `features/implementation-flow.md` に従う

## エッジケースの決定

1. **空・最小データ**: worktree を作っていないプロジェクトの一覧は「main」の行とメニューだけになる。出力が空のターミナルで Normal モードへ移ると、プロンプトの 1 行だけのバッファになる
2. **上限・境界値**: 名前は 1〜60 字。ターミナルは同時に 20 個まで。スクロールバックは 10,000 行で、超えた古い行は Normal モードでも読めない。入力のフレームは 64 KiB まで。端末の大きさは 2〜500 列、1〜200 行
3. **エラー時に利用者へ見えるもの**: 作れないときと消せないときは、理由をエラーのお知らせに出す (「消す」の表と API の節の文)。ターミナルにつながらないときは、主のウィンドウに「ターミナルにつながりません」と「再読み込み」を出す。本人の判定は DESIGN.md「横断規約 > 本人の判定」に従い、`/ws/terminals/:id` の接続も判定を通す。本人でない接続は upgrade の前に断るので、シェルの入力にも出力にも触れられない。擬似端末は画面のサーバーと同じ OS のユーザーで動き、開発者と同じ権限を持つので、この判定が唯一の入口の制限になる
4. **並行操作・二重実行**: 同じ名前の worktree を 2 つの端末から同時に作ると、git か `worktrees (project_id, path)` の一意の制約が後の方を断り、`conflict` を返す。同じ作業ディレクトリのターミナルを 2 か所から同時に開くと、プロジェクトの中で作業ディレクトリごとに 1 つの処理だけが作り、もう一方は同じターミナルを受け取る。消す確認の後に会話の AI が動き始めていれば、消すときの検査で断る
5. **再表示時の整合**: worktree の一覧は、右のウィンドウを開くたびと、消す・作るの後に取り直す。git の状態はアプリの外でも変わるので、一覧の数は取り直した時点のものとし、消すときは必ず検査し直す
6. **表示の寿命**: 「未コミット 3」などの添え書きは、一覧を取り直したときに入れ替える。「[終了しました]」の行は、同じ場所で新しいシェルを開くまで残す
7. **送る前のデータ**: 作る名前の入力欄は、作るのに失敗しても書いた名前を残す。この入力は会話の書きかけの入力ではないので、サーバーには置かず、閉じると消える。ターミナルに打った文字は、中のプログラムが持つ
8. **状態の移り変わり**: worktree は 作った → (消す) → 消した の 2 つだけを持つ。ターミナルは 動いている → 終わった の 2 つを持つ。開発者が作った worktree は、自動では消さない (BR-059)
9. **自動で進むこと**: アプリは、開発者の worktree を自動で消さない。終わったシェルを自動で開き直さない。git の記録だけが残った worktree の片付け (`git worktree prune`) も、開発者が消すときだけ行う
10. **端末と画面をまたぐこと**: worktree の記録は、どの端末でも同じである。ターミナルは画面のサーバーに 1 つあり、どの端末からつないでも同じ出力と入力を共有する。大きさは最後に送った画面のものになる。開いていたターミナルの id とモード、会話を開いていない画面で選んだ worktree は、ブラウザのタブごとに持つ。会話の作業場所はサーバーに置き、どの端末でも同じにする
11. **並びと数え方**: 一覧は main を先頭に、`git worktree list` の順に並べる。未コミットの変更は `git status --porcelain` の 1 行を 1 件と数える。未 push のコミットは「消す」の節の式で数える

## テスト方針

| 受け入れ基準 (docs/design/USECASES.md) | レベル |
| --- | --- |
| （US-065）worktree の一覧を開くと、worktree がブランチ、紐づく会話と issue とともに並ぶ | 結合 |
| （US-065）名前を付けて worktree を作ると、新しい worktree ができ、そこで会話かターミナルを始められる | E2E |
| （US-065）未コミットの変更と未 push のコミットが無い worktree を消すと、worktree が消える | 結合 |
| （US-065）未コミットの変更か未 push のコミットがある worktree を消そうとすると、あることが表示され、消されない | 結合 |
| （US-068）worktree でターミナルを開いてコマンドを実行すると、出力が表示される | 結合 |
| （US-065）worktree を作れないと、失敗した理由が表示される | 結合 |
| （US-068）ターミナルの入力中に `Ctrl+]` を押すと、Normal モードへ移る | 単体 |
| （US-068）ターミナルの入力中に Normal モードへ移ると、出力を Vim のバッファとして読め、箇所を選んでストックできる | 単体 |
| （US-068）ターミナルを開いたまま画面を閉じても、プログラムは動き続け、開き直すと続きが表示される | 結合 |
| （US-024）ターミナルの入力中に `Ctrl+[` を押すと、`Esc` としてターミナルの中のプログラムへ送られる | 単体 |

- 結合: 画面のサーバーを、本物の SQLite と、一時ディレクトリに作った本物の git のリポジトリ (リモート役の bare リポジトリ付き) で動かす。worktree の一覧・作成・削除は API から確かめる。消せない場合は、未コミットのファイルを置いたもの、未 push のコミットを持つもの、自動フローの issue が開いているものの 3 つで、応答の `error.details` 全体を比べる
- 結合 (ターミナル): 本物の `node-pty` でシェルを開き、`/ws/terminals/:id` に `pwd` を送り、出力のフレームに worktree のパスが出ることを確かめる。画面を閉じる行は、WebSocket を切ったあとにコマンドの出力を待ち、つなぎ直した `snapshot` にその出力があることを確かめる。待つのは出力の条件で、固定の時間は待たない
- 単体: 入力のモードのキーの扱い (Ctrl+] でモードが変わり、プログラムへは送らない。Ctrl+[ は `\x1b` を送る) を、xterm.js を偽物に替えて確かめる。端末の内容を行に直す処理 (折り返しの連結、行末の空白) と、Normal モードで選んだ行からストックに入る引用の文を確かめる
- E2E: プロジェクトの画面で worktree を作り、一覧のその行で Enter を押して切り替え、Space g でターミナルを開いて `pwd` を実行し、ターミナルに出力が出るまでを確かめる。作業ディレクトリが正しいことは、ターミナルの結合テストで確かめる

E2E 対象動線: （US-065）名前を付けて worktree を作ると、新しい worktree ができ、そこで会話かターミナルを始められる
