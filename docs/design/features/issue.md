# issue

- 種別: 機能設計書
- 対象 UC: UC-007 (docs/design/USECASES.md)

## 何を作るか

アプリの中で issue を作り、確定し、親・依存・優先度を直し、取り下げと再開をする機能である。AI が issue を読み書きするためのツールも、この機能が持つ。

**使う人**: 開発者 (作る、確定する、直す、取り下げる、再開する)。AI (会話の中で issue を読み、作り、直し、結果を報告する)

**流れ**:

1. プロジェクトを選んで issue の作成を始め、題名と本文を書く。書いた項目はその場で下書きとして残る
2. 必要なら、親、依存、優先度、merge の前に自分が確認するかを指定する
3. 書き終えたら確定する。issue は精査待ちになり、精査の AI が始まる
4. 確定した後の題名と本文は、会話で AI に頼んで直させる (BR-077)。親・依存・優先度・merge 前の確認は、開発者がフォームで直せる
5. 要らなくなった issue は取り下げる。閉じた issue は、それまでの会話と記録を残したまま再開できる

**主な決まり**:

- issue はアプリが管理し、プロジェクトの中で 1 から振る番号を持つ。番号は使い回さない (BR-033)
- 下書きの間は AI は動かない (BR-034)。題名が空のままでは確定できない
- AI が会話から作る issue は確定済みで作る (BR-035)。作った issue は、作った会話から開ける
- 依存と親は循環できない。循環する指定は、循環している issue を示して保存しない
- 依存先がすべて完了するまで実装は始まらない。取り下げの issue は完了と数えず、それに依存する issue は停止中になる (BR-037、BR-076)
- 優先度は高・中・低の 3 つで、指定しなければ精査の採点から付く。開発者はあとから変えられる (BR-038)
- 取り下げると、動いている AI を止めて issue を閉じる。取り下げは y / n の確認を挟む

## 入出力と振る舞い

### この機能の前提

- issue の状態の値と移り変わりは `features/issue-flow.md` が正本である。本書は、開発者の操作と AI のツールから状態の変化を頼むところまでを書く
- 状態を移すのはランナーの `flow` だけとする。確定・取り下げ・再開の API は、画面のサーバーが検査してからランナーへ渡す (`features/runtime.md`「画面のサーバーからランナーへの操作」)
- 一覧、ツリー、プロジェクトの画面での issue の並びは `features/inbox.md` が決める
- 画面の部品 (バッファ、メニューの行、y / n の確認、入力欄、コマンド) は `features/buffer-ui.md` に従う

### issue の項目

| 項目 | 列 | 値 | 開発者が直せるとき | AI のツールで直せるとき |
| --- | --- | --- | --- | --- |
| 番号 | `number` | 1 以上の整数。プロジェクトの中で一意 | 直せない | 直せない |
| 題名 | `title` | 0〜200 字。確定には空白以外の 1 字以上が要る | 下書き | 確定した後 (閉じるまで) |
| 本文 | `body` | 0〜50,000 字の Markdown | 下書き | 確定した後 (閉じるまで) |
| 親 | `parent_id` | 同じプロジェクトの別の issue か、無し | 閉じるまで | 確定した後 (閉じるまで) |
| 依存 | `issue_dependencies` | 同じプロジェクトの別の issue を 0〜50 件 | 閉じるまで | 確定した後 (閉じるまで) |
| 優先度 | `priority` | `high` (高) / `medium` (中) / `low` (低) / 無し | 閉じるまで。確定した後は無しに戻せない | 確定した後 (閉じるまで) |
| merge 前の確認 | `confirm_before_merge` | 真偽。既定は偽 (しない) | 閉じるまで | 確定した後 (閉じるまで) |
| 種別 | `kind` | `bug` / `enhancement` / `refactoring` / `question` / 無し | 直せない | 確定した後 (閉じるまで) |
| 設計済み | `designed` | 真偽。既定は偽 | 直せない | 作るときだけ |
| 作った会話 | `created_conversation_id` | AI が作った issue では作った会話。開発者が作った issue では無し | 直せない | 直せない |
| GitHub の番号 | `github_number` | GitHub から取り込んだ issue では元の番号。ほかは無し。取り下げると空にする (`features/project-settings.md`「GitHub の issue の取り込み」) | 直せない | 直せない |

- 状態 (`state`)・停止中の理由 (`stop_reason`)・PR (`pr_url`)・閉じた時刻 (`closed_at`) は `flow` だけが書く。開発者もツールも直接は直せない
- 題名と本文は、前後の空白を落としてから保存する。改行は本文だけに許す
- 下書きの行は画面のサーバーが書き、下書きでない行は `flow` が書く。下書きから精査待ちへ移すのも `flow` で、状態の検査と書き込みを 1 つのトランザクションで行う
- 優先度の無い issue は、並べるときに中として扱う (`features/inbox.md`、`features/implementation-flow.md`)
- 精査が付ける優先度は、緊急枠なら高とする。そうでなければ、親に優先度があれば親と同じに、無ければスコアが 9.0 以上で高、3.0 以上で中、それ未満で低とする。決め方の正本は `features/issue-flow.md`「精査の結果」である
- `created_at` は行を作るときに、`updated_at` は項目か状態を変えるたびに、その行を書くプロセスが入れる
- `parent_id` と `created_conversation_id` には外部キーを張らない (DESIGN.md「データスキーマ」)。issue は消さないので、親は残る。作った会話が削除されたときの出し方は「issue の画面」と API の `createdConversation` にある

### 番号

