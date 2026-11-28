import { err, ok } from "neverthrow";
import { answersChanged, sameAnswers } from "../../../../shared/conversation/answers";
import type { PendingAnswers, SendConversationAnswers } from "../../../../shared/conversation/api";
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
  { questionSeq, confirmUnanswered, confirmedAnswers }: SendConversationAnswers,
  deps: ConversationDependencies,
) {
  const pending = deps.repository.pendingAnswers(id);
  const question = deps.repository.unansweredQuestion(id);
  if (
    !pending ||
    !question ||
    question.seq !== pending.questionSeq ||
    (questionSeq === undefined
      ? deps.repository.hasQuestionBefore(id, question.seq)
      : questionSeq !== question.seq)
  )
    return err(conflict);
  if (
    confirmUnanswered &&
    (questionSeq === undefined ||
      !confirmedAnswers ||
      !sameAnswers(pending.answers, confirmedAnswers))
  )
    return err(answersChanged);
  if (!Object.values(pending.answers).some((a) => a.choices.length || a.text)) return err(conflict);
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
  const path = `/conversations/${encodeURIComponent(id)}/answers`;
  const input = {
    request_id: question.payload.request_id,
    question_seq: question.seq,
    answers: pending.answers,
  };
  const result = confirmUnanswered
    ? await deps.runner.call("POST", `${path}/checked`, input, {
        missingRouteMessage: "ランナーを更新してから、回答を見直してもう一度送ってください。",
      })
    : await deps.runner.call("POST", path, input);
  if (result.isErr()) return err(result.error);
  if (result.value.status >= 400) return ok(result.value);
  const body = result.value.body as { result: string };
  reopen(id, deps);
  return ok({ status: 202, body: { result: body.result } });
}
