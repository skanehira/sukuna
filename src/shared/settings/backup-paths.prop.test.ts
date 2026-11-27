import { fc, it } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { backupDay, backupFileId, backupFileName, beforeRestoreName } from "./backup-paths";

it.prop([fc.date({ min: new Date(2020, 0, 1), max: new Date(2099, 11, 31), noInvalidDate: true })])(
  "日ごとと復元直前の名前を同じバックアップIDへ戻す",
  (date) => {
    const daily = `sukuna-${backupDay(date)}.db`;
    const before = beforeRestoreName(date);
    expect(backupFileId(daily)?.kind).toBe("daily");
    expect(backupFileId(before)?.kind).toBe("before_restore");
    expect(backupFileName(backupFileId(daily)!.id)).toBe(daily);
    expect(backupFileName(backupFileId(before)!.id)).toBe(before);
  },
);

it.prop([fc.string()])("ファイル名を作れるIDはバックアップ自身を指す単一の名前になる", (id) => {
  const file = backupFileName(id);
  if (file !== undefined) {
    expect(backupFileId(file)?.id).toBe(id);
    expect(file).not.toMatch(/[\\/]/);
  }
});