- 番号は、issue の行を作るトランザクションの中で、そのプロジェクトの最大の番号 + 1 を取る。下書きも番号を持つ
- 画面のサーバー (下書き) とランナー (AI が作る issue) が同時に作って一意の制約 (`issues (project_id, number)`) に当たったら、取り直して 1 回だけやり直す
- issue は消さないので、番号は使い回さない。取り下げの issue も番号を持ち続ける
- 画面と AI は、issue を `#<番号>` で示す。プロジェクトをまたぐ指定はできない

### 親と依存

- 親は 1 つまで、依存は 50 件までとする。自分自身は指定できない
- 保存する前に、依存のつながり (A が B に依存) と、親のつながり (A の親が B) を、それぞれたどって循環を探す。2 つのつながりは別々に調べる
- 循環が見つかったら保存せず、循環している issue を番号の並びで示す (UC-007 E1)。文は「#3 → #5 → #3 が循環しています。依存を保存しませんでした」とする。親なら「親を保存しませんでした」とする
- 指定した番号の issue がプロジェクトに無ければ保存せず、「#99 はこのプロジェクトにありません」と示す
- 閉じた issue も、親と依存先に指定できる。完了の依存先は、待たずに済む
- 親か依存を外すと、親の画面の子の並びから外れ、外した依存先を待たなくなる (UC-007 D)。確定した issue の依存を変えたら、`flow` が評価を行う (`features/issue-flow.md`)。待ちが無くなった issue の実装はここで始まる

### 作成・編集の画面

issue の作成と編集は、主のウィンドウの「issue の作成・編集」の画面で行う。手本は UI_SKETCH.html の `pc-issueform` (`issueForm`) である。

開き方:

| 操作 | 開くもの |
| --- | --- |
| `Space o` | いま開いているプロジェクト (無ければ最後に開いたプロジェクト) の、新しい issue の画面。プロジェクトを一度も開いていなければ、画面を開かずに「プロジェクトを開いてから作ります」のお知らせを出す |
| プロジェクトの画面の下書きの行で `Enter` | その下書きの画面 (`features/inbox.md`) |
| プロジェクトの画面の issue の行で `cc` | その issue の編集の画面 |
| issue を開いているときにコマンド `:issue edit` | その issue の編集の画面 |

行の並び (項目と値を 1 行に 1 組、列を揃える):

1. プロジェクト (直せない)
2. 題名、本文、親、依存、優先度、merge 前の確認
3. 案内の行「項目の行で i を押すと、その項目を書けます。」
4. 見出し「操作」と、メニューの行

| issue | メニューの行 | 直せない項目の行の扱い |
| --- | --- | --- |
| 新しい issue / 下書き | 1 確定する (AI が精査を始める)、2 下書きとして保存する | 無し |
| 確定した issue (閉じていない) | 1 戻る | 題名と本文は値の後ろに「(会話で AI に頼んで直します)」を出し、`i` を受けない |
| 閉じた issue | 1 戻る | すべての項目を直せない。案内の行を「閉じた issue は直せません。再開してから直します。」にする |

操作と、画面に起きること:

| 操作 | 起きること |
| --- | --- |
| 項目の行で `i` | 入力欄が開き、いまの値が入る。題名と本文は Vim と同じモードで書く。親・依存は番号、優先度は `高` / `中` / `低` / 空、merge 前の確認は `する` / `しない` を書く |
| 入力欄の Normal で `Enter` | 値を保存し、入力欄を閉じる。新しい issue なら、ここで下書きの行が作られ、番号が付く |
| 入力欄で `Esc` (Normal) | 保存せずに閉じる。書いた値は、同じ項目でもう一度 `i` を押すと戻る (ブラウザのタブの中だけに持つ) |
| 保存に失敗 (循環、無い番号、題名が長い) | 入力欄を開いたまま、書いた値を残し、エラーのお知らせに理由を出す |
| 「確定する」で `Enter` | 確定を送る。成功すると「#<番号> を確定しました。精査を始めます」のお知らせが出て、その issue の画面へ移る |
| 題名が空のまま「確定する」 | 確定しない。お知らせに「題名を書いてから確定してください」を出し、カーソルを題名の行へ移す (UC-007 E2) |
| 「下書きとして保存する」で `Enter` | 項目はすでに保存されているので、何も送らない。「下書きとして保存しました」のお知らせを出し、1 つ前の画面へ戻る |
| 「戻る」か `-` | 1 つ前の画面へ戻る |

- 項目は、入力欄で `Enter` を押すたびにサーバーへ保存する (方針 P1)。どの端末から開いても同じ値が出る
- 2 つの端末で同じ項目を直したときは、後から保存した方を残す。画面は `issue:<id>` の配信を受けて値を読み直す
- 新しい issue の画面で何も保存せずに閉じたら、下書きの行は作らない
- 書式の誤り (番号でない親、`高` / `中` / `低` / 空 以外の優先度) は、送る前に画面で止め、入力欄に残す

### issue の画面

issue を開くと、主のウィンドウに issue の画面が出る。下書きの issue を開いたときは、この画面ではなく作成・編集の画面を開く。

- ウィンドウの見出しは `<プロジェクト名> / #<番号> <題名> / <表示>` とし、2 段目に表示の並び「会話 · 設計 · 差分」を置く。`Ctrl+l` / `Ctrl+h` で次と前の表示へ移る。切り替えは画面の履歴に積まない
- 最初に開く表示は、設計レビューなら「設計」、停止中 (`merge_confirm`) なら「差分」、それ以外は「会話」とする。前に見ていた表示は覚えない
- 「設計」の表示は `features/design-review.md`、「差分」の表示は `features/pr-review.md` が持つ

