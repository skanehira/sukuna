import { decisionFileHash } from "../../../../shared/recap/decision-file-store";
import type { DecisionFileStore } from "../../../../shared/recap/ports";
import { readDecisionRecap } from "../../../../shared/recap/decision-file";
import { addDecisions } from "../domain/decisions";
import type { PendingRecap, PendingRecaps } from "../domain/pending-recap";
import type { RecapConversation, RecapRepository, RecapTurn } from "../domain/repository";

type Dependencies = {
  repository: RecapRepository;
  files: DecisionFileStore;
  pending: PendingRecaps;
  id: () => string;
  failure: (id: string, error: unknown) => void;
};

export function saveRecap(
  deps: Dependencies,
  conversation: RecapConversation,
  turn: RecapTurn,
  record: PendingRecap,
): void {
  const { id, path, title, reflectedSeq } = conversation;
  const { endSeq, token, replacement, summary } = record;
  if (summary.decisions.length) {
    const recap = { endSeq, token };
    let conflict = false;
    let firstRead = true;
    const saved = deps.files.update(path, id, title, (content, currentHash) => {
      const applied = readDecisionRecap(content);
      if (
        (applied?.endSeq === endSeq && applied.token === token) ||
        currentHash === replacement?.after
      )
        return content;
      if (firstRead && replacement && currentHash !== replacement.before) {
        conflict = true;
        return content;
      }
      firstRead = false;
      const next = addDecisions(content, summary, recap);
      return {
        content: next,
        prepare: () =>
          deps.pending.write(id, {
            ...record,
            replacement: { before: currentHash, after: decisionFileHash(next) },
          }),
        cancel: () => deps.pending.remove(id),
      };
    });
    if (conflict)
      throw new Error("決まったことのファイルが変更され、前回の保存を確認できませんでした。");
    if (saved.isErr()) throw new Error(saved.error.message);
  }
  deps.repository.save(id, reflectedSeq, turn, {
    ...summary,
    questions: summary.questions.map((question) => ({ ...question, id: deps.id() })),
  });
  if (summary.decisions.length) {
    try {
      deps.pending.remove(id);
    } catch (error) {
      deps.failure(id, error);
    }
  }
}
