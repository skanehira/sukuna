import type { Answers } from "../events";

export const answersChanged = {
  code: "answers_changed",
  message: "回答が変わりました。内容を確認してからもう一度送ってください。",
} as const;

export function sameAnswers(left: Answers, right: Answers): boolean {
  const entries = Object.entries(left);
  return (
    entries.length === Object.keys(right).length &&
    entries.every(([index, answer]) => {
      const other = right[index];
      return (
        other !== undefined &&
        answer.text === other.text &&
        answer.choices.length === other.choices.length &&
        answer.choices.every((choice, position) => choice === other.choices[position])
      );
    })
  );
}
