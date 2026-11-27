import { err, ok, type Result } from "neverthrow";
import type { ConversationRuntime, OperationError } from "./runtime";
import type { Answers } from "../../../../shared/events";
import { conflict } from "./runtime";
import { sendUnlocked } from "./send";
export function answer(
  this: ConversationRuntime,
  id: string,
  requestId: string,
  answers: Answers,
): Promise<Result<{ result: "answered" | "delivered" | "queued"; seq?: number }, OperationError>> {
  return this.serial(id, async () => {
    const question = this.store
      .events(id)
      .find((e) => e.type === "question" && e.payload.request_id === requestId);
    if (question?.type !== "question") return err(conflict());
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
    const acceptance = {
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
  });
}
