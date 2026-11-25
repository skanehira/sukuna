# issue の自動フロー (状態の移り変わり、精査、設計)

- 種別: 機能設計書
- 対象 UC: UC-008 (docs/design/USECASES.md)

## 何を作るか

確定した issue を、開発者が手で起動しなくても AI が精査し、設計して、設計レビューまで進める機能である。issue の状態の移り変わりの決まりも、この機能が持つ。

**使う人**: 開発者 (issue を確定し、止まった issue に答える)。精査と設計は AI が行う

**流れ**:

1. 開発者が issue を確定すると、すぐに精査の AI が始まる
2. 精査の AI が種別と優先度を決め、設計へ進めるか、人の判断を待つか、親として扱うかを報告する
3. 設計へ進む issue では、すぐに設計の AI が始まり、設計書の変更か修正方針を作る
4. 設計を終えると issue は設計レビューになり、一覧の判断待ちに出る
5. AI が質問を書いたか、失敗か利用枠切れで止まったときは、issue は停止中になる。答えるか再開を選ぶと、止まった段階から続く

**issue の状態**:

| 状態 | 意味 |
| --- | --- |
| 下書き | 書いている途中。AI は動かない |
| 精査待ち | 精査を待つか、精査の AI が動いている |
| 設計待ち | 設計を待つか、設計の AI が動いている |
| 設計レビュー | 開発者の承認を待っている |
| 実装待ち | 実装の開始を待っている。親の issue もこの状態で子を待つ |
| 実装中 | 実装の AI が動いているか、merge を待っている |
| 停止中 | 質問、失敗、利用枠切れ、CI の失敗、merge 前の確認、依存先の取り下げのどれかで止まっている |
| 完了 | merge された。親は子がすべて閉じた |
| 取り下げ | 開発者が取り下げて閉じている |

**主な決まり**:

- 精査と設計の AI は状態が変わるとすぐに始まり、同時に動く数の上限は無い (BR-040、BR-042)
- 同じ issue では、同時に 1 つの段階の AI だけを動かす (BR-041)
- 精査・設計・実装の AI は、手順に既存のスキルを使い、issue の読み書きだけをアプリのツールで行う (BR-044)
- 状態を移すのはアプリだけで、AI はツールで結果を報告する
- 設計を終えた issue として登録された issue は、精査を通ると設計を省いて実装待ちになる
- 子を持つ issue は親として扱い、設計も実装もしない
- 一時停止のあいだと、自動で処理する段階から外した段階では、新しい AI を始めない。動いている AI は止めない

## 入出力と振る舞い

### この機能の前提

- 本書は、issue の状態の値、停止中の理由の値、状態の移り変わりの表、`state_changed` の `cause` の値、`issue_events` の種類の名前の一覧の正本である
- 状態を移すのはランナーの自動フロー (`flow`) だけとする (DESIGN.md「横断規約 > 自動フローと既存のスキル」)。AI は `features/issue.md`「AI に渡すツール」で結果を報告し、`flow` がそれを受けて移す
- 会話の開始・指示の送信・停止・再開は、ランナーの会話のモジュールを直接呼ぶ (`features/runtime.md`「画面のサーバーからランナーへの操作」)。会話の状態の変化は、同書「ランナーの中の合図」の `turnEnded`・`runStateChanged`・`stopped`・`inputRecorded` で受ける
- 設計の worktree の作り方と片付け、設計レビューからの移り変わり (承認、反映、差し戻し) は `features/design-review.md` が正本である
- 実装の始め方、worktree、PR・CI・merge、完了と親の issue を閉じることは `features/implementation-flow.md` が正本である
- 一覧と通知に何を出すかは、`features/inbox.md` が issue の状態と停止中の理由から決める

### 状態の値

`issues.state` の値は次の 9 つとする (BR-039)。`closed_at` は完了か取り下げに移るときに入れ、ほかの状態へ移るときに空にする。取り下げに移るときは `github_number` を空にし、同じ GitHub の issue を取り込み直せるようにする (`features/project-settings.md`「GitHub の issue の取り込み」)。

| 状態 | 値 | 閉じているか |
| --- | --- | --- |
| 下書き | `draft` | いいえ |
| 精査待ち | `triage` | いいえ |
| 設計待ち | `design` | いいえ |
| 設計レビュー | `design_review` | いいえ |
| 実装待ち | `ready` | いいえ |
| 実装中 | `implementing` | いいえ |
| 停止中 | `stopped` | いいえ |
| 完了 | `done` | はい |
| 取り下げ | `withdrawn` | はい |

- 精査待ちと設計待ちは、AI を待っているあいだと AI が動いているあいだの両方を指す。AI が動いているかは、その issue の会話の `run_state` で分かる
- 依存の数え方で「閉じた」と言うときは、完了だけを指す。取り下げの issue は閉じたと数えない (BR-076)

### 停止中の理由

`issues.stop_reason` は、停止中のあいだだけ値を持ち、ほかの状態へ移るときに空にする。停止中へ移す前の状態 (以下「停止前の状態」) は、停止中でない状態から停止中へ移した最後の `state_changed` の `from` で分かる。

| 理由 | 値 | 停止中にするきっかけ | 戻り方 |
| --- | --- | --- | --- |
| AI の質問 | `question` | AI が人の判断が要ることを報告した。段階の AI が選択式の質問で待った。再起動のときに段階の AI が回答を待っていた | 開発者が会話で答える (発言、回答の送信)。停止前の状態へ戻る |
| 失敗 | `failed` | 段階の AI が API のエラーか失敗で止まった。報告が無いまま番を 2 回終えた。設計か実装の worktree を作れなかった。設計書の PR を merge できなかった | 開発者が「再開する」を選ぶか、指示を送る。停止前の状態へ戻る。worktree を作れなかったときは、`flow` が作り直してから戻す。設計書の PR を merge できなかったときは、会話が `idle` で再開を受け付けないので、指示を送ったときだけ戻る |
| 利用枠切れ | `usage_limit` | 段階の AI が利用枠切れで止まった | 枠が戻るとランナーが自動で再開する (BR-091)。開発者が「いま再開する」を選んでもよい。停止前の状態へ戻る |
| CI の失敗 | `ci_failed` | 実装の AI が CI の失敗を報告した | 開発者が実装の会話に指示を送る。実装中へ戻る (`features/implementation-flow.md`) |
| merge 前の確認 | `merge_confirm` | merge 前の確認を指定した issue で、PR の用意ができた | merge を許可するか、指示を送る。どちらも実装中へ戻る (`features/pr-review.md`) |
| 依存先の取り下げ | `dependency_withdrawn` | 依存先が取り下げになった。段階を始めるときに、取り下げの依存先があった | 取り下げの依存先が無くなると、自動で停止前の状態へ戻る。依存を外すか、依存先を再開すると無くなる |

- 停止中へ移すときは、開発者に見せる 1 行の文を `state_changed` の `detail` に入れる。一覧の状況の文 (`features/inbox.md`) はこの文を使う
- `detail` の中身: AI の質問は 1 件目の質問の 1 行目、失敗は止まった理由の 1 行目、CI の失敗は失敗した検査の名前、依存先の取り下げは `#<番号>` の並びとする
- 停止中から停止中へ移すとき (依存先の取り下げ、worktree の作り直しの失敗) は、`state_changed` の `from` に元の停止の `from` (停止前の状態) を入れる
- 許可の確認 (`waiting_permission`) では停止中にしない。一覧は会話の状態から判断待ちに出す (`features/inbox.md`)
- 開発者が段階の AI を止めたとき (会話の `stop_reason` が `user`) は、issue の状態を変えない。`flow` は、指示が送られるまでその会話を動かさない。ランナーの再起動のあとも動かさない

