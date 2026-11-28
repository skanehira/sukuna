import type Database from "better-sqlite3";
import { assistantResponseEventTypes } from "../events";

const responseTypes = assistantResponseEventTypes.map(() => "?").join(", ");

export function wasQuestionSuperseded(
  sqlite: Database.Database,
  id: string,
  questionSeq: number,
): boolean {
  const response = sqlite
    .prepare(
      `SELECT 1
       FROM conversation_events AS instruction
       WHERE instruction.conversation_id = ? AND instruction.seq > ?
         AND instruction.type = 'user_message'
         AND json_extract(instruction.payload, '$.origin') <> 'answer_text'
         AND (
           SELECT next.type
           FROM conversation_events AS next
           WHERE next.conversation_id = instruction.conversation_id AND next.seq > instruction.seq
             AND next.type IN (${responseTypes}, 'user_message', 'turn_end', 'stopped')
           ORDER BY next.seq
           LIMIT 1
         ) IN (${responseTypes})
       LIMIT 1`,
    )
    .get(id, questionSeq, ...assistantResponseEventTypes, ...assistantResponseEventTypes);
  return response !== undefined;
}

export function hasQuestionBefore(
  sqlite: Database.Database,
  id: string,
  beforeSeq: number,
): boolean {
  return (
    sqlite
      .prepare(
        "SELECT 1 FROM conversation_events WHERE conversation_id=? AND seq<? AND type='question' LIMIT 1",
      )
      .get(id, beforeSeq) !== undefined
  );
}
