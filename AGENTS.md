# AGENTS.md

- 種別: エージェント向けの作業規約
- 読み手: このリポジトリで issue を実装する Codex などのエージェント

## 設計とコマンド

設計の正本は `docs/design/` にある。横断の決定は `docs/design/DESIGN.md`、機能ごとの決定は `docs/design/features/` に書く。コマンドは DESIGN.md「開発・検証コマンド」の表に従い、`vp` で実行する。

## テスト

- 入出力を持たない関数で入力の組み合わせが多いものには、property テストを書く。ファイルの名前、正の性質、seed の扱いは DESIGN.md「開発・検証コマンド」に従う
- 変異テスト (`vp run mutation` など) は、頼まれたときだけ流す。issue の実装の手順には入れない。CI でも流さない