### 状態の移り変わりの表

この表がすべての移り変わりの正本である。「AI の動き」は、移ったときに `flow` が会話にすることを書く。「`cause`」は、移したときの `state_changed` の `cause` の値である。

| 元の状態 | きっかけ | 移った先 | AI の動き | `cause` | 詳しい決まり |
| --- | --- | --- | --- | --- | --- |
| (なし) | 開発者が issue を作る | 下書き | なし | (記録しない) | `features/issue.md` |
| (なし) | AI がツールで issue を作る | 精査待ち | 精査の AI を始める | `ai_created` | `features/issue.md` (BR-035) |
| 下書き | 開発者が確定する | 精査待ち | 精査の AI を始める | `confirm` | `features/issue.md` |
| 精査待ち | 精査の結果が「設計へ進む」で、子が無く、設計済みでない | 設計待ち | 設計の AI を始める | `triage_reported` | 本書「精査の結果」 |
| 精査待ち | 精査の結果が「設計へ進む」で、子が無く、設計済み | 実装待ち | 実装の開始は `features/implementation-flow.md` | `triage_reported` | 本書「設計済みの issue と親の issue」 |
| 精査待ち | 精査の結果を受けたとき子がある (結果の値を問わない) | 実装待ち (親) | なし | `triage_reported` | 本書「設計済みの issue と親の issue」 |
| 精査待ち / 設計待ち | AI が人の判断が要ることを報告する | 停止中 (`question`) | 会話は質問の回答を待つ | `needs_human` | 本書「人の判断が要るとき」 |
| 精査待ち / 設計待ち | 段階の AI が選択式の質問で待つ | 停止中 (`question`) | 会話は質問の回答を待つ | `agent_question` | 本書「人の判断が要るとき」 |
| 精査待ち / 設計待ち | 段階の AI が失敗で止まる | 停止中 (`failed`) | なし | `agent_failed` | 本書「AI が止まったとき」 |
| 精査待ち / 設計待ち | 報告が無いまま番を 2 回終える | 停止中 (`failed`) | なし | `no_report` | 本書「番の終わりで報告が無いとき」 |
| 設計待ち | 設計の worktree を作れない | 停止中 (`failed`) | 会話に止まった記録 (`error`) を書く | `worktree_failed` | 本書「段階の AI を始める」 |
| 精査待ち / 設計待ち | 段階の AI が利用枠切れで止まる | 停止中 (`usage_limit`) | ランナーが枠の戻りを待つ | `agent_usage_limit` | 本書「AI が止まったとき」 |
| 設計待ち | 設計の AI が設計の完了を報告する | 設計レビュー | なし | `design_submitted` | `features/design-review.md` |
| 設計待ち (設計書の PR の merge 待ち) | AI の番が正常に終わり (`turn_end` の `subtype` が `success` で、止まった記録が続かない)、PR が merge 済み | 実装待ち (子があれば実装待ち (親)) | なし | `design_reflected` | `features/design-review.md` |
| 設計待ち (設計書の PR の merge 待ち) | AI の番が正常に終わり (同上)、PR が merge されていない | 停止中 (`failed`) | なし | `design_pr_not_merged` | `features/design-review.md` |
| 設計レビュー | 開発者が承認し、反映が終わる (変更なしを含む)。子が無い | 実装待ち | 実装の開始は `features/implementation-flow.md` | `design_reflected` | `features/design-review.md` |
| 設計レビュー | 開発者が承認し、反映が終わる。子がある (設計で分けた) | 実装待ち (親) | なし | `design_reflected` | 本書「設計済みの issue と親の issue」 |
| 設計レビュー | 開発者が承認し、PR で入れる設定で、設計書の PR を作れた | 設計待ち (設計書の PR の merge 待ち) | 設計の AI に PR の merge を頼む | `design_pr_created` | `features/design-review.md` |
| 設計レビュー | 開発者が差し戻す。設計の会話で発言かストックの指示を送る | 設計待ち | 指摘が設計の会話の続きに届く | `design_rejected` | `features/design-review.md` (BR-046、BR-098) |
| 設計レビュー | 反映に失敗する | 設計レビュー (変わらない) | なし | (記録しない) | `features/design-review.md` |
| 実装待ち | 依存先がすべて完了し、空きがあり、段階が有効 | 実装中 | 実装の AI を始める | `impl_started` | `features/implementation-flow.md` |
| 実装中 | 実装の AI が人の判断が要ることを報告する | 停止中 (`question`) | 会話は回答を待つ | `needs_human` | `features/implementation-flow.md` |
| 実装中 | 実装の AI が選択式の質問で待つ | 停止中 (`question`) | 会話は回答を待つ | `agent_question` | 本書「人の判断が要るとき」 |
| 実装中 | 実装の AI が失敗で止まる | 停止中 (`failed`) | なし | `agent_failed` | 本書「AI が止まったとき」 |
| 実装中 | 報告が無いまま番を 2 回終える | 停止中 (`failed`) | なし | `no_report` | 本書「番の終わりで報告が無いとき」 |
| 実装中 | 実装の worktree を作れない | 停止中 (`failed`) | 会話に止まった記録 (`error`) を書く | `worktree_failed` | `features/implementation-flow.md` |
| 実装中 | 実装の AI が利用枠切れで止まる | 停止中 (`usage_limit`) | ランナーが枠の戻りを待つ | `agent_usage_limit` | 本書「AI が止まったとき」 |
| 実装中 | 実装の AI が CI の失敗を報告する | 停止中 (`ci_failed`) | なし | `ci_failed` | `features/implementation-flow.md` |
| 実装中 | merge 前の確認を指定した issue で、PR の用意ができた | 停止中 (`merge_confirm`) | AI は番を終えて待つ | `ready_for_merge` | `features/implementation-flow.md` |
| 実装中 | 実装の AI が merge の完了を報告し、`flow` が merge を確かめる | 完了 | worktree を片付け、親を確かめる | `implementation_done` | `features/implementation-flow.md` |
| 実装中 / 停止中 (停止前の状態が実装中) | 開発者が GitHub で PR を merge し、`flow` が merge を確かめる | 完了 | worktree を片付け、親を確かめる | `implementation_done` | `features/implementation-flow.md`「GitHub で merge されたとき」 |
| 停止中 (`merge_confirm`) | 開発者が merge を許可する | 実装中 | merge の指示が届く | `merge_allowed` | `features/pr-review.md` |
| 停止中 (`merge_confirm`) | 開発者が実装の会話に指示を送る | 実装中 | 指示が届く。直して PR の用意ができたと報告すると、もう一度停止中 (`merge_confirm`) | `impl_instruction` | `features/pr-review.md` (BR-099) |
| 停止中 (`ci_failed`) | 開発者が実装の会話に指示を送る | 実装中 | 指示が届く | `impl_instruction` | `features/implementation-flow.md` |
| 停止中 (`question` / `failed` / `usage_limit`) | 停止前の段階の会話に、回答・発言・再開 (枠の戻りを含む) が記録される | 停止前の状態 | 会話が続きを行う | `agent_resumed` | 本書「停止中から戻る」 |
| 停止中 (`failed`、`cause` が `worktree_failed`) | 開発者が段階の会話に指示を送るか再開を選び、`flow` が worktree を作り直せる | 停止前の状態 | 最初の指示を届ける。開発者の指示があれば続けて 1 通にする | `agent_resumed` | 本書「停止中から戻る」 |
| 停止中 (`failed`、`cause` が `worktree_failed`) | 開発者が段階の会話に指示を送るか再開を選び、`flow` が worktree を作り直せない | 停止中 (`failed`) | 会話に新しい文で止まった記録 (`error`) を書く。開発者の指示は届けない | `worktree_failed` | 本書「停止中から戻る」 |
| 停止中 (`question` / `failed` / `usage_limit` / `ci_failed` / `merge_confirm`) | 上の戻るきっかけが起き、取り下げの依存先が残っている | 停止中 (`dependency_withdrawn`) | 動いている段階の AI を止める | `dependency_withdrawn` | 本書「依存先の取り下げ」 |
| 停止中 (`dependency_withdrawn`) | 取り下げの依存先が無くなる | 停止前の状態 | 段階の AI を続きから動かす | `dependency_cleared` | 本書「停止中から戻る」 |
| 完了 | 開発者が実装の会話に指示を送る | 実装中 | `reopened_for_fix` を記録し、新しい worktree で直す | `reopened_for_fix` | `features/pr-review.md` (BR-058) |
| 下書き / 精査待ち / 設計待ち / 設計レビュー / 実装待ち / 実装中 / 停止中 | 開発者が取り下げる | 取り下げ | 動いている AI を止める | `withdraw` | `features/issue.md` |
| 精査待ち / 設計待ち / 設計レビュー / 実装待ち / 実装中 | 依存先が取り下げになる | 停止中 (`dependency_withdrawn`) | 動いている段階の AI を止める | `dependency_withdrawn` | 本書「依存先の取り下げ」 |
| 精査待ち / 設計待ち / 実装待ち | 段階を始める評価で、取り下げの依存先が見つかる | 停止中 (`dependency_withdrawn`) | なし | `dependency_withdrawn` | 本書「段階の AI を始める」 |
| 精査待ち / 設計待ち / 実装中 | ランナーの再起動のとき、段階の会話が選択式の質問の回答を待っていた | 停止中 (`question`) | 続きの指示は送らない | `restart_question` | 本書「ランナーの再起動のあと」 |
| 完了 / 取り下げ | 開発者が再開する | 精査待ち | 評価が精査の会話の続きで精査を始める | `reopen` | `features/issue.md` |
| 実装待ち (親) | 子がすべて閉じ、そのうち 1 件以上が完了 | 完了 | なし | `children_closed` | `features/implementation-flow.md` |
| 完了 (親) | 子が完了と取り下げ以外の状態になる (子の再開、子の直し、子の追加) | 実装待ち (親) | なし | `child_reopened` | `features/implementation-flow.md` |

