export type WorktreeConflict = {
  code: "conflict";
  message: string;
  details: {
    reason: "main" | "flow" | "running" | "locked" | "uncommitted" | "unpushed";
    count: number;
    sample: string[];
  };
};
export type WorktreeSafetyInput = {
  main: boolean;
  origin: "user" | "flow";
  issue: { number: number; state: string } | null;
  conversations: { title: string | null; runState: string }[];
  locked: string | null;
  uncommittedCount: number;
  uncommittedSample: string[];
  unpushedCount: number;
  head: string;
  mergedPrHeads: string[];
};

export function worktreeSafety(input: WorktreeSafetyInput): {
  allowed: boolean;
  unpushedCount: number;
  conflict: WorktreeConflict | null;
} {
  const unpushedCount =
    input.issue !== null && input.mergedPrHeads.includes(input.head) ? 0 : input.unpushedCount;
  const reject = (
    reason: WorktreeConflict["details"]["reason"],
    message: string,
    count = 0,
    sample: string[] = [],
  ) => ({
    allowed: false,
    unpushedCount,
    conflict: { code: "conflict" as const, message, details: { reason, count, sample } },
  });
  if (input.main) return reject("main", "プロジェクトのディレクトリは消せません");
  if (
    input.origin === "flow" &&
    input.issue !== null &&
    !["done", "withdrawn"].includes(input.issue.state)
  )
    return reject(
      "flow",
      `issue #${input.issue.number} の自動フローが使っています。issue が閉じると片付けられます`,
    );
  const running = input.conversations.find((conversation) =>
    ["working", "waiting_answer", "waiting_permission"].includes(conversation.runState),
  );
  if (running)
    return reject(
      "running",
      `会話: ${running.title ?? "無題"} の AI が動いています。止めてから消してください`,
    );
  if (input.locked !== null)
    return reject("locked", `この worktree はロックされています: ${input.locked}`);
  if (input.uncommittedCount > 0) {
    const rest = input.uncommittedCount > 1 ? ` ほか ${input.uncommittedCount - 1} 件` : "";
    return reject(
      "uncommitted",
      `未コミットの変更があるため消していません (${input.uncommittedSample[0]}${rest})`,
      input.uncommittedCount,
      input.uncommittedSample,
    );
  }
  if (unpushedCount > 0)
    return reject("unpushed", "未 push のコミットがあるため消していません", unpushedCount);
  return { allowed: true, unpushedCount, conflict: null };
}