「会話」の表示の行の並び:

1. 状態の行: 「状態  <状態の名前>」。停止中なら「状態  停止中 (<理由の名前>)」
2. 親の行: 「親  #<番号> <題名> (<状態>)」。親が無ければ出さない
3. 子の行: 「子  #<番号> <題名> (<状態>)」を番号の小さい順に 1 行ずつ。2 行目からは項目名を空ける (UC-007 の「親の下に子として表示」)
4. 依存先の行: 「依存先  #<番号> <題名> (<状態>)」を 1 行ずつ
5. 作った会話の行: 「作った会話  <題名>」。AI が会話から作った issue だけに出す。その会話が削除されていれば「作った会話は削除されています」とする
6. この issue の会話のメニューの行: 「1 精査の会話」「2 設計の会話」「3 実装の会話」。始まっていない段階の行は出さない。表示中の会話の行に「(表示中)」を付ける (BR-043)
7. 区切りの行のあと、表示中の会話の本文 (`features/conversation.md`)
8. 末尾に、issue としての止まった行 (下の表)

- 表示中の会話は、最初は担当の会話 (下の「担当の会話」) とする。担当の会話が無ければ、いちばん新しく始まった会話とする。会話がまだ無ければ、7 の代わりに「まだ AI の会話はありません」を出す
- 親・子・依存先の行で `Enter` を押すと、その issue を開く
- 作った会話の行で `Enter` を押すと、その会話を開く。削除されていれば何もしない
- 会話のメニューの行で `Enter` (か番号 + `Enter`) を押すと、表示中の会話を切り替える。入力欄 (`i`) とストックは、表示中の会話に送る

#### 担当の会話

担当の会話は、issue のいまの段階を進める会話である。担当でない段階の会話は読めるが、指示は送れない。一覧の行の振り分け (`features/inbox.md`) と、指示を届ける前の判定 (`features/conversation.md`) も、この表で担当の会話を決める。

| issue の状態 | 担当の会話 |
| --- | --- |
| 精査待ち | 精査の会話 |
| 設計待ち、設計レビュー | 設計の会話 |
| 実装待ち、実装中、完了 | 実装の会話 (まだ無ければ無し) |
| 停止中 | 停止前の状態の担当の会話 |
| 下書き、取り下げ | 無し |

- 担当でない段階の会話への指示 (発言、ストックの指示、届く前の指示を送る) は、ランナーが届ける前の判定で断り、409 `conflict` を返す (`features/conversation.md`)
- 文は、担当の会話があれば「この issue はいま <段階> の会話で進んでいます」、無ければ「この issue はいま <状態の名前> なので、この会話には送れません」とする。<段階> は精査・設計・実装のどれかである
- スレッドの質問と、開発者が始めた会話は、この判定の対象にしない

末尾の止まった行は、issue の状態から出す。残した worktree とは、`worktree_kept` が指す worktree のうち、まだ消していない (`removed_at` が空の) ものである。会話そのものの止まった行 (`features/conversation.md`) が出ているときは、重ねて出さない。

| issue | 区切りの行 | メニューの行 |
| --- | --- | --- |
| 停止中 (`question`) で、会話に質問の一覧がある | 出さない (会話が回答の操作を出す) | 無し |
| 停止中 (`question`) で、質問を報告のツールで書いた | 「止まっています: AI が判断を求めています。この会話で答えると続きます」 | 無し |
| 停止中 (`failed`) で、worktree を作れなかった (`cause` が `worktree_failed`) | 出さない (会話の止まった行が <detail> と「再開する」を出す) | 無し |
| 停止中 (`failed`) で、上に当たらず、会話が止まっていない | 「止まっています: <detail>。指示を送ると続きます」 | 無し |
| 停止中 (`ci_failed`) | 「止まっています: CI が失敗しました (<detail>)。指示を送ると AI が直します」 | 1 差分の表示で CI を見る |
| 停止中 (`merge_confirm`) | 「merge 前の確認を待っています」 | 1 差分の表示で確かめる |
| 停止中 (`dependency_withdrawn`) | 「止まっています: 依存先 <detail> が取り下げられました。依存を外すか、依存先を再開すると続きます」 | 1 依存を直す (編集の画面を開く) |
| 完了 | 「この issue は完了しています」。残した worktree があれば「worktree を残しました: <パス>」も出す | 1 この issue を再開する (精査からやり直す) |
| 取り下げ | 「この issue は取り下げられています」。PR があれば「PR <URL> は開いたままです」も、残した worktree があれば「worktree を残しました: <パス>」も出す | 1 この issue を再開する (精査からやり直す) |

- worktree を作れなかったときは、`flow` が issue を停止中 (`failed`、`cause` は `worktree_failed`) にし、段階の会話に止まった記録 (`error`) を書く。会話の末尾に「再開する」が出る
- 開発者が再開を選ぶか指示を送ると、ランナーは届ける前に `flow` の `retryStageWorktree` に回す。`flow` が worktree を作り直し、最初の指示と開発者の指示を 1 通で届ける (`features/issue-flow.md`「停止中から戻る」)

### 取り下げ