- 設計書の PR の merge 待ちで、番が正常に終わらなかったときは、本書「AI が止まったとき」の表に従う。開発者の停止は状態を変えず、失敗は停止中 (`failed`)、利用枠切れは停止中 (`usage_limit`) にする
- 割り込みで終わった番は状態を変えない。PR の確かめは、割り込みの発言で始まる番の終わりで行う
- 表に無い組み合わせのきっかけでは、状態を変えない。AI の報告なら、ツールは失敗を返し、いまの状態を文で伝える (`features/issue.md`「AI に渡すツール」)
- 状態を移すときは、`issues` の更新と `state_changed` の行の追加を 1 つのトランザクションに入れる (DESIGN.md「トランザクション境界」)
- 移したあとは、ランナーの変化の知らせで画面のサーバーへ伝える (`features/runtime.md`)。一覧と通知はそれを受けて決まる
- 「設計書の PR の merge 待ち」は、最後の `design_approved` の後に `design_pr_created` があり、その後に `design_reflected` も `design_rejected` も無い設計待ちを指す。停止中から戻った設計待ちも含む

### `issue_events` の種類

状態を移すたびに `state_changed` を 1 行足す。報告や操作を残す行は、その種類の行を別に足す。種類の名前の一覧は次のとおりで、payload の形は「正本」の列の文書が持つ。

| 種類 | 足すとき | payload | 正本 |
| --- | --- | --- | --- |
| `state_changed` | 状態を移した | `{ "from": "<値>", "to": "<値>", "stopReason": "<値>" \| null, "detail": "<1 行>" \| null, "cause": "<きっかけ>" }` | 本書 |
| `ai_started` | 段階の AI に最初の指示か続きの指示を送った | `{ "kind": "triage" \| "design" \| "impl", "conversationId": "...", "reason": "start" \| "reopen" \| "worktree_retry" \| "resume_dependency" \| "restart" \| "design_pr_merge" }` | 本書 |
| `triage_reported` | 精査の結果を受けた | `{ "result": "design" \| "parent", "kind": "<種別>", "urgent": <真偽>, "score": <数> \| null, "priority": "<値>" \| null, "summary": "..." }` | 本書 |
| `needs_human_reported` | 人の判断が要る報告を受けた | `{ "questions": [ { "text": "...", "options": ["..."] } ], "summary": "..." }` | 本書 |
| `report_nudged` | 報告の無い番の終わりに催促した | `{ "conversationId": "..." }` | 本書 |
| `created` / `edited` / `comment` | issue を作った、項目を直した、コメントを書いた | `features/issue.md` の表 | `features/issue.md` |
| `design_submitted` / `design_approved` / `design_reflected` / `design_reflect_failed` / `design_pr_created` / `design_rejected` | 設計の完了、承認、反映、差し戻し | `features/design-review.md` の表 | `features/design-review.md` |
| `stage_changed` / `ready_for_merge` / `ci_failed` / `implementation_done` / `worktree_kept` / `worktree_removed` | 実装の段階と結果 | `features/implementation-flow.md` の表 | `features/implementation-flow.md` |
| `merge_allowed` / `reopened_for_fix` | merge の許可、完了した issue の直し | `features/pr-review.md` | `features/pr-review.md` |

- `ai_started` の `reason`: `start` は段階の最初の指示、`reopen` は再開した issue の精査の最初の指示、`worktree_retry` は worktree を作り直したあとの最初の指示である。ほかの値は、その指示を書いた節にある

### 段階の AI を始める

`flow` は、次の「評価」を 1 つの処理に置き、どのきっかけからも同じ処理を呼ぶ。評価は何度呼んでも同じ結果になる。

評価のきっかけ:

- issue の状態が変わったとき
- 段階の会話の番が終わったとき、`run_state` が変わったとき
- 画面のサーバーから `/flow/notify` を受けたとき (項目の変更、設定の変更、一時停止の解除、PR の merge を見たとき。`features/runtime.md`)
- ランナーの起動のあと (全プロジェクトを 1 回ずつ評価する)

評価は、設計待ちの issue について、最初に記録の並びから「設計書の PR の merge 待ち」かを決める (定義は「状態の移り変わりの表」の後の注)。merge 待ちの issue には、設計の最初の指示を送らない。下の条件の 2〜7 を満たせば、最初の指示の代わりに merge を頼む指示を送る。

評価で精査と設計の AI を始める条件は、次のすべてを満たすことである。

1. issue が精査待ちか、merge 待ちでない設計待ちである
2. 起点の `state_changed` より後に、同じ段階の `ai_started` が無く、その段階の会話に指示 (`user_message`。`origin` を問わない) も届いていない
3. プロジェクトが解除されていない (`projects.removed_at` が空)
4. 全体とプロジェクトの自動フローが一時停止していない (本書「一時停止と自動で処理する段階」)
5. その段階が、プロジェクトの「自動で処理する段階」に入っている
6. その issue の精査・設計・実装の会話のどれも、`working` / `waiting_answer` / `waiting_permission` ではない (BR-041)
7. 取り下げの依存先が無い。あれば停止中 (`dependency_withdrawn`) に移し、始めない

