import Database from "better-sqlite3";
import { expect, it } from "vite-plus/test";
import type { NotificationRecord } from "../domain/notification";
import { inboxFixture } from "../test-support";
import { createNotificationRepository } from "./notification-repository";

const f = inboxFixture();
const record = (id: string): NotificationRecord => ({
  id,
  targetKind: "conversation",
  targetId: "chat",
  reason: "question",
  title: "親の会話",
  body: "どちらですか",
  createdAt: 100,
  dismissedAt: null,
});

it("同じ時刻の通知を別の接続から登録すると、識別子に関係なく保存順の番号を返す", () => {
  const first = createNotificationRepository(f.sqlite);
  const firstSequence = first.transaction(() => first.insertOnce(record("z-old"), null));

  const second = new Database(f.sqlite.name, { fileMustExist: true });
  try {
    const next = createNotificationRepository(second);
    const secondSequence = next.transaction(() => next.insertOnce(record("a-new"), null));
    expect([firstSequence, secondSequence]).toEqual([1, 2]);
  } finally {
    second.close();
  }
});

it("登録全体が取り消されたときは通知だけでなく発行番号も元に戻る", () => {
  const repository = createNotificationRepository(f.sqlite);
  expect(() =>
    repository.transaction(() => {
      expect(repository.insertOnce(record("aborted"), null)).toBe(1);
      throw new Error("通知の登録を中止");
    }),
  ).toThrow("通知の登録を中止");
  const confirmed = repository.transaction(() => repository.insertOnce(record("confirmed"), null));
  expect(confirmed).toBe(1);
  expect(f.sqlite.prepare("SELECT id FROM notifications").all()).toEqual([{ id: "confirmed" }]);
});
