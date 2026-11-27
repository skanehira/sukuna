#!/bin/sh
# 使い方: sh scripts/mutation-changed.sh [<基準の ref>]  (既定は origin/main)
# 基準から変えた src のソースの行だけに変異テストを流す。対象の行が無ければ終了コード 0 で終わる。
set -eu

base="${1:-origin/main}"
diff=$(git diff -U0 --no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/ \
  --diff-filter=AMR "$base...HEAD" -- 'src/*.ts' 'src/*.tsx')
ranges=$(printf '%s\n' "$diff" | awk '
  /^\+\+\+ b\// {
    file = substr($0, 7)
    skip = file ~ /\.test\.tsx?$|\.d\.ts$|^src\/test\//
    next
  }
  /^@@ / && !skip {
    split(substr($3, 2), hunk, ",")
    count = (2 in hunk) ? hunk[2] : 1
    if (count > 0) {
      printf "%s%s:%d-%d", separator, file, hunk[1], hunk[1] + count - 1
      separator = ","
    }
  }
')

if [ -z "$ranges" ]; then
  echo "変異テストの対象になる行は変わっていない ($base...HEAD)"
  exit 0
fi

echo "変異テストの対象: $ranges"
exec vp run mutation --mutate "$ranges"