- 2 の起点は、停止中でない状態からいまの状態へ移った最後の `state_changed` (`cause` が `agent_resumed`・`dependency_cleared` 以外) である。停止中から戻っただけでは、起点は変わらない
- 2 の前後は、`issue_events.created_at` と `conversation_events.created_at` を比べて決める。同じ時刻なら、指示の方が後とみなす
- 設計待ちの issue は、子があっても設計する (本書「設計済みの issue と親の issue」)
- 差し戻しで設計待ちに移ったときは、`features/design-review.md` が会話へ指示を送る。評価は 2 の条件でその指示を見つけ、二重には始めない
- merge を頼む指示の文は `features/design-review.md`「承認と反映」にある。`ai_started` の `reason` は `design_pr_merge` とする。承認のときに一時停止していて送らなかった指示は、一時停止を解いたあとの評価が送る
- 停止中から戻ったときは起点が変わらないので、止まる前に送った指示が起点の後にあれば、評価は始めない
- 精査と設計には、同時に動かす数の上限を設けない (BR-042)

評価は、一時停止か段階を外していたために送らなかった続きの指示も送る。条件の 3〜6 は始めるときと同じに見る。対象の段階は、精査待ち・設計待ち・実装中の issue の段階と、停止中 (`usage_limit`) の issue の停止前の状態の段階である。

- 段階の会話が `stopped` (`restarted`) で、`previous_run_state` が `waiting_answer` でなければ、本書「ランナーの再起動のあと」の続きの指示を送る
- 段階の会話が `usage_limited` で、戻る時刻の 1 分後を過ぎていれば、会話のモジュールの再開を呼ぶ。時刻が無ければ、止まってから 15 分を過ぎたときに呼ぶ
- 停止中 (`usage_limit`) の issue には、上の `usage_limited` の再開だけを行う。再開が記録されると、issue は停止前の状態に戻る (本書「停止中から戻る」)
- 最後の `state_changed` の `cause` が `dependency_cleared` で、その後に `ai_started` もその段階の会話への指示も無ければ、本書「停止中から戻る」の依存の解消の続きの指示を送る

始め方:

1. その issue のその段階の会話 (`conversations.kind` が `triage` / `design` で、`issue_id` が同じもの) があれば、その会話の続きに指示を送る。無ければ、作業ディレクトリをプロジェクトのディレクトリにして、指示を送らずに会話を作る
2. 会話の題名は `#<番号> の精査` / `#<番号> の設計` とする
3. 設計では、会話を作った後に設計の worktree を用意する (`features/design-review.md`「設計の作業場所」)。作れなければ停止中 (`failed`) に移す。`cause` は `worktree_failed`、`detail` は「worktree を作れませんでした: <git の出力の 1 行目>」とする
4. 設計では、会話の作業ディレクトリと `worktree_id` を設計の worktree にする。精査はプロジェクトのディレクトリのままとする
5. 許可の扱いとモデルは、プロジェクトの設定のものを使う (`features/project-settings.md`)
6. 最初の指示 (下の「精査の AI」「設計の AI」) を、`origin` を `flow` として送り、`ai_started` を足す

- 3 で作れなければ、issue を停止中へ移したあとに、設計の会話に止まった記録を書く。理由は `error`、文は `detail` と同じとする
- 会話は `failed` になり、末尾に「再開する」が出る。記録の合図 `stopped` が届いても、issue はすでに停止中なので状態を変えない
- 開発者が再開を選ぶか指示を送ると、`flow` が worktree を作り直す。最初の指示と開発者の指示を 1 通で届ける (本書「停止中から戻る」の `retryStageWorktree`)

`flow` が自分から会話へ送る指示 (最初の指示、報告の催促、続きの指示、設計書の PR の merge を頼む指示) は、どれも `origin` を `flow` として送る。最初の指示を開発者の指示と合わせて届けるとき (本書「停止中から戻る」) を除く。

### 精査の AI

精査の AI は、既存のスキル `dev-triage` の手順で issue を 1 件だけ精査する。最初の指示は次の文とする。`<...>` は送るときに埋める。

```text
#<番号>「<題名>」を精査してください。

- 手順は dev-triage のスキル (~/.claude/skills/dev-triage/SKILL.md と references/) に従ってください。扱う issue はこの 1 件だけです。
- この issue はアプリ sukuna が管理しています。GitHub の issue・ラベル・Project は使わず、issue の読み書きは mcp__sukuna__ のツールで行ってください。スキルの手順は、下の表のとおりに読み替えてください。
- 結果は report_triage で報告してください。人の判断が要るときは report_needs_human で報告してください。報告したら、番を終えてください。
- issue_get で読んだ designed が真なら、設計済みの issue です。採点せず、score を付けずに報告してください。
- 選択式の質問のツール (AskUserQuestion) は使わず、質問は report_needs_human に書いてください。
- プロジェクト: <プロジェクト名> (<パス>)。既定ブランチ: <ブランチ>。GitHub を<使う / 使わない>プロジェクトです。

<読み替えの表 (下の表の「スキルの箇所」と「この会話での読み替え」の 2 列)>
```

再開 (`cause` が `reopen`) で精査待ちに移った issue では、最初の指示の前に次の文を付け、`ai_started` の `reason` を `reopen` にする。

```text
この issue は再開されました。これまでの会話を踏まえて、もう一度精査してください。
```

`dev-triage` の読み替え:

| スキルの箇所 | スキルの動き | この会話での読み替え |
| --- | --- | --- |
| 前提を確かめる | `gh repo view`、ラベルと変数の確認、`git fetch origin` | ラベルと変数は確かめない。GitHub を使うプロジェクトだけ `git fetch origin` を行う。既定ブランチは指示の値を使う |
| 前提を確かめる | ファイルを `origin/<既定ブランチ>` から読む | GitHub を使うプロジェクトは `origin/<既定ブランチ>`、使わないプロジェクトは手元の既定ブランチから読む |
| 1. 対象を集める | `list-untriaged.sh` で最大 10 件を集め、作成者と 10 分の条件で外す | 行わない。扱うのは指示の 1 件だけで、作成者と時間の条件は見ない |
| 2. 読む | `gh issue view`、コメント、sub-issues、親を `gh` で読む | `issue_get` で、本文・コメント・親・子・依存先を読む |
| 2. 読む | `issue-<N>` ブランチの有無を見る | 見ない |
| 2. 読む | 以前の整理への回答を、コメントの印で探す | 印は使わない。開発者の回答は、この会話の発言として届く |
| 3. 振り分ける | 着手済み (`issue-<N>` ブランチ) の行 | 使わない |
| 3. 振り分ける | 事業・運営の 2 行 | `report_needs_human` で、閉じるか、どこで扱うかを尋ねる |
| 3. 振り分ける | `tracking` (sub-issue がある) | `report_triage` の `result` を `parent` にする |
| 3. 振り分ける | 緊急枠 | `report_needs_human` で緊急かを尋ねる。開発者が緊急と答えたら、採点せずに `report_triage` を `urgent: true` で報告する |
| 3. 振り分ける | 質問・確認だけ、人の判断が要る、読み取れない | `report_needs_human` で報告する。コメントの型は `references/templates.md` を質問の文に使う |
| 3. 振り分ける | それ以外 (`needs-design`) | `report_triage` の `result` を `design` にする |
| 3. 振り分ける | 種別のラベルを付ける | `report_triage` の `kind` に `bug` / `enhancement` / `refactoring` / `question` を入れる |
| 4. 採点する | 11 観点で採点し、スコアを本文の `## 優先度` に書く | 同じに採点する。本文の末尾に `## 優先度` を足すのは `issue_update` で行う。スコアは `report_triage` の `score` にも入れる |
| 4. 採点する | 親の `## 優先度` を写す | 同じに行う。親は `issue_get` の `parent` で分かる |
| 4. 採点する | 本文に `スコア` がすでにあれば採点し直さない | 同じに行う。`report_triage` の `score` にはその値を入れる |
| 5. 反映する | ラベルと本文を取り直し、`gh issue edit` と `gh issue comment` で反映する | 本文は `issue_update`、コメントは `issue_comment` で書く。ラベルは付けない |
| 5. 反映する | Project の `区分` を設定する | 行わない |
| 5. 反映する | 失敗したら `needs-human` を付ける | `report_needs_human` で、失敗したことと理由を報告する |
| 6. 最終報告 | issue ごとに 1 行で並べる | `report_triage` の `summary` に 1 行で書く |
| 会話の入口 (`CLAUDE_JOB_DIR`) | コメントに `claude attach` の行を足す | 行わない。この会話は issue から開ける |

