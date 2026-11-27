export function issueInstructions(): string {
  return `このプロジェクトの issue は、アプリ sukuna が管理しています。
- issue を読む・作る・直すときは、mcp__sukuna__ のツール (issue_get、issue_list、issue_create、issue_update、issue_comment) を使ってください。gh issue のコマンドと、GitHub の issue・ラベル・Project・sub-issues の API は使わないでください。
- issue の番号は、このプロジェクトの中の番号で、GitHub の issue の番号ではありません。PR の本文に Closes #<番号> などの、GitHub の issue を閉じるキーワードを書かないでください。
- issue の状態はアプリが決めます。ツールで状態を変えることはできません。
- スキル (dev-spec など) の手順が GitHub に issue を作るときは、issue_create で作ってください。親は parent、依存は depends_on で渡し、設計を終えた issue には designed: true を付けてください。設計書のコミットは、issue を作る前に既定ブランチへ入れてください。
- 作った issue は確定済みで、すぐに精査が始まります。`;
}
