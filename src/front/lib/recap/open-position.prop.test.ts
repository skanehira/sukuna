import { test, fc } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { openPosition } from "./open-position";

test.prop([fc.array(fc.boolean(), { minLength: 1, maxLength: 50 }), fc.nat(50)])(
  "未読の先頭と最後の自分の発言を、任意の会話の並びで選ぶ",
  (users, read) => {
    const events = users.map((user, index) => ({
      seq: index + 1,
      type: user ? "user_message" : "assistant_text",
    }));
    const result = openPosition(events, read, false);
    const unread = users
      .map((user, index) => (!user && index + 1 > read ? index + 1 : null))
      .filter((seq) => seq !== null);
    const lastUser = users.lastIndexOf(true) + 1;
    expect(result).toEqual({
      seq: unread[0] ?? (lastUser || users.length),
      unreadSeq: unread[0] ?? null,
      recent: unread.length > 0,
      tail: unread.length === 0 && lastUser === 0,
    });
    expect(openPosition(events, read, true)).toEqual({
      seq: users.length,
      unreadSeq: unread[0] ?? null,
      recent: unread.length > 0,
      tail: true,
    });
  },
);