### 精査の結果

`report_triage` を受けたら、`flow` は次の順に決める。

1. `triage_reported` を足す。`issues.kind` に種別を入れる
2. `issues.priority` が空なら、優先度を決めて入れる。開発者が決めた優先度があれば変えない (BR-038)
3. 子があれば、結果の値を問わず実装待ち (親) へ移す
4. 子が無く、結果が `design` なら、設計済みの issue は実装待ちへ、それ以外は設計待ちへ移す
5. 子が無く、結果が `parent` なら、ツールは失敗を返し、状態を変えない。文は「#<番号> には子がありません。設計へ進めるなら result を design にしてください」とする

優先度の決め方 (上の行から順に見て、最初に当たる行で決める):

| 条件 | 優先度 |
| --- | --- |
| `urgent` が真 (緊急枠) | 高 (`high`) |
| 親があり、親に優先度がある | 親と同じ |
| `score` が 9.0 以上 | 高 (`high`) |
| `score` が 3.0 以上 9.0 未満 | 中 (`medium`) |
| `score` が 3.0 未満 | 低 (`low`) |
| `score` が無い (設計済みの issue は採点しない) | 中 (`medium`) |

- 決め方を式で持つのは、同じスコアがいつも同じ優先度になるようにするためである。スコアの式と観点は `dev-triage` の `references/priority.md` に従う
- 開発者は、あとから優先度を変えられる (`features/issue.md`)

### 設計の AI

設計の AI は、既存のスキル `dev-feat-spec` の設計モードの手順で issue を 1 件だけ設計する。作業場所は設計の worktree である (`features/design-review.md`「設計の作業場所」)。最初の指示は次の文とする。

```text
#<番号>「<題名>」を設計してください。

- 手順は dev-feat-spec のスキル (~/.claude/skills/dev-feat-spec/SKILL.md) の設計モードに従ってください。扱う issue はこの 1 件だけです。
- この issue はアプリ sukuna が管理しています。GitHub の issue・ラベル・Project は使わず、issue の読み書きは mcp__sukuna__ のツールで行ってください。スキルの手順は、下の表のとおりに読み替えてください。
- 作業ディレクトリ <worktree のパス> は、この issue の設計のための worktree で、ブランチ <ブランチ> を開いています。ブランチを切り替えず、ここで設計書を書いてコミットしてください。push と PR の作成はしないでください。
- 終えたら、コミットしてから report_design で報告してください。人の判断が要るときは report_needs_human で報告してください。報告したら、番を終えてください。
- 選択式の質問のツール (AskUserQuestion) は使わず、質問は report_needs_human に書いてください。
- プロジェクト: <プロジェクト名> (<パス>)。既定ブランチ: <ブランチ>。GitHub を<使う / 使わない>プロジェクトです。

<読み替えの表 (下の表の「スキルの箇所」と「この会話での読み替え」の 2 列)>
```

`dev-feat-spec` の読み替え:

| スキルの箇所 | スキルの動き | この会話での読み替え |
| --- | --- | --- |
| 前提を確かめる | `gh repo view`、ラベルと `design-approved.yml` の確認 | 確かめない。既定ブランチは指示の値を使う |
| 前提を確かめる | 作業ツリーが dirty なら止まる | 作業ディレクトリ (設計の worktree) で確かめる。差し戻しで再開したときは、前回のコミットの上に続ける |
| 1. 対象を集めて並べる | `needs-design` の issue と設計 PR を集めて並べる | 行わない。扱うのは指示の 1 件だけである |
| 1. 対象を集めて並べる | `design/issue-<N>` ブランチと設計 PR の有無を見る | 見ない。ブランチは指示のものを使う |
| 2. 1 件ずつ設計する | `git switch --detach` で戻る | 行わない。ブランチを切り替えない |
| 3. 読んで振り分ける | コメントを `gh api` で読む | `issue_get` で本文とコメントを読む |
| 3. 読んで振り分ける | 判断待ち (`needs-human` を足す) | `report_needs_human` で質問を報告する |
| 3. 読んで振り分ける | 設計 PR | 設計書を変えてコミットする。PR は作らない |
| 3. 読んで振り分ける | 修正方針 | 本文の書き直しを `issue_update` で反映する。設計書を変えずに報告する |
| 4. 設計書を書く | ほかの設計 PR との衝突を `gh pr list` で確かめ、衝突すれば飛ばす | 飛ばさずに設計する。ほかの issue の設計のブランチ (`sukuna/design-*`) が同じ機能設計書を変えていれば、`report_design` の `checks` に「#<番号> の設計と同じ設計書を変えます」と書く |
| 4. 設計書を書く | `git switch -c design/issue-<N>` | 行わない。指示のブランチで書く |
| 4. 設計書を書く | スケッチの変更前と変更後を撮って PR に貼る | スケッチは直す。画像は撮らない (設計レビューは差分で読む) |
| 5. issue の本文を書き直す | 本文の下書きを作り、手順 7 で反映する | 同じに下書きを作り、`issue-check.sh` を通してから `issue_update` で反映する |
| 5. issue の本文を書き直す | 大きな issue を分け、子を作る | 子は `issue_create` で作る。`parent` にこの issue の番号を、`designed` に `true` を、依存は `depends_on` に入れる。本文の `Depends on #<番号>` の行も残す |
| 6. 別のコンテキストで検査する | subagent で 10 観点を検査する | 同じに行う。観点 7・8 の「PR の本文」は `report_design` の `policy` と `checks` に読み替える。観点 9 (画面の画像) は行わない |
| 7. 出す | 子を作り、コミットし、push して PR を作り、ラベルを付け替え、PR の URL をコメントする | コミットまで行い、`report_design` で報告する。`policy` に修正方針の要約を、`checks` に人に確かめたい点を 1 件ずつ入れる。push・PR・ラベル・コメントは行わない |
| 7. 出す | 止める (`needs-human` を足し、ブランチを消す) | `report_needs_human` で報告する。ブランチと worktree は消さない |
| 8. 最終報告 | issue ごとに 1 行で並べる | `report_design` の `policy` の最初の 1 行に書く |
| 直しのモード | PR 番号で起動し、人の指摘を受けて直す | 使わない。差し戻しの指摘は、この会話の続きに届く。設計書と本文を直し、手順 6 の検査をやり直して、もう一度 `report_design` で報告する。前に分けた子は `issue_update` で直す。要らなくなった子は `report_design` の `checks` に書き、開発者に取り下げを求める |
| 会話の入口 (`CLAUDE_JOB_DIR`) | コメントに `claude attach` の行を足す | 行わない |

### 設計済みの issue と親の issue

