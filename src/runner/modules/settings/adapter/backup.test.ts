import { readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
} from "../../../../shared/db/test-helpers";
import { createBackupFiles } from "./backup-files";
import { startBackup } from "../usecase/backup";

const day = 24 * 60 * 60 * 1_000;

it("24時間を超えた写しを起動時に補い、毎日03:00の新しい七つを残す", async () => {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  const files = createBackupFiles(home, database.sqlite);
  let now = new Date(2026, 10, 20, 8).getTime();
  let callback: (() => void | Promise<void>) | undefined;
  let next = 0;
  const clock = {
    now: () => now,
    setTimeout: (task: () => void | Promise<void>, ms: number) => {
      callback = task;
      next = now + ms;
      return () => {
        callback = undefined;
      };
    },
  };
  await files.write("2026-11-18");
  utimesSync(
    join(home, "backups", "sukuna-2026-11-18.db"),
    new Date(now - 2 * day),
    new Date(now - 2 * day),
  );
  const runner = startBackup(files, clock);
  try {
    await runner.ready;
    expect(readdirSync(join(home, "backups")).sort()).toEqual([
      "sukuna-2026-11-18.db",
      "sukuna-2026-11-20.db",
    ]);
    expect(next).toBe(new Date(2026, 10, 21, 3).getTime());
    for (let count = 0; count < 8; count++) {
      now = next;
      await callback?.();
    }
    expect(readdirSync(join(home, "backups")).sort()).toEqual(
      Array.from({ length: 7 }, (_, index) => `sukuna-2026-11-${22 + index}.db`),
    );
    expect(
      database.sqlite.prepare("SELECT value FROM settings WHERE key='backup_status'").get(),
    ).toEqual({
      value: JSON.stringify({ lastAt: now, lastError: null }),
    });
  } finally {
    await runner.stop();
    database.close();
    removeTempHome(home);
  }
});

it.each([0, 100])("03:00ちょうどに起動した日も採取する (既存のmtime差 %d ms)", async (offset) => {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  const files = createBackupFiles(home, database.sqlite);
  const at = new Date(2026, 10, 21, 3).getTime();
  try {
    await files.write("2026-11-20");
    const yesterday = new Date(at - day + offset);
    utimesSync(join(home, "backups", "sukuna-2026-11-20.db"), yesterday, yesterday);
    const schedule = vi.fn(() => () => {});
    const task = startBackup(files, { now: () => at, setTimeout: schedule });
    await task.ready;
    await task.stop();
    expect(readdirSync(join(home, "backups")).sort()).toEqual([
      "sukuna-2026-11-20.db",
      "sukuna-2026-11-21.db",
    ]);
    expect(schedule).toHaveBeenCalledExactlyOnceWith(expect.any(Function), day);
  } finally {
    database.close();
    removeTempHome(home);
  }
});

it.each([
  [0, 1, true],
  [-1, 2, true],
  [-3, 1, false],
] as const)(
  "準備の間に到来した日次予定を記憶する (開始差 %dms・準備 %dms)",
  async (offset, preparation, completed) => {
    const home = createTempHome();
    const database = openMigratedDatabase(home);
    const files = createBackupFiles(home, database.sqlite);
    const at = new Date(2026, 10, 21, 3).getTime();
    let now = at + offset;
    try {
      await files.write("2026-11-20");
      const yesterday = new Date(at - day + 100);
      utimesSync(join(home, "backups", "sukuna-2026-11-20.db"), yesterday, yesterday);
      const schedule = vi.fn(() => () => {});
      const task = startBackup(
        {
          ...files,
          prepare() {
            files.prepare();
            now += preparation;
          },
        },
        { now: () => now, setTimeout: schedule },
      );
      await task.ready;
      await task.stop();
      expect(readdirSync(join(home, "backups")).sort()).toEqual(
        completed ? ["sukuna-2026-11-20.db", "sukuna-2026-11-21.db"] : ["sukuna-2026-11-20.db"],
      );
      expect(schedule).toHaveBeenCalledExactlyOnceWith(
        expect.any(Function),
        (completed ? at + day : at) - now,
      );
    } finally {
      database.close();
      removeTempHome(home);
    }
  },
);

it("最初のタイマーを登録する間に03:00を迎えても、その日の予定を実行する", async () => {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  const files = createBackupFiles(home, database.sqlite);
  const at = new Date(2026, 10, 21, 3).getTime();
  let now = at - 1;
  let callback: (() => void | Promise<void>) | undefined;
  const schedule = vi.fn((task: () => void | Promise<void>) => {
    callback = task;
    return () => {};
  });
  try {
    await files.write("2026-11-20");
    const yesterday = new Date(at - day + 100);
    utimesSync(join(home, "backups", "sukuna-2026-11-20.db"), yesterday, yesterday);
    const runner = startBackup(
      files,
      {
        now() {
          const observed = now;
          now = at;
          return observed;
        },
        setTimeout: schedule,
      },
      { startedAt: now },
    );
    try {
      await runner.ready;
      expect(schedule).toHaveBeenNthCalledWith(1, expect.any(Function), 0);
      await callback?.();
      expect(readdirSync(join(home, "backups")).sort()).toEqual([
        "sukuna-2026-11-20.db",
        "sukuna-2026-11-21.db",
      ]);
      expect(schedule).toHaveBeenNthCalledWith(2, expect.any(Function), day);
    } finally {
      await runner.stop();
    }
  } finally {
    database.close();
    removeTempHome(home);
  }
});