- プロジェクトの画面の issue の行で `dd` を押すと、y / n の確認「#<番号> <題名> を取り下げて閉じますか? 動いている AI は止まります」を出す。`y` で取り下げを送る (`features/inbox.md`)
- 成功すると「#<番号> を取り下げました」のお知らせを出す。依存する issue を停止中にしたときは、「依存する #43、#45 を停止中にしました」を続ける
- 取り下げられるのは、完了と取り下げ以外の issue である。下書きも取り下げられ、それが下書きを捨てる方法になる
- `flow` は、状態の移り変わりと、依存する issue の停止中 (`features/issue-flow.md`「依存先の取り下げ」) を 1 つのトランザクションで行う。そのあと、この issue の精査・設計・実装の会話のうち動いているものを止める (UC-007 B)
- 止めた会話は残る。取り下げた後に会話を開いて読める
- `flow` は取り下げのトランザクションで `github_number` を空にする。取り込んだ issue を取り下げたあと、同じ GitHub の issue をもう一度取り込めるようにするためである
- worktree は、実装の worktree を `features/implementation-flow.md`「worktree の片付け」、設計の worktree を `features/design-review.md`「設計の作業場所」の規則で片付ける。未コミットの変更か未 push のコミットがあれば残し、issue の画面の末尾に「worktree を残しました: <パス>」を出す
- GitHub の PR は閉じない。issue の画面に「PR <URL> は開いたままです」を出す
- 親を取り下げても、子は取り下げない。子の親の指定はそのまま残る

### 再開

- 閉じた issue (完了か取り下げ) の画面の「この issue を再開する」で `Enter` を押すと、再開を送る。確認は挟まない (取り下げれば戻せるため)
- `flow` は issue を精査待ちに移し、`closed_at` を空にする。それまでの会話と `issue_events` は消さない (UC-007 C)
- 精査は、それまでの精査の会話の続きで始まる。最初の指示の前に付ける文は `features/issue-flow.md`「精査の AI」にある。精査の会話が無ければ新しく作る
- 取り下げの issue を再開すると、それに依存して停止中 (`dependency_withdrawn`) になっていた issue の待ちが解ける (`features/issue-flow.md`「停止中から戻る」)
- 完了の親の子を再開すると、親は実装待ちに戻る (`features/implementation-flow.md`「親の issue を閉じる」)

### `issue_events` に足す種類

状態の移り変わりの `state_changed` のほかに、この機能は次の種類を足す。書くのは `flow` である。

| 種類 | 足すとき | payload |
| --- | --- | --- |
| `created` | 下書きを確定したとき、AI が `issue_create` で作ったとき | `{ "by": "developer" \| "ai", "conversationId": "..." \| null }` |
| `edited` | 確定した issue の項目を、開発者か AI が直したとき | `{ "fields": ["priority"], "by": "developer" \| "ai", "conversationId": "..." \| null }` |
| `comment` | AI が `issue_comment` でコメントを書いたとき | `{ "text": "...", "conversationId": "..." }` |

## API

共通のエラー応答と本人の判定は DESIGN.md「横断規約 > エラー応答」「横断規約 > 本人の判定」参照。

issue の形 (`IssueView`) は次のとおりとする。一覧では `body`・`children`・`dependents`・`conversations`・`comments` を省く。

```json
{
  "id": "01JD…",
  "projectId": "01JC…",
  "number": 42,
  "title": "在庫の引き当てを追加する",
  "body": "予約の作成時に在庫を引き当てる。",
  "state": "triage",
  "stopReason": null,
  "stopDetail": null,
  "kind": null,
  "priority": "high",
  "confirmBeforeMerge": false,
  "designed": false,
  "prUrl": null,
  "createdConversationId": null,
  "createdConversation": null,
  "githubNumber": null,
  "parent": { "id": "01JD…", "number": 40, "title": "在庫管理", "state": "ready" },
  "children": [],
  "dependsOn": [ { "id": "01JD…", "number": 41, "title": "在庫の表", "state": "done" } ],
  "dependents": [],
  "conversations": [ { "id": "01JE…", "kind": "triage", "runState": "working" } ],
  "comments": [ { "at": 1764100000000, "conversationId": "01JE…", "text": "精査を始めました" } ],
  "createdAt": 1764000000000,
  "updatedAt": 1764100000000,
  "closedAt": null
}
```

- `stopDetail` は、停止中へ移した `state_changed` の `detail` である (`features/issue-flow.md`)
- `createdConversation` は、`created_conversation_id` があるときに `{ "id": "...", "title": "..." | null, "deleted": <真偽> }` とする。会話が削除されて行が無ければ、`title` を `null`、`deleted` を真にする。無ければ `null` とする
- `comments` は新しいものから 50 件を、古い順に並べる
- `conversations` は、この issue の精査・設計・実装の会話を、始まった順に並べる

### GET `/api/projects/:id/issues`

プロジェクトの issue の一覧を返す。作成・編集の画面で親と依存の候補を出すときと、ツールの `issue_list` と同じ条件で使う。

- クエリ: `state` (状態の値を `,` でつなぐ。省略すると全部)、`q` (題名と本文に含む語)、`limit` (1〜500、既定 100)、`cursor`
- 応答: 200 `{ "items": [IssueView], "nextCursor": "..." | null }`。番号の大きい順に並べる
- 404 `not_found`: プロジェクトが無いか、解除されている

### POST `/api/projects/:id/issues`

新しい下書きを作る。確定は `POST /api/issues/:id/confirm` で行う。

- リクエスト: `{ "title": "...", "body": "...", "parentNumber": 40 | null, "dependsOn": [41], "priority": "high" | null, "confirmBeforeMerge": false }`。どれも省略できる
- 応答: 201 `{ "issue": IssueView }`。状態は下書き
- 400 `invalid_input`: 長さや件数が範囲の外。無い番号を指定した
- 400 `dependency_cycle` / `parent_cycle`: 循環する。`message` に循環している番号の並びを書く
- 404 `not_found`: プロジェクトが無いか、解除されている

