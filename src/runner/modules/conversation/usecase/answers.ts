import { err, ok, type Result } from "neverthrow";
import type { ConversationRuntime, DeliveryError, InputAcceptance } from "./runtime";
import { answersChanged, sameAnswers } from "../../../../shared/conversation/answers";
import type { Answers } from "../../../../shared/events";
import { callerInputAcceptance, conflict, InputRefused } from "./runtime";
import { sendUnlocked } from "./send";
type AnswerOutcome = { result: "answered" | "delivered" | "queued"; seq?: number };
type AnswerError = DeliveryError | typeof answersChanged;
const savedAnswersConflict = { code: "conflict", message: answersChanged.message } as const;
export async function answer(
  this: ConversationRuntime,
  id: string,
  requestId: string,
  answers: Answers,
  callerCancelled?: () => boolean,
  questionSeq?: number,
): Promise<Result<AnswerOutcome, AnswerError>> {
  const submitAnswer = async (): Promise<Result<AnswerOutcome, DeliveryError>> => {
    const question = this.store
      .events(id)
      .find(
        (e) =>
          e.type === "question" &&
          e.payload.request_id === requestId &&
          (questionSeq === undefined || e.seq === questionSeq),
      );
    if (question?.type !== "question") return err(conflict());
    const caller = callerInputAcceptance(callerCancelled);
    const check = () => {
      const cancelled = caller?.check?.();
      if (cancelled) return cancelled;
      if (!this.store.isUnanswered(id, question.seq)) return conflict();
      if (questionSeq !== undefined) {
        const pending = this.store.pendingAnswers(id, questionSeq);
        if (!pending || !sameAnswers(pending, answers)) return savedAnswersConflict;
      }
      return null;
    };
    const refused = check();
    if (refused) return err(refused);
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
    const acceptance: InputAcceptance = {
      ...caller,
      check,
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
      const [record] = this.record(
        id,
        acceptance.events,
        () => {
          const refused = check();
          if (refused) throw new InputRefused(refused);
          acceptance.before?.();
        },
        undefined,
        () => {
          const cancelled = caller?.checkBeforeCommit?.();
          if (cancelled) throw new InputRefused(cancelled);
        },
      );
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
  const result = await this.serial(id, submitAnswer, callerCancelled);
  return result.mapErr((error) => (error === savedAnswersConflict ? answersChanged : error));
}
