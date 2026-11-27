import { err, ok } from "neverthrow";
import type { PendingAnswers } from "../../../../shared/conversation/api";
import type { ConversationDependencies, ConversationError } from "../domain/ports";
import { missingConversation } from "../domain/ports";
import { reopen } from "./reopen";
const conflict: ConversationError = {
  code: "conflict",
  message: "回答する質問が変わりました。読み直してください。",
};
export function saveAnswers(id: string, pending: PendingAnswers, deps: ConversationDependencies) {
  if (!deps.repository.conversation(id)) return err(missingConversation);
  const result = deps.repository.transaction(() => {
    const question = deps.repository.unansweredQuestion(id);
    if (!question || question.seq !== pending.questionSeq) return err(conflict);
    if (
      Object.keys(pending.answers).some(
        (key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= question.payload.questions.length,
      )
    )
      return err<never, ConversationError>({
        code: "invalid_input",
        message: "入力を確認してください。",
      });
    deps.repository.saveAnswers(id, pending, deps.now());
    return ok({ pendingAnswers: pending });
  });
  if (result.isOk()) deps.changed(id, ["answers"]);
  return result;
}
export async function sendAnswers(
  id: string,
  confirmUnanswered: boolean,
  deps: ConversationDependencies,
) {
  const pending = deps.repository.pendingAnswers(id);
  const question = deps.repository.unansweredQuestion(id);
  if (
    !pending ||
    !question ||
    question.seq !== pending.questionSeq ||
    !Object.values(pending.answers).some((a) => a.choices.length || a.text)
  )
    return err(conflict);
  if (
    !confirmUnanswered &&
    question.payload.questions.some((_, index) => {
      const a = pending.answers[String(index)];
      return !a || (!a.choices.length && !a.text);
    })
  )
    return err<never, ConversationError>({
      code: "unanswered_questions",
      message: "答えていない質問があります。確認してから送ってください。",
    });
  const result = await deps.runner.call(
    "POST",
    `/conversations/${encodeURIComponent(id)}/answers`,
    { request_id: question.payload.request_id, answers: pending.answers },
  );
  if (result.isErr()) return err(result.error);
  if (result.value.status >= 400) return ok(result.value);
  const body = result.value.body as { result: string };
  reopen(id, deps);
  return ok({ status: 202, body: { result: body.result } });
}