### GET `/api/issues/:id`

- 応答: 200 `{ "issue": IssueView }`
- 404 `not_found`

### PATCH `/api/issues/:id`

issue の項目を直す。送った項目だけを変える。

- リクエスト: `{ "title"?, "body"?, "parentNumber"?: number | null, "dependsOn"?: number[], "priority"?, "confirmBeforeMerge"? }`。`dependsOn` は全体を置き換える
- 下書き: 画面のサーバーが書く。どの項目も直せる
- 確定した issue (閉じていない): 画面のサーバーが検査してから、ランナーの `PATCH /flow/issues/:id` に渡し、`flow` が書いて `edited` (`by: developer`) を足す。`title` と `body` は受けない
- 応答: 200 `{ "issue": IssueView }`
- 400 `invalid_input` / `dependency_cycle` / `parent_cycle`: POST と同じ
- 400 `invalid_input`: 確定した issue の優先度を無しにしようとした
- 409 `confirmed_text_locked`: 確定した issue の題名か本文を送った。`message` は「確定した issue の題名と本文は、会話で AI に頼んで直します」
- 409 `conflict`: 閉じた issue
- 503 `runner_unavailable`: 確定した issue で、ランナーにつながらない。何も変えない

### POST `/api/issues/:id/confirm`

下書きを確定する。

- リクエスト: 無し
- 画面のサーバーは、状態が下書きで、題名が空でないことを確かめてから、ランナーの `POST /flow/issues/:id/confirm` に渡す。`flow` は精査待ちへ移し、`created` (`by: developer`) を足す
- 応答: 200 `{ "issue": IssueView }`。状態は精査待ち
- 400 `title_required`: 題名が空。`message` は「題名を書いてから確定してください」
- 409 `conflict`: 下書きではない
- 503 `runner_unavailable`: 下書きのまま残る

### POST `/api/issues/:id/withdraw`

- リクエスト: 無し
- 画面のサーバーは、状態が完了と取り下げ以外であることを確かめてから、ランナーの `POST /flow/issues/:id/withdraw` に渡す
- 応答: 200 `{ "issue": IssueView, "stoppedDependents": [43, 45] }`。`stoppedDependents` は停止中にした依存元の番号
- 409 `conflict`: すでに閉じている
- 503 `runner_unavailable`: 何も変えない

### POST `/api/issues/:id/reopen`

- リクエスト: 無し
- 画面のサーバーは、状態が完了か取り下げであることを確かめてから、ランナーの `POST /flow/issues/:id/reopen` に渡す
- 応答: 200 `{ "issue": IssueView }`。状態は精査待ち
- 409 `conflict`: 閉じていない
- 503 `runner_unavailable`: 何も変えない

### ランナーへの操作

`src/shared/ipc.ts` に次を足す (`features/runtime.md`「画面のサーバーからランナーへの操作」)。どれも、状態が合わなければ 409 を返す。

| メソッド | パス | 用途 | 主な入力 | 主な出力 |
| --- | --- | --- | --- | --- |
| POST | `/flow/issues/:id/confirm` | 下書きを確定する | なし | `issue` |
| POST | `/flow/issues/:id/withdraw` | 取り下げる | なし | `issue`、`stopped_dependents` |
| POST | `/flow/issues/:id/reopen` | 再開する | なし | `issue` |
| PATCH | `/flow/issues/:id` | 確定した issue の親・依存・優先度・merge 前の確認を直す | `parent_number?`、`depends_on?`、`priority?`、`confirm_before_merge?` | `issue` |

### AI に渡すツール

アプリは、会話ごとに MCP サーバー `sukuna` を作り、次のツールを渡す。AI からは `mcp__sukuna__<名前>` に見える。渡し方は `features/runtime.md`「アプリのツールの受け渡し」に従う。

共通の決まり:

- どのツールも、呼び出した会話のプロジェクトの issue だけを扱う。issue は番号 (`number`) で指す
- どのツールも `alwaysLoad` を真にする。AI が毎回ツールを探さずに呼べるようにするためである
- 入力は Zod で検査し、合わなければ失敗を返す。失敗は `isError` を真にし、何が合わないかと、次にできることを日本語の 1〜2 文で返す
- ツールは状態を直接変えない。報告のツールは `flow` に渡し、`flow` が移り変わりの表で決める (`features/issue-flow.md`)
- 報告のツールは、その会話の issue (`conversations.issue_id`) についてだけ受け付ける。違う番号なら「この会話が扱う issue は #<番号> です」を返す
- 報告のツールは、状態が合わなければ「#<番号> はいま <状態の名前> なので、この報告を受け付けません」を返す
- ほかの機能が同じサーバーに載せるツールは、下の「ほかの機能のツール」の表にある。`alwaysLoad` と失敗の返し方の決まりは、それらにも当てはめる

issue を読み書きするツール:

