# Vim のバッファの土台

- 種別: 機能設計書
- 対象 UC: なし (タスク説明から起こした)

## 何を作るか

アプリのすべてのウィンドウを、Vim と同じキーで読める読み取り専用のバッファとして作る土台を作る。

**使う人**: 開発者 (PC のブラウザで、キーボードだけで操作する)。ほかの機能を実装する AI は、この土台の上に画面を作る。

**流れ**:

1. 開発者が画面を開くと、左にツリー、中央に主のウィンドウ、下にステータス行が出る
2. Vim と同じキーでカーソルを動かし、検索し、選ぶ。Enter で行の先を開き、操作の行を実行する
3. Space を押すと、続けて押せるキーの候補が出る。コロンを押すと、コマンドを打てる
4. i を押すと入力欄が開き、Vim と同じモードで書く。Normal モードで Enter を押すと送る
5. 再読み込みしても、そのタブで見ていた画面・カーソル・右のウィンドウに戻る

**主な決まり**:

- どのウィンドウも中身は本物の文字の行で、列や印や枠は見た目だけで付ける (DESIGN.md「画面の共通の作り」)
- AI の出力が増えても、回数の入力・ビジュアルモード・検索の入力は保たれる。カーソルも動かないが、末尾について行く画面で最後の行にいるときは新しい最後の行へ移る
- 発言者の札、区切り、列の見出し、空の行にはカーソルを置けない。開ける見出しには置ける
- 操作と選択肢は番号付きのメニューの行に並べ、行で Enter か、番号を押してから Enter で実行する
- 取り返しのつかない操作は、実行の前に y / n の確認を挟む
- キーの割り当ては設定で自由に変えられ、ヒントとヘルプは今の割り当てを表示する (BR-070)
- 入力欄は Vim と同じモードを持ち、Ctrl+[ は Esc と同じ働きをする (BR-010、BR-062)

## 入出力と振る舞い

### この機能の前提

- 本書は、バッファの行の種類と見た目、追記と書き換え、カーソルの決まり、ウィンドウの構成、キーとコマンドの仕組みと既定の割り当て、メニューの行、確認、入力欄、ステータス行、位置の記憶の正本である
- 本書は、末尾の区画、画面の URL、ジャンプの履歴の正本でもある
- 各画面に何の行を並べるかと、各動作の中身は、その画面を持つ機能設計書が決める。本書は、キーから動作の名前への対応と、動作の呼び出しだけを持つ
- お知らせ、ErrorBoundary、読み込み中、つながらないときの表示は DESIGN.md「横断規約 > アプリシェル」が正本である。本書の枠の中に置く
- キーの割り当ての保存と API は `features/operations.md` が持つ。本書は、設定から受け取る形と、その当て方を決める
- 画面の見本は `docs/design/UI_SKETCH.html` の PC の画面である。寸法と色は本書の「見た目の決まり」を正とする
- キー操作への応答の基準 (キーから 0.1 秒以内、BR-072) は、`features/operations.md` が受け入れ基準として測る。本書はその作りを持つ

### 行の種類と装飾の持ち方

バッファの 1 行は、本物の文字列と、行の情報の組である。行の情報の形は `src/front/buffer/line.ts` が正本である。

```ts
type LineInfo = {
  kind: LineKind;
  text: string; // 画面に出る本物の文字列。桁を持つ行は、桁を空白 2 つでつないだもの
  cols?: string[]; // 桁を持つ行の桁ごとの文字
  colDef?: string; // 桁の定義の名前 (幅と色)
  id?: string; // 並べ替えのときにカーソルが追う識別子 (例: "issue:01H...")
  target?: OpenTarget; // Enter で開く先
  action?: string; // メニューの行の動作の名前
  main?: boolean; // 主の操作
  danger?: boolean; // 止める・解除する操作
  done?: boolean; // 選んだ選択肢
  mark?: string; // 印の桁に出す 1 文字
  tone?: "wait" | "doing" | "done" | "muted"; // 状態の色
  strong?: boolean; // 未読の題名など
  seq?: number; // 会話の行の元になったイベントの seq
  seqLine?: number; // 引用の位置に使える行だけ。そのイベントを並べた行のうち何行目か (0 から)
};
```

- 会話の行は、元になったイベントの `seq` を持つ。読んでいた位置 (`features/recap.md`) は、カーソルの行の `seq` で決める
- `seqLine` は、引用の位置に使える行 (発言・ツールの実行・差分の本文) だけが持つ。畳んだ差分は、開いた状態で数える。引用の形は `features/stock-thread.md`「引用の持ち方」が正本である
- どの行にどの `seq` と `seqLine` を付けるかは `features/conversation.md`「会話に並べる行」が決める

| 種類 | 用途 | 見た目 | カーソル |
| --- | --- | --- | --- |
| `heading` | 節の見出し | 13px 太字の ink、下に 1px の線。上に 14px。ツリーでは 12px の muted で線なし | Enter で開ける見出しだけ置ける |
| `section` | 一覧の区分の見出し (件数つき) | 1 桁目 13px 太字、2 桁目 12px 等幅の muted。上に 8px | Enter で開けるときだけ置ける |
| `colhead` | バッファの中に置く列の見出し | 12px の muted、下に 1px の線 | 置けない |
| `speaker` | 発言者の札 (あなた、AI) | 「発言の帯と札」 | 置けない |
| `text` | 発言と文書の本文 | 既定の文字 | 置ける |
| `ask` | AI が判断を求める質問の文 | 太字 | 置ける |
| `tool` | ツールの実行 | 等幅 12px の muted | 置ける |
| `add` / `del` | 差分の追加と削除の行 | 等幅 12px、地の色 add / del、角なし | 置ける |
| `code` | コードとファイルの中身 | 等幅 13px、空白をそのまま出す | 置ける |
| `note` | 補足と、中身が空のときの案内 | 13px の muted | 置ける |
| `separator` | 「ここから未読」などの区切り | accent の 12px、中くらいの太さ | 置けない |
| `menu` | 操作と選択肢 | 「メニューの行」 | 置ける |
| `row` | 桁を持つ行 (一覧、検索の結果など) | 桁の定義の幅と色 | 置ける |
| `pair` | 項目と値、キーと動作の組 | 1 桁目 muted、桁を揃える。値が折り返したら 2 行目も値の位置から | 置ける |
| `queued` | 届く前の指示 | doing の色 | 置ける |
| `tree` | ツリーとファイルの一覧 | 等幅 13px、空白をそのまま出す。フォルダの行は 12px の muted | 置ける |
| `skeleton` | 読み込み中 | raised の帯 (幅 60%、高さ 12px) が明滅する | 置ける |

- 種類を足すときは本書に足す。各機能は、この表の種類だけを使う
- 桁を持つ行の幅と色は、桁の定義 (`ColumnDef`) で渡す。ウィンドウの見出しに置く列の見出しも、同じ定義から作る

```ts
type ColumnDef = {
  name: string;
  widths: number[]; // 桁ごとの幅 (rem)。0 は残りの幅
  heads?: string[]; // 列の見出し
  align?: ("left" | "right")[];
  classes?: string[]; // 桁ごとの文字の大きさと色
};
```

- 桁の幅は `min(<幅>rem, <比率>cqw)` とし、ウィンドウが狭いときは同じ比率で縮める。はみ出した文字は「…」で切る
- 状態の色 (`tone`) は、行の文字か桁にだけ付ける。地の色には使わない

#### 発言の帯と札

- 札 (`speaker`) の行から、次の札か `separator`・`heading`・`section`・`row`・`note`・`queued` の行の手前までを、その発言者の発言とする
- あなたの発言の行は、地の色を raised にし、左に 3px の accent の帯を引く。右の余白は 16px で、発言の最初と最後の行の右の角を 8px 丸める
- AI の発言の行は、左に 3px の帯 (ink を 28% にした色) を引く
- 発言の行の左の余白は 12px、外の左の余白は 8px とする
- 札の文字は 12px 太字、角 4px で、あなたは accent の地に surface の字、AI は raised の地に ink の字とする。札の行の上に 4px 空ける
- メニューの行は発言の帯の外に置き、帯はメニューの行の前後の隙間で途切れさせる

#### 印の桁と行番号

- 印の桁は、印が無い行でも幅を取る。幅はツリー 16px、一覧 24px、主のウィンドウ 20px、表の形の画面 20px、右のウィンドウ 16px とする
- 印の文字は accent の太字 12px で、一覧だけは 8px (未読の点) とする。どの文字を出すかは各機能が決める
- 行番号は絶対行番号とし、主のウィンドウ・一覧・表の形の画面にだけ出す。幅 2.5rem の右寄せ、等幅 12px の muted で、カーソルの行は ink にする

### 追記と行の書き換え

FEASIBILITY.md「PoC 結果 > codemirror-vim-buffer」の推奨アプローチを契約にする。

1. `EditorView` と `EditorState` は、ウィンドウの中身を開くときに 1 度だけ作る。追記と書き換えでは `setState` を呼ばない
2. 行の情報の配列と `DecorationSet` を 1 つの `StateField` に持ち、`EditorView.decorations.from(field)` で装飾を渡す。印の桁、行番号、カーソルを置けない行の判定も、この `StateField` から行を読む
3. 追記・書き換えは、`changes` (文字の変更)、`effects` (新しい行の情報を載せた `StateEffect`)、`annotations` (追記用の `Annotation`) を 1 つの transaction にして dispatch する。`scrollIntoView` と `selection` は付けない
4. 読み取り専用は、`EditorState.readOnly`、`EditorView.editable(false)`、`changeFilter` で作る。`changeFilter` は追記用の `Annotation` が付いた transaction だけを通す。`filter: false` は使わない
5. `StateField` の更新では、`DecorationSet` を `tr.changes` で写し、変わった範囲の装飾を消して作り直す。範囲は、追記なら前の最終行から末尾まで、書き換えなら書き換えた行の 1 行前から 1 行後までとする
6. 発言の帯の持ち主は、作り直す範囲の手前から、札か区切りの行まで遡って求める
7. React のバッファの部品は、届いた行の差分を dispatch に変える。行の配列全体を比べて作り直すことはしない

バッファの部品 (`Buffer`) は、次のものを受け取る。

```ts
type BufferProps = {
  side: "tree" | "list" | "table" | "main" | "right"; // 文字の大きさ・行の高さ・印の桁の幅を決める
  posKey: string; // 位置の記憶の鍵 (画面の URL・ウィンドウ・表示)
  lines: LineInfo[]; // 開いたときの行
  columns?: ColumnDef[]; // 桁を持つ行の定義
  startLine?: number; // 覚えた位置が無いときに最初に置く行
  followTail?: boolean; // 末尾について行く
  onReady(handle: BufferHandle): void; // 下の表の操作を持つ
};
```

バッファの部品が外へ出す操作は次のとおりである。

| 操作 | 使う場面 | カーソル |
| --- | --- | --- |
| `append(lines, clearTail?)` | AI の出力の追記、一覧の続きの読み込み。末尾の区画があれば、その手前に足す。`clearTail` に名前を渡した区画は、同じ transaction で空にする | 動かさない。「末尾について行く」を指定したときだけ動かす |
| `replace(from, to, lines)` | 選択肢の選んだ印、ツールの結果の差し込み、畳んだ差分を開く | 範囲の中にあれば、同じ行番号 (範囲の新しい最後の行までに詰める) と同じ桁に置く。範囲の外なら、文字の変更に合わせて動く |
| `setTail(part, lines)` | 末尾の区画の 1 つを丸ごと置き換える (「末尾の区画」) | `replace` と同じ |
| `replaceAll(lines)` | 一覧の並べ替え、画面の読み直し | 前の行と同じ `id` の行へ移る。無ければ同じ行番号に詰めて置く (BR-083) |
| `jumpTo(line)` | 目次の章、引用の箇所、検索の結果の行へ移る | その行へ移る。移る前の位置をジャンプの履歴に積む (「ジャンプの履歴」) |
| `pushJump(line)` | 移らずに、位置をジャンプの履歴に積む (例: 前回読んでいた位置) | 動かさない |
| `findSeq(seq, seqLine?)` | イベントの `seq` (と何行目か) から行番号を求める | 動かさない。無ければ `null` を返す |

- 末尾について行く: `append` か `setTail` の前にカーソルが最後の行にあり、ビジュアルモードでも操作の途中でもないときは、変更のあとカーソルを新しい最後の行へ移して見える位置に出す。使うかは各機能が決める (BR-093 は `features/conversation.md`)
- 書き換えでカーソルがカーソルを置けない行に乗ったら、「カーソルを置けない行」の決まりで動かす

#### 末尾の区画

会話のバッファの最後には、イベントの追記とは別に書き換える区画を置く。区画は名前を持ち、各機能が決めた順に並ぶ。会話の区画は次のとおりである。

| 区画 | 中身 | 書き換えるとき |
| --- | --- | --- |
| `reply` | AI の書きかけの発言 | 配信の `delta` が届くたび |
| `question` | 選択式の質問と許可の確認の区画 | 質問と回答の状態が変わるたび |
| `queue` | 届く前の指示の行 | 届く前の指示が変わるたび |

- 区画の中身と並び、区画の行をいつ確定した行に移すかは `features/conversation.md` が決める。本書は書き換えの仕組みだけを持つ
- 区画の行を確定した行に移すときは、`append` の `clearTail` に区画の名前を渡す。区画を空にすることと追記が 1 つの transaction になる
- 1 回の描画の間に届いた複数の追記は、1 つの transaction にまとめて当てる。追記が続いても、キーの操作への応答を待たせないためである (BR-072)
- `append` は、末尾の区画の手前に行を足す。区画はいつも最後に残る
- `setTail` は、その区画のいまの行を丸ごと置き換える。空の配列を渡すと区画を消す
- AI の書きかけの発言は、`delta` の文字を足した全文で `reply` を置き換える (`features/runtime.md`「配信 (`/ws`)」)
- 同じ発言の保存したイベント (`assistant_text`) が届いたら、`clearTail` に `reply` を渡してその行を `append` する。画面に同じ文が 2 回出る瞬間を作らない
- 番の終わり (`turn_end`) が届いたときも `reply` を空にする。書きかけは保存しないので、開き直すと保存した発言だけが出る

### カーソルを置けない行

次の行にはカーソルを置けない。

- `speaker` (発言者の札)、`separator` (区切り)、`colhead` (列の見出し)
- 開く先 (`target`) の無い `heading` と `section`
- 文字が空白だけの行 (`skeleton` は除く)

カーソルの動きは次のとおりにする。

- カーソルがこれらの行に乗ったら、動いてきた向きに、置ける行まで進める。動く前より上の行に乗ったときは上へ、それ以外は下へ進める
- 進めた先がバッファの端を越えたら、乗った行から逆の向きに、置ける行を探して置く
- 置ける行が 1 行も無いバッファでは、カーソルは 1 行目に置いたまま動かさない
- ビジュアルモードのあいだは動かさない。選んだ範囲には、これらの行も含められる
- 開いたときのカーソルは、覚えた位置か、各機能が指定した行 (例: 未読の先頭) か、最初の中身の行に置く。指定の行が置けない行なら、下へ、無ければ上へ探す

### ウィンドウの構成と移動

| ウィンドウ | 位置と幅 | 中身の例 | 文字と行の高さ |
| --- | --- | --- | --- |
| ツリー | 左、15rem | 一覧、プロジェクト、会話、issue | 13px / 26px |
| 主のウィンドウ (一覧) | 中央、残りの幅。中身は 64rem まで | 一覧 | 14px / 26px |
| 主のウィンドウ (表の形の画面) | 中央、残りの幅。中身は 64rem まで | プロジェクトの画面、ヘルプ、設定、検索の結果 | 14px / 26px |
| 主のウィンドウ (会話と文書) | 中央、残りの幅いっぱい | 会話、ファイル、設計、差分 | 15px / 24px |
| 右のウィンドウ | 右、23rem。必要なときだけ出す | 直近、目次、決まったこと、ストック、スレッド、タイムライン、ファイルツリー、会話を始める・切り替える、worktree | 13px / 22px |
| 入力欄 | ウィンドウの下。開いたときだけ出す (`i`、設定の画面の文字の値の行の Enter、入力欄を開くメニューの行) | 指示、質問、項目の値 | 15px / 24px |

- ウィンドウの上に、高さ 36px の見出しを置く。操作中のウィンドウの見出しは ink の太字にし、左に 6px の accent の点を付ける。ほかのウィンドウの見出しは muted にする
- 見出しの下に、必要なら列の見出しか issue の中の表示の並び (`features/issue.md`) を置く
- 画面の下から順に、ステータス行、確認、コマンド行、Space の候補、入力欄を積む。出ていないものは場所を取らない
- ヘッダーは置かない (DESIGN.md「横断規約 > アプリシェル」)

ウィンドウの間の移動は次のとおりにする。

- `Ctrl+w h` / `Ctrl+w l` で、ツリー・主のウィンドウ・右のウィンドウの並びを左右に移る。端では動かない
- `Ctrl+w j` で入力欄へ、`Ctrl+w k` で主のウィンドウへ移る。入力欄は開いたままにする
- マウスでウィンドウを選ぶと、そのウィンドウへ移る。行のダブルクリックは Enter と同じにする
- 確認・コマンド行・Space の候補を閉じたら、操作していたウィンドウに戻る

右のウィンドウの決まりは次のとおりにする。

- 右のウィンドウは、開いた表示の順を覚える。別の表示を開くと、今の表示を順の最後に積む。同じ表示は 2 度積まない
- `Ctrl+h` か `-` で 1 つ前の表示へ戻る。積んだ表示が無ければ閉じる。`q` か `:q` で閉じ、積んだ順も消す
- 移った先が会話・issue・ファイルの画面なら、右のウィンドウを保ち、移った先の中身に切り替える。それ以外の画面へ移ると閉じる
- 直近は例外で、別の会話へ移ると閉じる。移った先で開き直すかは `features/recap.md` が決める
- 「会話を始める・切り替える」(`Space n`) は、どの画面でも右のウィンドウに開ける。行の中身と並びは `features/conversation.md` が決める
- 「会話を始める・切り替える」で会話か issue の行を選ぶと、主のウィンドウにそれを開き、右のウィンドウは開いたまま残す。会話を始める行を選ぶと閉じる
- 主のウィンドウで押した `q` でも、右のウィンドウを閉じる

### キーの割り当て

#### 仕組み

キーは、動作の名前に対応づける。動作の中身は各機能が登録し、本書はキーから動作を呼ぶだけを持つ。

```ts
type ActionDef = {
  name: string; // 例: "stock.question"
  label: string; // ヘルプと Space の候補に出す説明
  group: HelpGroup; // ヘルプの節
  where: string; // 使える場所の説明 (例: "会話")
  fromPrompt?: boolean; // 入力欄からも呼べる
  views?: string[]; // 使える表示の名前に絞る (例: 目次と決まったことの表示)。ほかの表示では Vim の組み込みの動きに渡す
  run(ctx: ActionContext): void | Promise<void>;
};
type KeymapEntry = {
  keys: string; // Vim の記法 (例: "<Space>q", "<C-w>h", "dd")
  context: "normal" | "visual" | "prompt" | "terminal";
  to: { action: string } | { keys: string } | null; // 動作、Vim のキー列、割り当てを外す
};
// 設定の keymap の値は { version: 1, entries: KeymapEntry[] }
```

- 今の割り当ては、既定の割り当てに、設定の `entries` を順に当てたものである。同じ `keys` と `context` の行は、設定の方で置き換える。`to` が `null` なら、そのキーの割り当てを外す
- 設定に保存するのは、既定との差分の `KeymapEntry` だけである。保存の API と重なりの確かめ方は `features/operations.md` が持つ
- `:map` は新しいキーの行を 1 つ足すだけで、その動作の前のキーは残る。前のキーを外すときは `:unmap` を使う
- `to` が `keys` の行は、Vim の `noremap` と同じく、別のキー列として扱う。Vim の移動のキーもこれで変えられる
- アプリの動作を Vim の組み込みのキー (例: `j`) に割り当てると、そのキーでは Vim の動きの代わりにアプリの動作が呼ばれる
- `views` を持つ動作は、操作中のウィンドウの表示が `views` にあるときだけ呼ばれる。ほかの表示では、そのキーを Vim の組み込みの動きに渡す。目次と決まったことの `/` がこの形である
- `views` が重ならない動作どうしは、同じキーに割り当ててよい。キーを押すと、操作中のウィンドウの表示を `views` に持つ動作を呼ぶ。`zo` と `zc` がこの形で、差分の表示では差分を、ファイルツリーではフォルダを開け閉めする
- 今の割り当ては、読み取り専用のバッファでは `Vim.mapCommand` と `Vim.defineAction` で当てる。入力欄とターミナルでは本書のキーの受け口で当てる
- 設定が変わったら (配信の `app` の `settings_changed`。`features/runtime.md`)、設定を API で読み直し、アプリの割り当てを全部外してから当て直す。開いている画面はそのまま使える
- 重なりの判定は `findConflicts(今の割り当て, 新しい行)` で行う。同じ `context` で `keys` が同じ行か、一方がもう一方の先頭と一致する行 (例: `<Space>s` と `<Space>sa`) を返す。Vim の組み込みのキーも含める。`views` が重ならない動作どうしは重なりに数えない。重なりを示して選ばせる確認は `features/operations.md` が持つ

キーの表記は、設定では Vim の記法、画面では読みやすい表記にする。変換は `src/front/buffer/keymap/notation.ts` で行う。

| Vim の記法 | 画面の表記 |
| --- | --- |
| `<Space>q` | Space q |
| `<C-w>h` | Ctrl+w h |
| `<CR>` | Enter |
| `<A-CR>` | Alt+Enter |
| `<Esc>` | Esc |

- Ctrl を使うキーは macOS のブラウザを前提にする。割り当てたキーでは、ブラウザの既定の動きを止める
- `Ctrl+[` は、どこでも `Esc` として扱う。キーの位置ではなく文字で判定し、JIS 配列でも効くようにする (BR-062)
- IME が変換中のキー (`isComposing`) には、アプリの動作を割り当てない

#### 既定の割り当て

「処理を持つ機能」の動作の中身は、その機能設計書が持つ。`buffer-ui` の動作は本書が持つ。

| キー | 動作の名前 | 動作 | 使える場所 | 処理を持つ機能 |
| --- | --- | --- | --- | --- |
| Enter | `open` | 行の先を開く。メニューの行では実行する。設定の画面の値の行では値を変える (`features/project-settings.md`) | Normal | `buffer-ui` |
| 番号 + Enter | `open` | その番号のメニューの行を実行する | Normal | `buffer-ui` |
| `-` | `back` | 1 つ前の画面へ戻る。右のウィンドウでは 1 つ前の表示へ | Normal | `buffer-ui` |
| `:` | `cmdline` | コマンド行を開く | Normal、Visual | `buffer-ui` |
| `q` | `right.close` | 右のウィンドウを閉じる | Normal | `buffer-ui` |
| `Ctrl+h` | `view.prev` | 右のウィンドウでは 1 つ前の表示へ。issue の主のウィンドウでは前の表示へ | Normal | `buffer-ui`、`issue` |
| `Ctrl+l` | `view.next` | issue の主のウィンドウで次の表示へ | Normal | `issue` |
| `Ctrl+o` | `jump.back` | ジャンプの履歴を 1 つ戻る (「ジャンプの履歴」) | Normal | `buffer-ui` |
| `Ctrl+w h` / `Ctrl+w l` (`Ctrl+w Ctrl+h` / `Ctrl+w Ctrl+l`、`Space w h` / `Space w l`) | `win.left` / `win.right` | 左 / 右のウィンドウへ | Normal、入力欄 (Normal) | `buffer-ui` |
| `Ctrl+w j` / `Ctrl+w k` (`Space w j` / `Space w k`) | `win.down` / `win.up` | 入力欄へ / 主のウィンドウへ | Normal、入力欄 (Normal) | `buffer-ui` |
| `Space p` | `tree.focus` | ツリーへ移る | Normal | `buffer-ui` |
| `i` / `a` | `prompt.open` | 入力欄を開く。値の行では値を書く | Normal | `buffer-ui` (開く)、各機能 (送り先) |
| `dd` | `item.delete` | 行の対象を取り消す・消す | Normal | 各機能 |
| `cc` | `item.edit` | 行の対象を直す | Normal | 各機能 |
| `u` | `item.undo` | 取り消しを戻す | Normal | 各機能 |
| `]c` / `[c` | `mark.next` / `mark.prev` | 次 / 前の印へ | Normal | `stock-thread` |
| `]t` / `[t` | `timeline.next` / `timeline.prev` | 次 / 前のタスクの木を出す | Normal (タイムライン) | `work-monitor` |
| `gf` | `files.open-path` | カーソルの下の語をパスとして開く | Normal (会話) | `files` |
| `zo` | `diff.expand` | 畳んだ差分を開く。「残り n 行」の行の Enter でも開く | Normal (会話、設計の表示、差分の表示) | `conversation`、`design-review`、`pr-review` |
| `zc` | `diff.collapse` | 開いた差分を畳む | Normal (会話、設計の表示、差分の表示) | `conversation`、`design-review`、`pr-review` |
| `zo` / `zc` | `files.folder-open` / `files.folder-close` | フォルダを開く / 閉じる。フォルダの行の Enter でも開け閉めする。`l` と `h` は Vim のままにする | Normal (ファイルツリー) | `files` |
| `/` | `recap.search` | 目次と決まったことを検索する。ほかの表示では Vim の検索 | Normal (目次、決まったこと) | `recap` |
| `Space q` / `Space c` | `stock.question` / `stock.instruct` | 選んだ箇所に質問 / 指示を書いてストックする | Normal、Visual | `stock-thread` |
| `Space l` | `stock.list` | ストックの一覧 | Normal | `stock-thread` |
| `Space s a` / `Space s q` / `Space s c` | `stock.send.all` / `stock.send.questions` / `stock.send.instructions` | ストックを全部 / 質問だけ / 指示だけ送る | Normal | `stock-thread` |
| `Space s g` | `stock.publish` | 選んだ指示を PR のレビューコメントとして GitHub に投稿する | Normal (ストックの一覧) | `pr-review` |
| `Space r` | `thread.list` | スレッド | Normal | `stock-thread` |
| `Space i` / `Space m` / `Space d` | `recap.recent` / `recap.toc` / `recap.decisions` | 直近 / 目次 / 決まったこと | Normal (会話) | `recap` |
| `Space t` | `timeline.open` | タイムライン | Normal | `work-monitor` |
| `Space e` | `files.tree` | ファイルツリー | Normal | `files` |
| `Space /` | `files.grep` | ファイルの中身を検索する | Normal | `files` |
| `Space v` | `files.markdown-toggle` | Markdown の整えた表示とソースの表示を切り替える | Normal (Markdown のファイル) | `files` |
| `Space f` | `search.open` | issue と会話を検索する | Normal | `conversation-lifecycle` |
| `Space n` | `conversation.switch` | 会話を始める・切り替える | Normal | `conversation` |
| `Space b` | `conversation.list` | 会話とスレッドの一覧 (閉じたものを含む) | Normal | `conversation-lifecycle` |
| `Space z` | `conversation.close` | 会話を締めくくる | Normal (会話) | `conversation-lifecycle` |
| `Space x` | `agent.stop` | AI を止める | Normal (会話、issue) | `conversation` |
| `Space o` | `issue.new` | issue を作る | Normal | `issue` |
| `Space k` | `worktree.list` | worktree | Normal | `worktree-terminal` |
| `Space g` | `terminal.open` | ターミナル | Normal | `worktree-terminal` |
| `Space h` | `home` | 一覧を開く | Normal | `inbox` |
| Enter | `prompt.submit` | 送る | 入力欄 (Normal) | `buffer-ui` (呼ぶ)、各機能 (送る) |
| Alt+Enter | `prompt.interrupt` | AI を止めてすぐ送る | 入力欄 (Normal、AI が作業中) | `conversation` |
| Tab | `prompt.complete` | スキルの候補を入れる | 入力欄 (`/` で始めたとき) | `buffer-ui` (入れる)、`conversation` (候補) |
| `Ctrl+]` | `terminal.normal` | Normal モードへ戻る。`:tmap` で割り当てを変えられる (BR-061) | ターミナルの入力中 | `worktree-terminal` |

- 表の「処理を持つ機能」の名前は、`features/<名前>.md` の機能設計書を指す
- `h j k l`、`w b e`、`0 ^ $`、`gg G`、`{ }`、`Ctrl+d Ctrl+u`、`/ ? n N *`、`f t ; ,`、`v V Ctrl+v`、テキストオブジェクト、`y` は Vim のままにする。`/` は、目次と決まったことの表示でだけアプリの動作になる
- 確認の `y` と `n` は割り当ての対象にしない。確認は 1 回の答えで、操作のキーではないためである
- 読み取り専用のバッファでは、`i` と `a` で入力欄を開き、Insert モードには入らない。`dd` と `cc` は Vim に渡さず、行の対象の取り消しと編集に使う。`]c` / `[c` の 2 打目の `c` は、`cc` の 1 打目に数えない
- `Space` の Vim の既定の動き (右へ 1 文字) は外す。`Ctrl+w` の Vim の既定の動きも外す

#### Space のあとのキー

Space を押すと、ステータス行の上に、続けて押せるキーの候補を出す。候補は今の割り当てのうち、`<Space>` で始まるものから作る。

| Space のあと | 候補 |
| --- | --- |
| (Space だけ) | q 質問、c 指示、l ストック、s +送る、r スレッド、i 直近、m 目次、d 決まったこと、t タイムライン、e ファイル、/ 中身を検索、v Markdown の表示を切り替える、f issue と会話を検索、n 会話を始める・切り替える、b 会話とスレッドの一覧、z 会話を締めくくる、o issue を作る、k worktree、g ターミナル、h 一覧、p ツリー、x AI を止める、w +ウィンドウ |
| `s` | a 全部送る、q 質問だけ送る、c 指示だけ送る、g GitHub に投稿する |
| `w` | h 左へ、l 右へ、j 入力欄へ、k 会話へ |

- 候補の並びは、既定の割り当ての順に、設定で足したものを後ろに続ける。続けて押せるキーの組は「+」を付けた名前で出す
- 候補の欄の先頭に、押したキー (例: 「Space s」) を accent の等幅の太字で出す。キーは等幅の ink、説明は muted の 12px で、1 つの幅 11rem 以上で詰めて並べる
- 候補は、次のキーを押すまで出しておき、時間では消さない。Esc で閉じる。候補に無いキーを押したら、何もせずに閉じる

#### コマンド (`:` で始まる)

`:` でステータス行の上にコマンド行を開く。コマンドは動作と同じく、各機能が登録する。

| コマンド | 動作 | 処理を持つ機能 |
| --- | --- | --- |
| `:h`、`:help` | ヘルプを開く | `operations` |
| `:home`、`:ls` | 一覧を開く | `inbox` |
| `:set`、`:set <プロジェクト>` | 設定を開く。プロジェクトの名前を付けると、そのプロジェクトの節を出す | `operations` (画面)、`project-settings` (プロジェクトの節) |
| `:usage` | 利用量を開く | `project-settings` |
| `:issue <番号>` | 今のプロジェクトの issue を開く。プロジェクトが決まらない画面では `:issue <プロジェクト> <番号>` | `issue` |
| `:issue edit` | 開いている issue の編集の画面を開く | `issue` |
| `:project <名前>` | プロジェクトを開く | `inbox` |
| `:pause` / `:resume` | 自動フローを止める / 再開する | `project-settings` |
| `:stop` | AI を止める | `conversation` |
| `:images clear` | 入力欄に貼った画像をすべて外す | `conversation` |
| `:close` | 会話を締めくくる | `conversation-lifecycle` |
| `:convs` | 会話とスレッドの一覧を開く | `conversation-lifecycle` |
| `:rg <語>` | ファイルの中身を検索する (`Space /` で `:rg ` が入った状態で開く) | `files` |
| `:files <語>` | ファイルの名前を検索する | `files` |
| `:changes` | この会話で AI が変えた箇所の一覧を開く | `files` |
| `:e` | 開いているファイルかファイルツリーを読み直す | `files` |
| `:toc start <章の番号>` | その章の始まりを、カーソルの行のイベントに移す | `recap` |
| `:find <語>` | issue と会話を検索する (`Space f` で `:find ` が入った状態で開く) | `conversation-lifecycle` |
| `:q` | 右のウィンドウを閉じる。無ければ 1 つ前の画面へ戻る | `buffer-ui` |
| `:map <キー> <動作の名前か Vim のキー列>` | Normal のキーの割り当てを変える | `buffer-ui` (読み取り)、`operations` (保存と重なりの確認) |
| `:unmap <キー>` | Normal のキーの割り当てを外す | `buffer-ui` (読み取り)、`operations` (保存) |
| `:tmap <キー> <動作の名前>` | ターミナルの入力中のキーの割り当てを変える | `buffer-ui` (読み取り)、`operations` (保存と重なりの確認) |
| `:tunmap <キー>` | ターミナルの入力中のキーの割り当てを外す | `buffer-ui` (読み取り)、`operations` (保存) |
| `:<数>` | 操作中のウィンドウのその行へ移る | Vim |

- コマンド行は高さ 28px の等幅 13px で、右に「Enter 実行」「Esc やめる」「:h ヘルプ」のヒントを出す
- Enter で実行し、Esc か Ctrl+[ でやめる。IME の変換を確定する Enter では実行しない
- ↑ / ↓ で、そのタブで実行したコマンドを新しい順に 50 件まで呼び戻す
- 無いコマンドは、エラーのお知らせ「コマンド :<名前> はありません。:h で一覧を見られます」を出す
- 引数が足りないときは、エラーのお知らせに使い方を出す (例: 「検索する語を入れてください」)
- 表に無い Vim の ex コマンド (`:s` など) は、無いコマンドとして扱う
- コマンドの名前は完全一致で引き、Vim のような省略は受けない。`:e` はファイルの読み直しだけに使う
- `:issue` は、引数が `edit` の 1 語なら編集の画面を開き、ほかは番号として引く
- `:map` と `:unmap` は `context` が `normal` の行を、`:tmap` と `:tunmap` は `terminal` の行を保存する。`:tmap` の動作は、ターミナルの入力中に呼べる動作 (`terminal.normal`) に限る
- `:map`・`:unmap`・`:tmap`・`:tunmap` で、キーの書き方が読めないときは「キーの書き方が読めません: <キー>」、動作の名前もキー列も読めないときは「動作がありません: <名前>」をエラーのお知らせに出し、保存しない

#### ヘルプの中身

ヘルプの行は、今の割り当てと登録したコマンドから `helpLines()` で作る。ヘルプの画面は `features/operations.md` が持つ。

- 1 行に 1 組を `pair` の行で書き、「キー / 動作 / 使える場所」の 3 桁を揃える。列の見出しはウィンドウの見出しに置く
- 1 つの動作に複数のキーがあれば、キーの桁に「、」で並べる。キーが無い動作は「—」にする
- 節は次の表の順に並べ、動作の `group` で振り分ける

| 節 | 動作の名前 |
| --- | --- |
| 開く・戻る | `open`、`back`、`view.prev`、`view.next`、`jump.back`、`home`、`tree.focus`、`conversation.switch`、`conversation.list`、`conversation.close`、`files.open-path` |
| ウィンドウ | `win.left`、`win.right`、`win.down`、`win.up`、`right.close` |
| 会話 | `prompt.open`、`prompt.submit`、`prompt.interrupt`、`prompt.complete`、`agent.stop`、`diff.expand`、`diff.collapse` |
| 質問と指示 | `stock.question`、`stock.instruct`、`stock.list`、`item.edit`、`item.delete`、`item.undo`、`mark.next`、`mark.prev`、`stock.send.all`、`stock.send.questions`、`stock.send.instructions`、`stock.publish`、`thread.list` |
| 状況を思い出す | `recap.recent`、`recap.toc`、`recap.decisions`、`recap.search` |
| そのほか | `cmdline`、`issue.new`、`timeline.open`、`timeline.next`、`timeline.prev`、`files.tree`、`files.folder-open`、`files.folder-close`、`files.grep`、`files.markdown-toggle`、`search.open`、`worktree.list`、`terminal.open`、`terminal.normal` |
| コマンド | 登録したコマンド (「コマンド (`:` で始まる)」の表) |
| 移動と選択 (Vim と同じ) | Vim の組み込みのキー (「既定の割り当て」の表の下の一覧) |

- 先頭に、Ctrl を使うキーは macOS のブラウザを前提にしていることを `note` の行で書く
- ほかの機能が動作を足すときは、その機能設計書で節を決め、本書の表に足す

### メニューの行

操作と選択肢は、メニューの行に並べる。各機能は、行の種類を `menu` にして、`action` と名前を渡す。

- 1 行に 3 桁を置く: 番号、名前、実行すると起きること。桁の幅は 1.4rem、17rem、13rem とする
- 番号は、ウィンドウの中のメニューの行に、上から 1 から振る。番号は幅 1.4rem の枠 (1px の線、角 4px) に等幅 11px の muted で書く
- 名前は 13px の中くらいの太さ、説明は 12px の muted で書く
- 主の操作は、名前を太字にし、番号の枠と字を accent にする。止める・解除する操作は、名前を wait の色にする。選んだ選択肢は、名前を accent にする
- 続くメニューの行のかたまりを 1px の線の枠で囲み、地を surface にする。枠の角は 6px で、左の余白は 8px、右の余白は 16px とする
- かたまりの前後に 6px の隙間を空ける。隙間は透明な線で作り、発言の帯とカーソルの行の地の色を隙間で途切れさせる
- 操作中のウィンドウでカーソルのあるメニューの行は、地を sel にする

実行のしかたは次のとおりにする。

- 行で Enter を押すと、その行の動作を実行する
- 番号を押してから Enter を押すと、その番号の行へカーソルを移して実行する。Vim の「回数 + Enter」(回数の行だけ下へ移る) は、この動きで置き換える。`5j` などの回数の指定はそのまま使える
- 番号を押したあと、ステータス行のヒントに「<番号> Enter 「<名前>」を実行する」と「Esc やめる」を出す
- その番号の行が無いときは、お知らせ「<番号> 番の操作は、この画面にありません」を出し、何もしない。メニューの行が 1 つも無いウィンドウでも同じにする
- 動作が終わるまで、同じウィンドウのメニューの行の Enter は受け付けない。そのあいだ、ウィンドウに Spinner を出す

### y / n の確認

取り返しのつかない操作 (DESIGN.md「横断規約 > 画面の共通の作り」) は、動作の定義に確認の文を持たせ、実行の前に確認を出す。

- 確認は、ステータス行のすぐ上に高さ 28px の行で出す。13px の太字で確認の文を書き、続けて等幅で「(y / n)」を出す
- 確認を出しているあいだは、すべてのキーを確認が受け取る。Shift・Ctrl・Alt・Command だけの押下は数えない
- `y` で実行する。ほかのキー (Esc、`n`、IME の変換中のキーを含む) では実行せず、お知らせ「やめました」を出す
- ステータス行のヒントは「y 実行する」「n やめる」だけにする

### 入力欄

入力欄は、Vim のモードを持つ編集できるバッファである (BR-010)。何を書く欄か、どこへ送るかは、開く機能が決める。

| 状態 | キー | 動き |
| --- | --- | --- |
| 開いた直後 | なし | Insert モードで、書きかけの文の末尾にカーソルを置く |
| Insert | Esc、Ctrl+[ | Normal モードへ移る |
| Insert | Enter | 改行する |
| Normal | Enter | 送る (開いた機能の送る処理を呼ぶ) |
| Normal | Alt+Enter | AI を止めてすぐ送る。AI が作業中の会話への指示のときだけ |
| Normal (ビジュアルモードでない) | Esc、Ctrl+[ | 閉じる。書きかけの文を、開いた機能に渡す |
| Normal | `Ctrl+w k` | 入力欄を開いたまま、主のウィンドウへ移る |
| 本文が `/` で始まる 1 語 | Tab | 先頭の候補を入れて空白を足す。続けて Tab を押すと、次の候補に入れ替える |
| どれでも | 画像の貼り付け | 開いた機能の貼り付けの処理に画像を渡す |

- 送ろうとした本文が空白だけのときは、エラーのお知らせ「内容が空です。書いてから送ってください」を出し、入力欄を開いたままにする。空で送れる欄 (例: 差し戻し) は、開く機能が指定する
- 送るのに失敗したときは、入力欄を閉じず、本文を残す
- 入力欄からは、動作の定義で `fromPrompt` を付けた動作とコマンド行だけを呼べる
- 入力欄の見た目: 地は raised、1px の枠 (操作中は accent、ほかは line)、角 8px、影は float とする。左右と下に 8px の余白を取る
- 入力欄の上の段に、欄の名前 (12px 太字) と送り先 (12px の muted) を出す。引用があれば、引用の行を行番号つきで 5 行まで出し、残りは「…ほか <n> 行」とする
- 本文は 10rem の高さまで伸ばし、それを超えたら欄の中でスクロールする
- 入力欄の下の段に、モードに合わせたヒントを出す。動詞は開く機能が渡す
  - Insert: 「Esc Normal へ (<動詞>のは Normal から)」
  - Normal: 「Enter <動詞>」、「Alt+Enter AI を止めてすぐ送る」(使えるときだけ)、「Esc 閉じる (書きかけは残る)」
- スキルの候補は、入力欄の上に等幅 13px で横に並べ、先頭を accent、ほかを muted にし、最後に「Tab で選ぶ」を出す
- 貼り付けた画像があれば、下の段に「画像 <n> 件 (送信時に一緒に送る)」を accent で出す
- 入力欄が開いて主のウィンドウが縮んでも、主のウィンドウのカーソルの行が見えるようにスクロールする
- IME の変換中のキーでは、送る・閉じるなどのアプリの動きをしない

### ターミナルの入力中

ターミナルの画面の入力中 (TERMINAL モード) は、キーの受け口を次のようにする。ターミナルそのものは `features/worktree-terminal.md` が持つ。

- 割り当ての `terminal` の行のキー (既定は `Ctrl+]`) だけをアプリが受け、ほかのキーはすべてターミナルの中のプログラムへ送る (BR-061)
- `Ctrl+[` は、`Esc` としてプログラムへ送る (BR-062)
- Normal モードに戻ると、出力は読み取り専用のバッファとして扱う。`i` で入力に戻る
- Normal モードへ戻るキーは、`context` が `terminal` の割り当ての行で決まり、`:tmap` で変えられる。ヒントとヘルプは今の割り当てを出す

### ステータス行とヒント

ステータス行は、画面のいちばん下に高さ 28px で置く。左から次の順に並べる。

| 位置 | 中身 | 見た目 |
| --- | --- | --- |
| 1 | モードの札: NORMAL、INSERT、REPLACE、VISUAL、VISUAL LINE、VISUAL BLOCK、COMMAND、TERMINAL | 等幅 12px 太字、角 4px、字は ground。地は NORMAL が muted、INSERT と REPLACE が done、VISUAL が accent、COMMAND が ink、TERMINAL が doing |
| 2 | つながらないことの表示 (DESIGN.md「アプリシェル」) | wait の太字 |
| 3 | 操作中のウィンドウの名前 | ink の中くらいの太さ、20rem で切る |
| 4 | ヒント | キーは等幅の ink、説明は muted。組の間を 16px 空ける |
| 5 (右寄せ) | 各機能が出す状況 (判断待ち・指示待ち・作業中の件数、ストックの件数、自動フロー停止中) | 各機能が色を決める |
| 6 (右端) | 「:h ヘルプ」 | ヒントと同じ |

- 文字は 12px とし、はみ出した分は切る
- ヒントは `[動作の名前か文字, 説明]` の組で受け取り、動作の名前は今の割り当てのキーの表記に直して出す。割り当てを変えると、ヒントのキーも変わる
- 動作に割り当てたキーが無いときは、その組を出さない
- ヒントは、次の順に最初に当てはまるものを出す: 確認中 → ターミナルの入力中 → 入力欄 → ビジュアルモード → 番号の入力中 → カーソルの行の種類 (メニューの行、印のある行など) → 画面。画面とカーソルの行に応じたヒントは、各機能が登録する
- ビジュアルモードのヒントは「Space q 選んだ箇所に質問」「Space c 選んだ箇所に指示」「y コピー」「Esc やめる」とする
- メニューの行がある画面で、カーソルがメニューの行に無いときは、ヒントの最後に「番号 Enter 操作を実行」を足す
- 5 の状況は、各機能が `registerStatusItem` で登録する

### 位置の記憶

画面の見え方は、ブラウザのタブごとに `sessionStorage` に覚える (P3)。既読と前回読んでいた位置はサーバーに置き、`features/recap.md` が持つ (BR-087)。

| 覚えるもの | 置き場所 | 上限 |
| --- | --- | --- |
| 開いている画面と画面の履歴 | ブラウザの履歴 (画面ごとの URL) | ブラウザに従う |
| 右のウィンドウの表示と、積んだ表示の順 | `sessionStorage` | 積んだ表示は 20 件 |
| ウィンドウごとのカーソルの行、桁、先頭に見えている行 | `sessionStorage` (画面の URL・ウィンドウ・表示ごと) | 新しい方から 200 件 |
| 操作中のウィンドウ | `sessionStorage` | 1 件 |
| コマンド行の履歴 | `sessionStorage` | 50 件 |
| ジャンプの履歴 | `sessionStorage` | 50 件 |

- 画面は、どれも URL を持つ (「画面の URL」)。画面を開くたびに履歴に積み、issue の中の表示の切り替えは積まずに置き換える
- `-` はブラウザの履歴を 1 つ戻す。このタブでアプリを開いてから戻れる画面が無いときは、お知らせ「これより前の画面はありません」を出す。ブラウザの戻るボタンも同じ動きになる
- カーソルの位置は、行の `id` があれば `id` で、無ければ行番号で覚える。戻したときに `id` の行が無ければ、同じ行番号に詰めて置く
- 書き込むのは、変わってから 300 ミリ秒後と、ページを離れるとき (`pagehide`) にする
- 入力欄を開いていたかは覚えない。書きかけの入力はサーバーに残るので (`features/conversation.md`)、`i` で続きを書ける
- 2 つのタブは、互いの位置に影響しない。タブを複製すると、そのときの位置を写したところから別々に動く

### 画面の URL

画面の URL は `/<対象の種類>/<識別子>` を基本にし、対象の中の画面は `/<対象の種類>/<識別子>/<画面>`、画面の引数はクエリで持つ。各機能は、この形で自分の画面の URL を決める。

| URL | 開く画面 | 持ち主 |
| --- | --- | --- |
| `/` | 一覧 | `inbox` |
| `/projects/<識別子>` | プロジェクトの画面 | `inbox` |
| `/conversations/<識別子>` | 会話 | `conversation` |
| `/conversations/<元の会話の識別子>?thread=<スレッドの識別子>` | 元の会話を開き、右のウィンドウにそのスレッドを出す | `stock-thread` |
| `/issues/<識別子>` | issue | `issue` |
| `/conversations/<識別子>/file`、`/grep`、`/files`、`/changes` | ファイル、中身の検索、名前の検索、AI が変えた箇所 (引数は `features/files.md`) | `files` |
| `/help` | ヘルプ | `operations` |
| `/settings` | 設定 | `operations` |
| `/usage` | 利用量 | `project-settings` |
| `/projects/<識別子>/import` | GitHub の issue の取り込み | `project-settings` |

- 通知を選んだときは、この URL で画面を開く。開く URL は `features/inbox.md`「通知」が決め、ここの表の形にする
- URL から開いた画面 (再読み込み、通知、Service Worker からの `navigate`) は、画面を開く操作と同じに履歴に積む
- URL の対象が無いときは、主のウィンドウに見つからないことを出す (DESIGN.md「アプリシェル」)

### ジャンプの履歴

ジャンプの履歴は、タブごとに、画面の URL・ウィンドウ・行の組を新しい方から 50 件まで積む。Vim の既定の `Ctrl+o` は、この動きで置き換える。

- `jumpTo(line)` は、カーソルをその行へ移し、移る前の位置を積む。目次の章、引用の箇所、検索の結果の行へ移るときに使う
- `pushJump(line)` は、カーソルを動かさずに位置を積む。会話を開いたときの前回読んでいた位置が、この形である (`features/recap.md`)
- 別の画面へ移る動作 (`gf`、検索の結果の行の Enter、ストックの引用の箇所) は、移る前の位置を積む
- `Ctrl+o` は、最後に積んだ位置を取り出してそこへ移る。URL が今の画面と違えば、その画面を開いてから行に置く
- 積んだ位置が無ければ、`Ctrl+o` は何もしない。行が消えていれば、同じ行番号に詰めて置く
- 行は、`id` があれば `id` で、無ければ行番号で覚える

### コピー

- `y` は、Vim のレジスタに入れ、OS のクリップボードにも書く
- `http://macstudio:<port>` は安全なオリジンではなく、`navigator.clipboard` が使えない。そのため、隠した入力欄に文字を入れて `document.execCommand("copy")` で書く。安全なオリジンで開いたときは `navigator.clipboard.writeText` を使う
- クリップボードに書けなかったときは、お知らせ「クリップボードに書けませんでした。Vim のレジスタには入っています」を出す

### 見た目の決まり

| 項目 | 決まり |
| --- | --- |
| 明るさ | ライトだけ。ダークは作らない |
| 書体 | 画面の文字は Zen Kaku Gothic New (無ければ Hiragino Sans)。等幅は Cica、無ければ JetBrains Mono で、コード・キー・プロジェクト名・行番号にだけ使う |
| 書体の読み込み | Zen Kaku Gothic New (400 / 500 / 700) と JetBrains Mono (400 / 600) はアプリに同梱し、外へ取りに行かない。Cica は端末に入っていれば使う |
| 地と文字の色 | ground #f4f5f7、surface #ffffff、raised #eceef2、line #e1e4ea、ink #1a1d24、muted #646c7c |
| 状態の色 | 強調と選んだもの accent #4753d6、選択の地 sel #dde1ff、完了 done #1c8650、作業中 doing #946200、判断待ちと失敗 wait #b8264c、差分の追加 add #e0f4e7、差分の削除 del #fde4e9 |
| 色の使い方 | 色は状態にだけ使う。それ以外は ink と muted だけで、強弱は文字の太さと大きさで付ける |
| 文字の大きさ | 12 / 13 / 14 / 15px だけを使う |
| 余白 | 4 / 8 / 12 / 16px だけを使う。例外は、メニューの行の前後の 6px と、見出しの上の 14px |
| 行の高さ | 「ウィンドウの構成と移動」の表のとおり |
| 角 | 外枠 12px、入力欄 8px、行とボタン 6px |
| 影 | 入力欄とお知らせの float の 1 段だけ |
| カーソル | 操作中のウィンドウのカーソルは accent の地に surface の字 (角 2px)、カーソルの行の地は raised にする。操作中でないウィンドウには出さない |
| 選んだ範囲 | 地を sel にする |
| フォーカスの輪郭 | ボタンと入力の部品だけ、2px の accent の線を 2px 離して出す |

## API

利用者向けの API は持たない。キーの割り当ての保存と読み出しは `features/operations.md` の `GET /api/settings` と `PUT /api/settings/keymap` を使う。設定の変化は `/ws` の `app` の `settings_changed` で受ける (`features/runtime.md`)。

## 実装の配置

| 処理 | 層 | 実装先ファイル |
| --- | --- | --- |
| 行の種類と行の情報、桁の定義 | UI (土台) | `src/front/buffer/line.ts` |
| 行の情報と装飾を持つ `StateField`、追記用の `Annotation`、`changeFilter` | UI (土台) | `src/front/buffer/state.ts` |
| 装飾の作り直し (帯、桁、メニューの枠、隙間) | UI (土台) | `src/front/buffer/decorate.ts` |
| カーソルを置けない行 | UI (土台) | `src/front/buffer/no-cursor.ts` |
| 印の桁と行番号 | UI (土台) | `src/front/buffer/gutters.ts` |
| メニューの行の番号付けと実行 | UI (土台) | `src/front/buffer/menu.ts` |
| バッファの部品 (追記・書き換え・末尾について行く・飛ぶ) | UI | `src/front/buffer/Buffer.tsx` |
| 入力欄 | UI | `src/front/buffer/PromptEditor.tsx` |
| 見た目 (EditorView のテーマ、色と寸法の値) | UI (土台) | `src/front/buffer/theme.ts` |
| 既定の割り当て、Vim の組み込みのキー、動作とコマンドの登録、今の割り当ての計算、重なりの判定、記法の変換 | UI (土台) | `src/front/buffer/keymap/defaults.ts`、`src/front/buffer/keymap/vim-builtins.ts`、`src/front/buffer/keymap/registry.ts`、`src/front/buffer/keymap/resolve.ts`、`src/front/buffer/keymap/conflicts.ts`、`src/front/buffer/keymap/notation.ts` |
| ヘルプの行の生成 | UI (土台) | `src/front/buffer/help-lines.ts` |
| 今の割り当ての Vim への当て直し | UI (土台) | `src/front/buffer/keymap/apply-vim.ts` |
| コマンド行と、コマンドの読み取り | UI | `src/front/buffer/CommandLine.tsx`、`src/front/buffer/commands.ts` |
| ウィンドウの並び、見出し、列の見出し、移動 | UI | `src/front/buffer/Layout.tsx`、`src/front/buffer/Frame.tsx`、`src/front/buffer/ColHead.tsx` |
| 右のウィンドウの表示の順 | UI (土台) | `src/front/buffer/right-window.ts` |
| Space の候補、確認、ステータス行、ヒント | UI | `src/front/buffer/WhichKey.tsx`、`src/front/buffer/ConfirmBar.tsx`、`src/front/buffer/StatusLine.tsx`、`src/front/buffer/hints.ts` |
| 位置の記憶 | UI (土台) | `src/front/buffer/position-store.ts` |
| 末尾の区画の書き換え、`seq` から行を求める | UI (土台) | `src/front/buffer/tail.ts`、`src/front/buffer/seq-index.ts` |
| ジャンプの履歴 | UI (土台) | `src/front/buffer/jump-history.ts` |
| 画面の URL と、URL から画面を開く | UI | `src/front/lib/routes.ts` |
| コピー | UI (土台) | `src/front/buffer/clipboard.ts` |
| 書体の同梱 | UI | `src/front/styles/fonts.css` |

## エッジケースの決定

1. **空・最小データ**: 中身が空の画面は、各機能が `note` の行で空であることを書く。カーソルを置ける行が 1 行も無いバッファでは、カーソルを 1 行目に置いたまま、Enter などの行の動作は何もしない
2. **上限・境界値**: 1 万行のバッファに追記を続けても、状態を作り直さない作りで応答を保つ。行番号の桁は 2.5rem で 5 桁まで収め、6 桁になったら桁を広げる。番号 + Enter の番号は、そのウィンドウのメニューの行の数までとする。入力欄は 10rem を超えたら欄の中でスクロールする。位置の記憶は新しい方から 200 件、右のウィンドウの順は 20 件、ジャンプの履歴は 50 件、コマンドの履歴は 50 件とする
3. **エラー時に利用者へ見えるもの**: 無いコマンドと引数の不足はエラーのお知らせを出す。無い番号と、今の画面で使えない動作はお知らせを出して何もしない。使えない動作の文は、動作を持つ機能が決める (例: 「目次は、会話の表示で使えます」)。動作の処理が例外を投げたら、エラーのお知らせを出し、ウィンドウの ErrorBoundary が描画の失敗を受ける
4. **並行操作・二重実行**: AI の出力の追記と、利用者のキーの入力が重なっても、追記は dispatch で入るので、回数の入力・ビジュアルモード・検索の入力は保たれる。メニューの行の動作は、終わるまで同じウィンドウの Enter を受け付けない。確認を出しているあいだは、ほかのキーを受け付けない
5. **再表示時の整合**: 画面に戻ると、覚えたカーソルの位置を `id` で探して置く。行が消えていれば同じ行番号に詰める。キーの割り当てが別の端末で変わったら、配信を受けて読み直し、開いている画面のまま新しいキーで動く
6. **表示の寿命**: Space の候補は次のキーか Esc まで出す。番号の入力のヒントは次のキーまで出す。確認は答えのキーまで出す。コマンド行は Enter か Esc まで出す。AI の書きかけの発言は、同じ発言の保存か番の終わりで消える。お知らせの寿命は DESIGN.md「横断規約 > アプリシェル」に従う
7. **送る前のデータ**: 入力欄の本文は、閉じるときと画面を移るときに、開いた機能へ渡す (保存先は `features/conversation.md` など)。コマンド行で打ちかけた文字は、Esc で捨てる。履歴に入るのは実行したコマンドだけにする
8. **状態の移り変わり**: モードは、Normal から `v` / `V` / `Ctrl+v` でビジュアル、`:` でコマンド、`i` で入力欄の Insert へ移る。入力欄は Insert と Normal を行き来し、Normal の Esc で閉じて Normal に戻る。ターミナルの入力中は、割り当てのキーで Normal に戻り、`i` で戻る。確認は、どのモードの上にも出て、答えると元のモードに戻る
9. **自動で進むこと**: 末尾について行く指定のあるバッファだけ、追記と末尾の区画の書き換えでカーソルが動く。設定の変化を受けると、キーの割り当てを自動で当て直す。開発者が書いた文を、操作なしで送ることはしない
10. **端末と画面をまたぐこと**: キーの割り当ては、サーバーに置いてどの端末でも同じにする (BR-071)。カーソル、開いている画面、右のウィンドウ、操作中のウィンドウ、コマンドの履歴、ジャンプの履歴は、タブごとに持つ
11. **並びと数え方**: メニューの番号は、ウィンドウの中で上から 1 から振る。Space の候補は既定の割り当ての順に、設定で足したものを後ろに並べる。行番号は絶対行番号で、隠した行は無い。ヘルプの節の並びは「ヘルプの中身」の表の順にする

## テスト方針

| 確かめること (タスク説明から起こした) | レベル |
| --- | --- |
| 回数の入力・ビジュアルモード・検索の入力の途中で行を追記しても、カーソルの位置とその状態が保たれ、追記した行が末尾に出る | 単体 |
| 読み取り専用のバッファで編集のキーを押しても文字は変わらず、追記の印の付いた変更だけが入る | 単体 |
| 途中の行を書き換えると、範囲の中のカーソルは同じ行番号に残り、範囲の後のカーソルは変更に合わせて動く | 単体 |
| 一覧を並べ替えて全体を置き換えると、カーソルは同じ識別子の行へ移る | 単体 |
| 末尾について行く指定のあるバッファで、カーソルが最後の行にあるときだけ、追記でカーソルが新しい最後の行へ移る | 単体 |
| 発言の行の帯と札の装飾は、追記で発言が続いても、前の最終行から作り直されて途切れない | 単体 |
| j / k で発言者の札・区切り・空の行に乗ると、同じ向きの次の置ける行へ移り、端では逆の向きの置ける行に置かれる | 単体 |
| メニューの行で Enter を押すと、その行の動作が実行される | 単体 |
| 番号を押してから Enter を押すと、その番号のメニューの行が実行され、無い番号ではお知らせが出て何も実行されない | 単体 |
| 確認を出した操作で y を押すと実行され、ほかのキーを押すと実行されずに「やめました」が出る | 単体 |
| Space を押すと候補が出て、Space s を押すと送るキーの候補に変わり、Esc で消える | 単体 |
| 無いコマンドを打つと、エラーのお知らせに名前とヘルプの案内が出る | 単体 |
| 設定でキーの割り当てを変えると、新しいキーで動作が呼ばれ、外したキーでは呼ばれず、ヒントとヘルプの行のキーも変わる | 単体 |
| 同じキーか先頭の重なるキー (Vim の組み込みのキーを含む) に割り当てようとすると、重なる割り当てが返る | 単体 |
| 読めないキーの書き方か無い動作の名前で :map を打つと、保存されずにお知らせが出る | 単体 |
| Vim の記法と画面の表記が、表のとおりに変換される | 単体 |
| 入力欄を開くと Insert モードで、Esc で Normal へ、Normal の Enter で送る処理が呼ばれ、Normal の Esc で閉じて書きかけが渡される | 単体 |
| Ctrl+[ を押すと、入力欄でもバッファでも Esc と同じに動く | 単体 |
| 本文が空のまま送ろうとすると、入力欄は開いたままで、エラーのお知らせが出る | 単体 |
| 入力欄の本文が / で始まる 1 語のとき、Tab で先頭の候補が入り、続けて Tab で次の候補に替わる | 単体 |
| 書きかけの発言を末尾の区画に出しているあいだに保存した発言が届くと、書きかけが消えて保存した発言が 1 回だけ出て、届く前の指示の行は最後に残る | 単体 |
| 目次か決まったことの表示で / を押すとアプリの検索が開き、ほかの表示では Vim の検索が始まる | 単体 |
| ターミナルの入力中は、割り当てのキーだけで Normal に戻り、ほかのキーと Ctrl+[ はターミナルへ渡る | 単体 |
| :tmap で Normal へ戻るキーを変えると、新しいキーで Normal に戻り、前のキーはターミナルへ渡る | 単体 |
| Ctrl+w h / l でウィンドウを移ると、右のウィンドウが無いときは主のウィンドウで止まる | 単体 |
| 右のウィンドウで別の表示を開いてから Ctrl+h を押すと前の表示に戻り、積んだ表示が無ければ閉じる | 単体 |
| 再読み込みすると、そのタブのウィンドウごとのカーソルと右のウィンドウが戻る | 単体 |
| 移らずに積んだ位置へ Ctrl+o で移り、別の画面で積んだ位置へは、その画面を開いてから移る | 単体 |
| イベントの seq と何行目かを渡すと、その行の行番号が返り、無ければ見つからないことが返る | 単体 |
| 通知の URL で開くと、会話・issue・スレッドを右に出した元の会話のどれかが、その対象で開く | 単体 |
| y で選んだ文字が、安全なオリジンでないときもコピーの手段で書かれる | 単体 |

E2E 対象動線: なし (この土台に利用者の業務の流れは無い。キー操作の golden path は、各機能の US-024 の受け入れ基準の E2E が、この土台を通して確かめる)