- 設計済みの issue は、作るときに設計済みの印 (`designed`) を付けて登録された issue である。`/dev-spec` と、設計の AI が分けた子が付ける (`features/issue.md`)
- 設計済みの issue も精査を通る。精査で人の判断が要れば停止中になる。設計へ進む結果なら、設計を省いて実装待ちになる (UC-008 A)
- 子を持つ issue は親として扱う。親は実装待ちのまま、設計も実装もしない (BR-036、UC-008 B)
- 親かどうかは、精査の結果を受けたときと、承認の反映が終わったときに、子の数で決める。精査の AI の結果の値より、子の数を優先する
- 設計待ちの issue は、子があっても親にせず設計する。設計で分けた子を持つ issue は、`report_design` → 設計レビュー → 承認と進み、反映のあとに実装待ち (親) になる
- 親の issue を実装の対象にしないこと、子がすべて閉じたら親を閉じることは `features/implementation-flow.md` に従う

### 人の判断が要るとき

AI は、決められない点を `report_needs_human` で報告する (UC-008 C)。

1. `flow` は `needs_human_reported` を足し、issue を停止中 (`question`) に移す。`detail` は 1 件目の質問の 1 行目とする
2. ツールは「停止中にしました。番を終えてください。回答はこの会話に届きます」を返す
3. 開発者は、その会話で答える。答えは開発者の発言として AI に届く (`features/conversation.md`)
4. 開発者の答えが会話に記録されると、issue は停止前の状態に戻る (本書「停止中から戻る」)。AI は同じ会話の続きで作業を続ける

- 段階の AI が選択式の質問で待ったときも (`waiting_answer`)、停止中 (`question`) に移す。回答を送ると、停止前の状態に戻る
- 質問の一覧 (`questions`) は、会話の番の終わりに `features/recap.md` が作る。issue の停止中は、その一覧を待たずに報告で決める

### 番の終わりで報告が無いとき

段階の AI が、報告のツールを呼ばずに番を正常に終えることがある。`flow` は `turnEnded` を受けたら次を行う。

1. 最後の `ai_started` より後に、その段階の報告 (`triage_reported` / `design_submitted` / `needs_human_reported`、実装では `features/implementation-flow.md` の報告) が無いかを見る
2. 無ければ、同じ会話に催促の指示を 1 回だけ送り、`report_nudged` を足す。文は「この issue の結果を <報告のツール名> で報告してください。人の判断が要るときは report_needs_human で報告してください」とする
3. 催促の後の番も報告なしで終わったら、停止中 (`failed`) に移す。`detail` は「結果の報告が無いまま AI が番を終えました」とする

- 次の番の終わりは、この規則の対象にしない: 開発者の発言で始まった番、設計書の PR の merge を待つ番 (`features/design-review.md`)、merge 前の確認で止まった後の番
- 開発者の発言で始まった番の決め方と、その番が報告なしで終わった issue の一覧での扱いは、`features/inbox.md`「一覧のセクション分け」の issue の行の表にある
- 開発者が段階の AI に発言を送ったときは、その番の終わりでは催促しない。開発者が会話をしている途中とみなす

### AI が止まったとき

段階の AI の会話が止まると、ランナーの会話のモジュールが `stopped` を出す (`features/runtime.md`)。`flow` は理由に応じて issue を移す (UC-008 E1)。理由の値は `conversations.stop_reason` と同じである (DESIGN.md「データスキーマ」)。

| 会話の止まった理由 | issue | `detail` |
| --- | --- | --- |
| `usage_limit` | 停止中 (`usage_limit`) | 「利用枠を使い切りました」 |
| `api_error` / `error` / `credits_required` | 停止中 (`failed`) | 会話の止まった理由の文の 1 行目 |
| `user` | 変えない | なし |
| `restarted` | 変えない。本書「ランナーの再起動のあと」で扱う | なし |

- 利用枠切れからの自動の再開は、会話のモジュールが行う (`features/conversation.md`)。再開が記録されると、issue は停止前の状態に戻る
- 会話のモジュールは、自動フローの会話を利用枠の戻りで再開する前に、`flow` に再開してよいかを問う。一時停止のあいだか、その段階が自動で処理する段階から外れていれば、`flow` は断る。断った会話は、解除か段階を戻したあとの評価で再開する
- 失敗からの再開は、開発者が会話の末尾の「再開する」を選ぶか、指示を送ったときだけ行う (BR-091)
- 再開した AI は、同じ会話の続きで、止まったところから作業を続ける (UC-008 E1 の 2c)

### 停止中から戻る

- `question` / `failed` / `usage_limit` の停止中は、停止中へ移した後に、停止前の状態の段階の会話へ指示 (`user_message`)・回答 (`answer`)・再開 (`resumed`) のどれかが記録されたときに、停止前の状態へ戻す。`cause` は `agent_resumed` とする
- `flow` は、開発者の指示・回答・再開の記録を、合図 `inputRecorded` で受ける。対象は `features/runtime.md`「ランナーの中の合図」の表のとおりで、預けた指示が届いたときと、割り込みの指示も含む。`working` になっただけでは戻さない
- worktree を作れなかった停止中 (`failed`、`cause` が `worktree_failed`) は、開発者が段階の会話に指示を送るか再開を選ぶと、届ける前に `flow` が worktree を作り直す (`retryStageWorktree`)。作れたら停止前の状態へ戻し、最初の指示を届けて `ai_started` (`reason` は `worktree_retry`) を足す
- 完了した issue の直しで作れなかったとき (最後の `reopened_for_fix` の後に、実装の会話へ指示が届いていない) は、最初の指示を直しの前置きの文にする (`features/pr-review.md`「merge の後に直させる」)
- 開発者の指示があれば、最初の指示の後に続けて 1 通にし、`origin` を `developer` として、前置きを含めて開発者の発言として会話に出す。再開を選んだときは、最初の指示だけを `origin` を `flow` として送る
- 作り直せなければ、停止中 (`failed`) から停止中 (`failed`) へ移す。`cause` は `worktree_failed`、`detail` は「worktree を作れませんでした: <git の出力の 1 行目>」とする。停止前の状態は元の停止のものを引き継ぐ
- そのとき段階の会話に、新しい文で止まった記録 (`error`) をもう一度書く。開発者の指示は届けず、書きかけの入力に残す (`features/conversation.md`)
- 作り直しは、指示 (`user_message`) と再開 (`resumed`) を記録する前に行う。作り直せなければどちらも記録しないので、停止前の状態へは戻らない
- `ci_failed` と `merge_confirm` は、開発者が実装の会話に指示を送ると、届ける前に実装中へ戻す (`features/pr-review.md` の `deliverImplInstruction`)。merge の許可でも実装中へ戻す
- 上の戻るきっかけで、取り下げの依存先が残っていれば、停止前の状態へ戻さずに停止中 (`dependency_withdrawn`) へ移す (本書「依存先の取り下げ」)
- `dependency_withdrawn` は、取り下げの依存先が無くなった時点で停止前の状態へ戻す。`cause` は `dependency_cleared` とする
- `dependency_withdrawn` から精査待ち・設計待ち・実装中に戻ったときは、止めた段階の会話の続きに指示を送り、`ai_started` (`reason` は `resume_dependency`) を足す。文は「依存先の取り下げが解消しました。止まったところから続けてください」とする。その段階の会話がまだ無ければ、評価で最初から始める
- 戻る先の段階で取り下げの依存先があれば、評価がもう一度停止中に移す

### 依存先の取り下げ

issue を取り下げると、その issue に依存する issue のうち、下書きと閉じたものを除くすべてを停止中 (`dependency_withdrawn`) にする (BR-076)。