| 名前 | 引数 | 戻り | 主な失敗 |
| --- | --- | --- | --- |
| `issue_get` | `number` | `IssueView` と同じ中身の JSON (番号で親・子・依存を示す) | 無い番号 |
| `issue_list` | `state?` (状態の値の配列)、`text?` (題名と本文に含む語)、`limit?` (1〜200、既定 50) | `number`・`title`・`state`・`priority`・`parent`・`dependsOn` の配列を JSON で。番号の小さい順 | 範囲の外 |
| `issue_create` | `title` (1〜200 字)、`body` (0〜50,000 字)、`parent?`、`depends_on?` (0〜50 件)、`priority?`、`kind?`、`confirm_before_merge?`、`designed?` | 「#<番号> を作りました。精査待ちです」と `{ "number": <番号> }` | 循環、無い番号、`designed` を渡せない会話 |
| `issue_update` | `number`、`title?`、`body?`、`parent?` (`null` で外す)、`depends_on?` (全体を置き換える)、`priority?`、`kind?`、`confirm_before_merge?` | 直した後の JSON | 下書き (「下書きは開発者がフォームで直します」)、閉じた issue、循環、無い番号 |
| `issue_comment` | `number`、`text` (1〜20,000 字) | 「#<番号> にコメントを書きました」 | 無い番号 |

- `issue_create` は確定済みで作る (BR-035)。`flow` が精査待ちに移し、`created` (`by: ai`、`conversationId`) を足し、`created_conversation_id` に呼び出した会話を入れる
- `issue_create` は、同じ会話から同じ題名の閉じていない issue が 10 分以内に作られていれば、新しく作らずにその番号を返す。文は「#<番号> は作成済みです」とする。AI が再開の後に同じ呼び出しを繰り返しても、issue を二重に作らないためである
- `issue_update` は状態を受けない。`edited` を足す。依存を変えたら `flow` が評価を行う
- `issue_comment` は `comment` を足す。payload は「`issue_events` に足す種類」の表のとおりである

報告のツール:

| 名前 | 引数 | 受け付ける状態 | 戻り | 正本 |
| --- | --- | --- | --- | --- |
| `report_triage` | `number`、`result` (`design` / `parent`)、`kind`、`urgent?` (緊急枠。真偽、既定は偽)、`score?` (0〜1000)、`summary` (1〜2,000 字) | 精査待ち | 移った先の状態を伝える文 | `features/issue-flow.md`「精査の結果」 |
| `report_design` | `number`、`policy` (修正方針。1〜20,000 字)、`checks` (人に確かめたい点。0〜50 件、1 件 2,000 字まで) | 設計待ち (設計書の PR の merge 待ちを除く) | 「設計レビューにしました。番を終えてください」 | `features/design-review.md`「設計の完了の記録」 |
| `report_needs_human` | `number`、`questions` (1〜20 件。`text` は 2,000 字まで、`options?` は 10 件まで)、`summary` (0〜2,000 字) | 精査待ち、設計待ち、実装中 | 「停止中にしました。番を終えてください。回答はこの会話に届きます」 | `features/issue-flow.md`「人の判断が要るとき」 |
| `report_stage` | `number`、`stage` (`review` / `pr` / `merge`) | 実装中 | 「記録しました」 | `features/implementation-flow.md`「実装の段階の記録」 |
| `report_ready_for_merge` | `number`、`pr_url?`、`head_sha` (40 桁の 16 進)、`rebased?` (既定は偽)、`summary` (0〜2,000 字) | 実装中 | 次にすることの文 | `features/implementation-flow.md`「PR の用意ができたとき」 |
| `report_ci_failed` | `number`、`checks` (1〜100 件。`name`、`bucket` (`fail` / `cancel` / `pending`)、`link?`)、`timed_out`、`summary` (0〜2,000 字) | 実装中 | 「停止中にしました。番を終えてください」 | `features/implementation-flow.md`「CI の失敗」 |
| `report_implementation_done` | `number`、`pr_url?`、`merge_commit` (40 桁の 16 進)、`summary` (0〜2,000 字) | 実装中 | 「完了にしました。番を終えてください」か、merge を確かめられない理由 | `features/implementation-flow.md`「完了」 |

- `report_triage` の `urgent` が真なら、優先度の無い issue を高にする (`features/issue-flow.md`「精査の結果」)
- `report_design` の `policy` が空白だけなら受け付けない (`features/design-review.md`)
- 承認のツールは作らない。承認は開発者だけが行う (BR-045)

ほかの機能のツール:

| 名前 | 引数 | 戻り | 正本 |
| --- | --- | --- | --- |
| `recap_read` | なし | その会話の目次と、決まったことの一覧の文字列 | `features/recap.md`「会話の AI が一覧を読む」 |

#### 会話の種類ごとに渡すツール

| 会話の種類 (`conversations.kind`) | 渡すツール |
| --- | --- |
| `chat` / `thread` | `issue_get`、`issue_list`、`issue_create`、`issue_update`、`issue_comment`、`recap_read` |
| `triage` | `issue_get`、`issue_list`、`issue_update`、`issue_comment`、`report_triage`、`report_needs_human`、`recap_read` |
| `design` | `issue_get`、`issue_list`、`issue_create`、`issue_update`、`issue_comment`、`report_design`、`report_needs_human`、`recap_read` |
| `impl` | `issue_get`、`issue_list`、`issue_create`、`issue_update`、`issue_comment`、`report_stage`、`report_ready_for_merge`、`report_ci_failed`、`report_implementation_done`、`report_needs_human`、`recap_read` |

- `designed` を付けて作れるのは、`chat`・`thread`・`design` の会話だけである。`/dev-spec` と、設計で分けた子のためである
- 精査・設計・実装の会話から分岐したスレッドは `thread` として扱い、報告のツールを渡さない。スレッドで尋ねても issue の状態は変わらない

### issue の扱いの追加の指示

ランナーは、どの会話の実行を開くときも、次の文を追加の指示として渡す (`features/conversation.md`「AI の実行の設定」)。既存のスキルが GitHub の issue を読み書きする手順を、アプリのツールに読み替えさせるためである。

