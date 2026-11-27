export function openPosition(
  events: { seq: number; type: string }[],
  lastReadSeq: number,
  working: boolean,
) {
  const unreadSeq =
    events.find((event) => event.seq > lastReadSeq && event.type !== "user_message")?.seq ?? null;
  const lastUser = events.findLast((event) => event.type === "user_message");
  const tail = working || (unreadSeq === null && !lastUser);
  return {
    seq: tail ? (events.at(-1)?.seq ?? null) : (unreadSeq ?? lastUser?.seq ?? null),
    unreadSeq,
    recent: unreadSeq !== null,
    tail,
  };
}