- 依存する issue の段階の AI が動いていれば、止める。止めた作業は会話に残り、戻るときに続きから動く
- すでに別の理由で停止中の issue は、その理由のままにする。その理由から戻るときに、取り下げの依存先が残っていれば停止中 (`dependency_withdrawn`) に移す。動いている段階の AI は止め、停止前の状態は元の停止のものを引き継ぐ
- 下書きの issue は下書きのまま残す。確定したあと、段階を始める評価で停止中になる
- 取り下げと依存する issue の停止は、1 つのトランザクションで行う

### 一時停止と自動で処理する段階

全体の一時停止は `settings` のキー `flow_paused`、プロジェクトの一時停止は `projects.flow_paused` で持つ (`features/project-settings.md`)。

一時停止のあいだは、`flow` が自分から会話へ送る指示を送らない (BR-064)。

- 送らないもの: 段階の最初の指示、報告の催促、依存先の取り下げが解消したときの続きの指示、ランナーの再起動のあとの続きの指示、承認のあとに設計書の PR の merge を頼む指示、利用枠が戻ったときの自動の再開
- 送るもの: 開発者の操作から起きる指示 (回答、発言、再開、差し戻し、merge の許可)。開発者が始めた作業の続きだからである (P2)
- 動いている AI は止めない。番の途中でも最後まで動かす
- 状態の移り変わりそのものは止めない。報告を受ければ状態を移す
- 一時停止を解くと、画面のサーバーが `/flow/notify` を送る。評価が、待っていた issue の AI を始め、送らなかった続きの指示を送る (UC-014 A。本書「段階の AI を始める」)
- 一時停止のあいだに利用枠切れで止まった段階の会話も、解いたあとの評価が再開する。issue が停止中 (`usage_limit`) のままでも対象にする

「自動で処理する段階」(`features/project-settings.md`) から外した段階の会話には、一時停止のあいだに送らないものを同じに送らない。設計書の PR の merge を頼む指示は、設計の段階として扱う。issue はその状態のまま待ち、段階を戻すと評価が始めるか、続きの指示を送る。

### 壁打ちから `/dev-spec` で始めるとき

開発者が始めた会話 (`kind` が `chat`) で `/dev-spec` を呼び出すと、AI は設計書を作り、親子の issue をアプリのツールで登録する (UC-008 D)。アプリは会話の実行を開くたびに、追加の指示として `features/issue.md`「issue の扱いの追加の指示」の文を渡す。`dev-spec` の issue を作る手順は、その文で次のように読み替えさせる。

| スキルの箇所 | スキルの動き | この会話での読み替え |
| --- | --- | --- |
| フェーズ 10 の前 | 人に作成の可否を尋ねる | 同じに尋ねる。開発者がこの会話にいる |
| フェーズ 10 | `create-issues.sh` で GitHub に親と子を作る | スクリプトは使わない。`issue_list` で同じ題名の issue を探し、無ければ `issue_create` で作る。あれば `issue_update` で本文を合わせる |
| フェーズ 10 | ラベル 4 種を用意する | 行わない |
| フェーズ 10 | 親を先に作り、子を依存の上流から作る | 同じ順に作る。子の `parent` に親の番号を、`depends_on` に依存先の番号を入れる。`Depends on issue-<連番>` の行は番号に置き換えて本文に残す |
| フェーズ 10 | 子を親の sub-issue に紐付ける | `issue_create` の `parent` で済む。別の操作は要らない |
| フェーズ 10 | 作る issue | 親と子のどちらにも `designed: true` を付ける |
| フェーズ 10 のあと | docs のコミットを既定ブランチへ入れるよう案内する | issue を作る前に、設計書のコミットを既定ブランチへ入れる。作った子はすぐに精査され、実装が始まるためである。入れられなければ、issue を作らずに開発者に伝える |
| フェーズ 10 のあと | `/dev-impl` を起動するよう案内する | 案内しない。実装は自動で始まる |

- 登録された issue は確定済みで、精査待ちになる (BR-035、UC-008 D の 1c)
- 親は、精査の結果を受けたときに子があるので、実装待ち (親) になる。子は精査を通ると実装待ちになる

### ランナーの再起動のあと

ランナーは起動時に、前回の起動で残った Claude Code の子プロセスを止めてから始める (DESIGN.md「横断規約 > ランナーの再起動」)。会話のモジュールは、前回 `working` / `waiting_answer` / `waiting_permission` だった会話を `stopped` (`restarted`) にし、前の状態を `stopped` の記録の `previous_run_state` に残す (`features/runtime.md`「ランナーの再起動」)。そのあと `flow` は全プロジェクトについて次を行う。

1. 段階の会話 (`kind` が `triage` / `design` / `impl`) のうち、`stopped` (`restarted`) で `previous_run_state` が `working` か `waiting_permission` のものに、続きの指示を送る。`ai_started` (`reason` は `restart`) を足す。`waiting_permission` だった会話では、AI が同じ許可をもう一度求める
2. `previous_run_state` が `waiting_answer` の段階の会話には、続きの指示を送らない。issue が停止中でなければ停止中 (`question`) に移す。`cause` は `restart_question`、`detail` は 1 件目の質問の 1 行目とする。開発者の回答は指示の文として届く (`features/runtime.md` の `answer_text`)
3. 開発者が止めた会話 (`stopped` (`user`)) と、失敗で止まった会話 (`failed`) には何も送らない
4. 利用枠切れで止まっていた会話は、会話のモジュールが待ちのタイマーを張り直す
5. 最後の `design_approved` の後に結果の記録が無い issue は、反映をやり直す (`features/design-review.md`「承認と反映」)。結果の記録は `design_reflected`・`design_reflect_failed`・`design_pr_created` の 3 つである
6. 評価を全プロジェクトで 1 回ずつ行う。始めるはずだった AI はここで始まる
7. 実装の会話の扱いのうち、実装に固有のこと (CI の待ちの続き) は `features/implementation-flow.md`「ランナーの再起動のあと」に従う

続きの指示の文は次のとおりとする。

```text
ランナーが再起動しました。中断したところから続けてください。直前のツールの実行は結果が分からないので、必要なら確かめ直してください。
```

- 一時停止のあいだと、自動で処理する段階から外した段階には、1 の続きの指示を送らない。解除か段階を戻したあとの評価で、`stopped` (`restarted`) のままの段階の会話に送る
- 解除したプロジェクトの会話には送らない。解除のときに止めた会話 (`stopped` (`user`)) には、同じパスを登録し直しても送らない。開発者が issue の会話に指示を送ると続く (`features/project-settings.md`「解除」)
- 開発者が始めた会話の扱いは `features/conversation.md` に従う

## API

画面向けの API は持たない。issue を確定・取り下げ・再開する API と、ランナーへの受け渡しは `features/issue.md`「API」にある。

- `flow` は、画面のサーバーからソケットの `/flow/notify` (`features/runtime.md`) を受けて評価を行う
- `/flow/notify` の `issue_id` があればその issue のプロジェクトを、`project_id` だけならそのプロジェクトを、どちらも無ければ全プロジェクトを評価する
- `issue_id` 付きの知らせでは、評価の前に、GitHub で merge された PR を確かめる (`features/implementation-flow.md`「GitHub で merge されたとき」)

## 実装の配置