```text
このプロジェクトの issue は、アプリ sukuna が管理しています。
- issue を読む・作る・直すときは、mcp__sukuna__ のツール (issue_get、issue_list、issue_create、issue_update、issue_comment) を使ってください。gh issue のコマンドと、GitHub の issue・ラベル・Project・sub-issues の API は使わないでください。
- issue の番号は、このプロジェクトの中の番号で、GitHub の issue の番号ではありません。PR の本文に Closes #<番号> などの、GitHub の issue を閉じるキーワードを書かないでください。
- issue の状態はアプリが決めます。ツールで状態を変えることはできません。
- スキル (dev-spec など) の手順が GitHub に issue を作るときは、issue_create で作ってください。親は parent、依存は depends_on で渡し、設計を終えた issue には designed: true を付けてください。設計書のコミットは、issue を作る前に既定ブランチへ入れてください。
- 作った issue は確定済みで、すぐに精査が始まります。
```

## 実装の配置

| 処理 | 層 | 実装先ファイル |
| --- | --- | --- |
| issue の項目・API・ツールの入出力の Zod のスキーマ | 共有 | `src/shared/issue/schema.ts` |
| 循環の検査、項目の長さと件数の検査、番号の書式 | 共有 (純粋な関数) | `src/shared/issue/rules.ts` |
| 一覧と内容の組み立て → issues, issue_dependencies, issue_events, conversations | ユースケース | `src/server/modules/issue/usecase/list-issues.ts`、`src/server/modules/issue/usecase/get-issue.ts` |
| 下書きの作成と編集 → issues, issue_dependencies | ユースケース | `src/server/modules/issue/usecase/save-draft.ts` |
| 確定・取り下げ・再開・確定後の編集の検査と、ランナーへの受け渡し | ユースケース | `src/server/modules/issue/usecase/request-issue-op.ts` |
| issue の読み書き (番号の採番を含む) | インフラ (Repository) | `src/server/modules/issue/adapter/issue-repository.ts` |
| API ハンドラ (本書の 7 本) | API ハンドラ | `src/server/modules/issue/adapter/issue-routes.ts` |
| 確定・取り下げ・再開・確定後の編集 → issues, issue_dependencies, issue_events | ユースケース | `src/runner/modules/flow/usecase/issue-ops.ts` |
| ランナーへの操作の受け口 (`/flow/issues/...`) | API ハンドラ (ソケット) | `src/runner/modules/flow/adapter/issue-ops-handler.ts` |
| AI に渡すツールの定義と登録 (`AppToolRegistry`) | インフラ (ツールの口) | `src/runner/modules/issue/adapter/app-tools.ts` |
| ツールの処理 (読む、作る、直す、コメント、報告を `flow` に渡す) → issues, issue_dependencies, issue_events | ユースケース | `src/runner/modules/issue/usecase/tool-handlers.ts` |
| 追加の指示の文 | ドメイン | `src/runner/modules/issue/domain/issue-instructions.ts` |
| 作成・編集の画面 (行の組み立て、入力欄、メニュー) | UI | `src/front/pages/issue/issue-form.tsx`、`src/front/pages/issue/issue-form-lines.ts` |
| issue の画面 (表示の切り替え、会話の表示の先頭と末尾の行) | UI | `src/front/pages/issue/issue-page.tsx`、`src/front/pages/issue/issue-head-lines.ts` |

- 循環の検査は、画面のサーバーとランナーの両方が使うので `src/shared` に置く。IO を持たない関数にする
- テーブルの定義は DESIGN.md「データスキーマ」参照

## エッジケースの決定

1. **空・最小データ**: 題名と本文が空の下書きも保存できる。確定は題名が要る。本文が空でも確定できる。プロジェクトに issue が 0 件なら、プロジェクトの画面が「issue はまだありません。Space o で作ります。」を出す (`features/inbox.md`)。子も依存先も無ければ、issue の画面のその行を出さない
2. **上限・境界値**: 題名 200 字、本文 50,000 字、依存 50 件、コメント 20,000 字を上限とし、ちょうどは通し、超えると `invalid_input` で保存しない。一覧の `limit` は 500 まで、ツールの `issue_list` は 200 まで。番号に上限は設けない
3. **エラー時に利用者へ見えるもの**: 保存と確定の失敗は、`message` をエラーのお知らせに出し、入力欄と書いた値を残す。循環は、循環している番号の並びを出す。ランナーにつながらないときの確定・取り下げ・再開は、何も変えずに `runner_unavailable` の文を出す。本人の判定は DESIGN.md「横断規約 > 本人の判定」参照
4. **並行操作・二重実行**: 確定・取り下げ・再開は、ランナーが状態の検査と移り変わりを 1 つのトランザクションで行うので、2 回目は `conflict` になる。下書きの編集と確定が重なったら、先にトランザクションを取った方が効き、確定の後の下書きの編集は `confirmed_text_locked` か `conflict` になる。AI の `issue_create` の繰り返しは、10 分以内の同じ題名を作成済みとして返す
5. **再表示時の整合**: 画面は `issue:<id>` の配信を受けると `GET /api/issues/:id` を読み直す。作成・編集の画面も、ほかの端末で保存された値をこれで受ける (DESIGN.md「横断規約 > 配信」)
6. **表示の寿命**: 「#<番号> を確定しました」などの成功のお知らせは 4 秒で消える。エラーのお知らせは Esc で消すまで残る (DESIGN.md「横断規約 > アプリシェル」)。issue の画面の末尾の止まった行は、その状態のあいだだけ出す
7. **送る前のデータ**: 下書きの項目は、入力欄で `Enter` を押すたびにサーバーへ保存し、どの端末でも同じにする (P1)。入力欄で `Esc` で閉じた値は、ブラウザのタブの中だけに残す。下書きは、確定するか取り下げるまで残る
8. **状態の移り変わり**: 下書き → 確定 → 精査待ち。完了と取り下げ以外 → 取り下げ。完了か取り下げ → 再開 → 精査待ち。そのほかは `features/issue-flow.md` の表のとおりである
9. **自動で進むこと**: 確定すると精査が自動で始まる。取り下げは、依存する issue を自動で停止中にし、動いている AI を止める。再開は、依存先の取り下げで止まった issue を自動で戻す。開発者の書いた下書きを、自動で確定することはしない (P2)
10. **端末と画面をまたぐこと**: 項目・状態・下書きはサーバーに置き、どの端末でも同じにする (P1、P3)。どの表示 (会話・設計・差分) と、どの会話を表示しているかは、ブラウザのタブごとに持つ
11. **並びと数え方**: 子と依存先の行は番号の小さい順、会話のメニューは精査・設計・実装の順、コメントは古い順に並べる。API の一覧は番号の大きい順、ツールの `issue_list` は番号の小さい順とする。番号は 1 から数える

