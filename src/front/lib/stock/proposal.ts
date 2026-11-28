import type { Event } from "../conversation/types";

export function completedProposal(
  events: readonly Event[],
): { seq: number; text?: string } | undefined {
  const index = events.findLastIndex((event) => event.type === "user_message");
  const request = events[index];
  if (request?.type !== "user_message" || request.payload.origin !== "finish_proposal") return;
  const turn = events.slice(index + 1);
  const boundary = turn.findIndex(
    (event) => event.type === "turn_end" || event.type === "stopped" || event.type === "resumed",
  );
  if (boundary < 0) return;
  const end = turn[boundary];
  const answer = turn
    .slice(0, boundary)
    .findLast(
      (event) => event.type === "assistant_text" && event.payload.parent_tool_use_id === null,
    );
  return {
    seq: request.seq,
    ...(end.type === "turn_end" &&
    end.payload.subtype === "success" &&
    turn[boundary + 1]?.type !== "stopped" &&
    answer?.type === "assistant_text" &&
    answer.payload.text.trim()
      ? { text: answer.payload.text }
      : {}),
  };
}