| 処理 | 層 | 実装先ファイル |
| --- | --- | --- |
| 状態と停止中の理由の値、移り変わりの表、`cause` の値 | 共有 | `src/shared/issue/state.ts` |
| 移り変わりの判定 (元の状態ときっかけから、移った先を返す) | ドメイン | `src/runner/modules/flow/domain/transition.ts` |
| 評価の条件 (始めるか、親か、依存先の取り下げか) | ドメイン | `src/runner/modules/flow/domain/evaluate.ts` |
| 優先度の決め方 (スコアと親から) | ドメイン | `src/runner/modules/flow/domain/priority.ts` |
| 最初の指示の文と読み替えの表、催促と続きの指示の文 | ドメイン | `src/runner/modules/flow/domain/instructions.ts` |
| 状態を移す → issues, issue_events | ユースケース | `src/runner/modules/flow/usecase/move-state.ts` |
| 評価と段階の AI の開始 → issues, issue_events, conversations | ユースケース | `src/runner/modules/flow/usecase/evaluate-project.ts` |
| 精査の結果と人の判断の報告を受ける → issues, issue_events | ユースケース | `src/runner/modules/flow/usecase/on-report.ts` |
| 会話の合図を受ける (番の終わり、状態の変化、止まった、指示と再開の記録) → issues, issue_events | ユースケース | `src/runner/modules/flow/usecase/on-conversation-signal.ts` |
| 依存先の取り下げと解消 → issues, issue_events, issue_dependencies | ユースケース | `src/runner/modules/flow/usecase/dependency-withdrawn.ts` |
| worktree を作り直して最初の指示を届ける (`retryStageWorktree`) → issues, issue_events, conversations, worktrees | ユースケース | `src/runner/modules/flow/usecase/retry-stage-worktree.ts` |
| ランナーの再起動のあとの続き → conversations, issues, issue_events | ユースケース | `src/runner/modules/flow/usecase/recover-after-restart.ts` |
| issue と `issue_events` の読み書き | インフラ (Repository) | `src/runner/modules/flow/adapter/issue-repository.ts` |
| `/flow/notify` の受け口 | API ハンドラ (ソケット) | `src/runner/modules/flow/adapter/notify-handler.ts` |

- 報告のツールの定義と入力の検査は `features/issue.md` の配置にあり、受けた後の処理を上の `on-report.ts` に渡す
- テーブルの定義は DESIGN.md「データスキーマ」参照

## エッジケースの決定

1. **空・最小データ**: 本文が空の issue も精査する。精査の AI は「読み取れない」に振り分け、人の判断が要ることを報告する。依存も親も無い issue は、依存と親の条件を満たしたものとして扱う
2. **上限・境界値**: 精査と設計は、同時に動く数に上限を設けない (BR-042)。報告の催促は 1 回までとする。質問の数は、1 回の報告で 1〜20 件、1 件 2,000 字までとする (`features/issue.md`)。優先度の境界は、9.0 ちょうどが高、3.0 ちょうどが中である
3. **エラー時に利用者へ見えるもの**: 停止中の理由と `detail` を、一覧の状況の文と会話の末尾に出す (`features/inbox.md`、`features/issue.md`)。会話を始められないとき (ランナーの中の失敗) は、停止中 (`failed`) にして理由を `detail` に入れる
4. **並行操作・二重実行**: 評価は何度呼んでも同じ結果になる (同じ段階の `ai_started` があれば始めない)。同じ issue の報告が 2 回来たら、2 回目は状態が合わないのでツールが失敗を返す。状態の検査と移り変わりは 1 つのトランザクションで行う。取り下げと報告が重なったら、先にトランザクションを取った方だけが効く
5. **再表示時の整合**: 状態の変化は `issue:<id>` と一覧の配信で画面へ伝え、画面は API で読み直す (DESIGN.md「横断規約 > 配信」)。配信が途切れても、`issue_events` の `seq` から読み直せる
6. **表示の寿命**: 停止中の `detail` は、停止中のあいだだけ出す。停止前の状態に戻ると消える。`state_changed` の行は消さずに残し、移り変わりの記録として読める
7. **送る前のデータ**: 停止中の issue への回答は、会話の送る前の回答と書きかけの入力に置く (`features/conversation.md`、P1)。issue の状態に送る前のデータは持たない
8. **状態の移り変わり**: 「状態の移り変わりの表」のとおりである。開発者が止めた段階の AI は、issue の状態を変えずに指示を待つ。表に無いきっかけでは状態を変えない
9. **自動で進むこと**: 段階の AI の開始、報告の催促、依存先の取り下げの解消、ランナーの再起動のあとの続きは自動で行う (P2)。失敗からの再開は自動で行わない (BR-091)。一時停止のあいだは、自分から送る指示を止める
10. **端末と画面をまたぐこと**: issue の状態と停止中の理由はサーバーに置き、どの端末でも同じにする (P3)。どの端末で答えても、同じ会話に届いて同じように戻る
11. **並びと数え方**: 精査と設計は、評価で見つけた順に始める。見つける順は、プロジェクトの登録順、その中の issue の番号の小さい順とする。報告の無い番は、最後の `ai_started` より後の番の終わりを数える

## テスト方針

| 受け入れ基準 (docs/design/USECASES.md) | レベル |
| --- | --- |
| （US-008）issue を確定すると、手で起動しなくても精査の AI が始まり、続けて設計の AI が始まる | 結合 |
| （US-008）設計の AI が設計書の変更か修正方針を作り終えると、issue が設計レビューになり、判断待ちとして一覧に出る | E2E |
| （US-039）issue が精査待ちか設計待ちになるか、依存先がすべて閉じた issue が実装待ちになると、その状態に応じた AI がすぐに始まる | 結合 |
| （US-039）同じ issue で AI が動いている間は、その issue に別の AI は始まらない | 結合 |
| （US-041）`/dev-spec` が作った設計済みの issue は、精査を通ると、設計を省いて実装待ちになる | 結合 |
| （US-040）会話で壁打ちして `/dev-spec` を呼び出すと、設計書ができ、親子の issue がアプリに登録される | 結合 |
| （US-011）AI が決められない点を質問として書くと、issue が停止中になり、答えると止まった段階から再開する | 結合 |
| （US-032）精査か設計の AI が失敗か利用枠切れで止まると、理由が記録されて停止中になり、再開を選ぶと止まった段階から始まる | 結合 |
| （US-008）子を持つ issue を確定すると、親として扱われ、設計も実装も始まらない | 結合 |

- 結合: ランナーの `flow` を、本物の SQLite で動かす。Agent SDK は台本どおりに動く偽物に差し替え、台本でアプリのツール (`report_triage`、`report_design`、`report_needs_human`、`issue_create`) を呼ばせる。偽物は、名前が `mcp__sukuna__` で始まるツールの呼び出しでは、登録した処理を実際に呼ぶ (`features/runtime.md`)。設計の worktree は一時ディレクトリの本物の git のリポジトリに作る
- 移り変わりの表は、ドメインの `transition.ts` を表の行ごとの単体テストでも確かめる。表の行を足したら、テストの行も足す
- `/dev-spec` の行は、`chat` の会話の台本が `issue_create` で親と子 (`designed: true`) を作ると、親が実装待ち (親)、子が精査のあと実装待ちになることを確かめる。設計書を作るのはスキルの振る舞いで、アプリは関わらないので確かめない
- 失敗と利用枠切れの行は、台本で失敗と利用枠切れの番の終わりを流し、時計を偽物に差し替えて枠の戻りの再開を進める。実時間は待たない
- 優先度の境界 (3.0、9.0 ちょうど) と、親の優先度を写すことは、`priority.ts` の単体テストで確かめる
- E2E: 精査待ちの issue を前提データで用意し、一覧を開いたまま、偽物の AI が精査と設計を報告すると、一覧の判断待ちに設計の承認の行が出ることを確かめる。確定の操作は `features/issue.md` の E2E がなぞるので、ここでは前提データで始める

E2E 対象動線: （US-008）設計の AI が設計書の変更か修正方針を作り終えると、issue が設計レビューになり、判断待ちとして一覧に出る
