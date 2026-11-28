import { err, ok, type Result } from "neverthrow";
import type { ConversationRuntime, DeliveryError } from "./runtime";
import type { Answers } from "../../../../shared/events";
import { callerInputAcceptance, conflict } from "./runtime";
import { sendUnlocked } from "./send";
type AnswerOutcome = { result: "answered" | "delivered" | "queued"; seq?: number };
export function answer(
  this: ConversationRuntime,
  id: string,
  requestId: string,
  answers: Answers,
  callerCancelled?: () => boolean,
): Promise<Result<AnswerOutcome, DeliveryError>> {
  const submitAnswer = async (): Promise<Result<AnswerOutcome, DeliveryError>> => {
    const question = this.store
      .events(id)
      .find((e) => e.type === "question" && e.payload.request_id === requestId);
    if (question?.type !== "question" || !this.store.isUnanswered(id, question.seq))
      return err(conflict());
    const formatted = Object.fromEntries(
      question.payload.questions.map((q, index) => {
        const a = answers[String(index)];
        const choices = a?.choices.join("、") ?? "";
        const text = a?.text ?? "";
        return [
          q.question,
          choices && text ? `${choices}: ${text}` : choices || text || "(開発者は答えなかった)",
        ];
      }),
    );
    const execution = this.executions.get(id);
    const waiting =
      execution?.question?.request.requestId === requestId ? execution.question : undefined;
    const caller = callerInputAcceptance(callerCancelled);
    const acceptance = {
      ...caller,
      check: () =>
        caller?.check?.() ?? (this.store.isUnanswered(id, question.seq) ? null : conflict()),
      events: [
        {
          type: "answer" as const,
          payload: { request_id: requestId, answers, as_message: !waiting },
        },
      ],
      before: () => this.store.finishAnswers(id, question.seq),
    };
    if (waiting) {
      if (this.closing) return err(conflict());
      const [record] = this.record(id, acceptance.events, acceptance.before);
      delete execution?.question;
      waiting.resolve(formatted);
      return ok({ result: "answered", seq: record?.seq });
    }
    const sent = await sendUnlocked.call(
      this,
      id,
      {
        text: question.payload.questions
          .map((q) => `Q: ${q.question}\nA: ${formatted[q.question]}`)
          .join("\n\n"),
        images: [],
        origin: "answer_text",
      },
      acceptance,
    );
    if (sent.isErr()) return err(sent.error);
    return ok({
      result: sent.value.result,
      ...(sent.value.result === "delivered" ? { seq: sent.value.seq } : {}),
    });
  };
  return this.serial(id, submitAnswer, callerCancelled);
}
