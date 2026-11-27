#!/bin/sh
# 使い方: sh scripts/mutation-changed.sh [<基準の ref>]  (既定は origin/main)
# 基準から変えた src のソースだけに変異テストを流す。対象が無ければ終了コード 0 で終わる。
set -eu

base="${1:-origin/main}"
changed=$(git diff --name-only --diff-filter=AMR "$base...HEAD" -- 'src/*.ts' 'src/*.tsx')
files=$(printf '%s\n' "$changed" | grep -Ev '\.test\.tsx?$|\.d\.ts$|^src/test/' | paste -sd, -) || true

if [ -z "$files" ]; then
  echo "変異テストの対象になるファイルは変わっていない ($base...HEAD)"
  exit 0
fi

echo "変異テストの対象: $files"
exec vp run mutation --mutate "$files"