## テスト方針

| 受け入れ基準 (docs/design/USECASES.md) | レベル |
| --- | --- |
| （US-004）題名と本文を書いて下書きとして保存すると、issue は下書きになり、AI は動かない | 結合 |
| （US-004）下書きの issue を確定すると、issue が精査待ちになる | 結合 |
| （US-004）題名が空のまま確定しようとすると、題名が要ることが表示され、確定されない | 単体 + 結合 |
| （US-006）issue に親を指定すると、親の issue の下に子として表示される | 単体 + 結合 |
| （US-006）issue に依存を指定すると、依存先がすべて閉じるまで、その issue の実装は始まらない | 結合 |
| （US-006）依存が循環する指定をすると、循環している issue が示され、保存されない | 結合 |
| （US-006）親か依存を指定した issue で、あとから親か依存を外すと、親の下の表示と、外した依存先の待ちが無くなる | 結合 |
| （US-007）issue の優先度を決めると、実装待ちの issue が、優先度の高い順に始まる | 結合 |
| （US-007）優先度を指定せずに確定すると、精査の AI が優先度を付け、あとから変えられる | 結合 |
| （US-006）子の issue がすべて閉じると、親の issue が閉じる | 結合 |
| （US-005）issue を取り下げると、その issue に依存する issue が停止中になる | 結合 |
| （US-080）会話の中で AI に issue の作成を頼むと、確定済みの issue が作られ、作った会話から開ける | 結合 |
| （US-005）issue を取り下げると、動いている AI が止まり、issue が閉じる | 結合 |
| （US-044）閉じた issue を再開すると、それまでの会話と記録を保ったまま、issue が精査待ちになる | 結合 |
| （US-024）issue を作り、確定し、編集するまでを、Vim と同じ操作感のキーボード操作だけで行える | E2E |

- 結合: 画面のサーバーとランナーを、本物の SQLite で動かす。Agent SDK は台本どおりに動く偽物に差し替え、台本でアプリのツールを呼ばせる。偽物は、名前が `mcp__sukuna__` で始まるツールの呼び出しでは、登録した処理を実際に呼ぶ (`features/runtime.md`)
- 題名が空の行は、画面のサーバーが `title_required` を返すことを結合で、作成・編集の画面がその応答でお知らせを出してカーソルを題名の行へ移すことを単体で確かめる。表示の文言は単体で完全一致に比べる
- 親の行は、issue の画面の先頭の行の組み立てを、`IssueView` の見本から単体で確かめる。親を保存すると `children` に入ることは、循環の行の結合テストと同じテストで確かめる
- 循環は、`rules.ts` の単体テストでも、自分自身・2 件・3 件の循環と、依存と親を別々にたどることを確かめる
- 優先度の行は、実装待ちの issue を 3 件 (高・中・低) 用意し、上限 1 で高から順に始まることを確かめる。並びの規則の全体は `features/implementation-flow.md` のテストが持つ
- AI に作らせる行は、`chat` の会話の台本が `issue_create` を呼ぶと、精査待ちの issue ができ、`createdConversationId` がその会話になることを確かめる。会話の中のツールの行から issue を開く表示は `features/conversation.md` の単体テストが持つ。作った会話を削除すると `createdConversation.deleted` が真になり、行が「作った会話は削除されています」になることも確かめる
- 取り下げの 2 行は、偽物の AI が作業中 (`hold`) の issue を取り下げると、会話が止まり、状態が取り下げになり、依存元が停止中 (`dependency_withdrawn`) になることを 1 つのテストで確かめる
- ツールの検査 (別の issue への報告、状態の合わない報告、下書きの `issue_update`、`designed` を渡せない会話) は、`tool-handlers.ts` の結合テストで確かめる
- E2E: `Space o` で画面を開き、`i` で題名と本文を書き、「確定する」を番号 + `Enter` で実行し、プロジェクトの画面の `cc` で開いた編集の画面で優先度を変えるまでを、キーボードだけで行う。確定の後に精査が始まったことは、issue の画面に精査の会話が出ることで確かめる

E2E 対象動線: （US-024）issue を作り、確定し、編集するまでを、Vim と同じ操作感のキーボード操作だけで行える
