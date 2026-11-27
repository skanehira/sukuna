import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import Database from "better-sqlite3";
import { openDatabase } from "./open";
import { acquireLock, startDatabase } from "./startup";
import { createTempHome, removeTempHome, tableNames } from "./test-helpers";

type FakeClock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  sleeps: () => number;
};

function fakeClock(): FakeClock {
  let current = 0;
  let sleeps = 0;
  return {
    now: () => current,
    sleep: async (ms) => {
      sleeps += 1;
      current += ms;
    },
    sleeps: () => sleeps,
  };
}

function spawnLiveProcess(): { pid: number; kill: () => Promise<void> } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) throw new Error("子プロセスを起動できませんでした");
  return {
    pid,
    kill: async () => {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    },
  };
}

describe("データベースのロック", () => {
  it("排他の作成直後に落ちて PID が空なら、OS の排他の中で回収して取る", async () => {
    const home = createTempHome();
    const lockPath = join(home, "db.lock");
    writeFileSync(lockPath, "", { flag: "wx" });
    const clock = fakeClock();

    try {
      const result = await acquireLock({
        lockPath,
        pid: 4242,
        timeoutMs: 1000,
        now: clock.now,
        sleep: clock.sleep,
      });

      expect(result.isOk()).toBe(true);
      if (!result.isOk()) throw new Error("空のロックを回収できませんでした");
      expect(clock.sleeps()).toBe(0);
      expect(readFileSync(lockPath, "utf8")).toBe("4242");
      result.value.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      removeTempHome(home);
    }
  });

  it("古いロック回収中の所有者交代でも、生存中の新しい持ち主を待つ", async () => {
    const home = createTempHome();
    const lockPath = join(home, "db.lock");
    writeFileSync(lockPath, "99999999");
    const clock = fakeClock();
    let switched = false;

    try {
      const result = await acquireLock({
        lockPath,
        pid: 4242,
        timeoutMs: 1000,
        now: clock.now,
        sleep: clock.sleep,
        isProcessAlive: (holder) => {
          if (!switched && holder === 99999999) {
            switched = true;
            rmSync(lockPath);
            writeFileSync(lockPath, String(process.pid), { flag: "wx" });
            return false;
          }
          return holder === process.pid;
        },
      });

      expect(result.isErr()).toBe(true);
      if (!result.isErr()) throw new Error("生存中のロックを取得できてしまいました");
      expect(result.error).toEqual({
        type: "lock_timeout",
        message: "データベースのロックを 1 秒待っても取れませんでした",
      });
      expect(clock.sleeps()).toBe(2);
      expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    } finally {
      removeTempHome(home);
    }
  });

  it("別の取得処理が OS の排他を持つあいだは、db.lock の新規作成を待つ", async () => {
    const home = createTempHome();
    const lockPath = join(home, "db.lock");
    const guard = new Database(`${lockPath}.guard`, { timeout: 0 });
    guard.exec("BEGIN IMMEDIATE");
    const clock = fakeClock();

    try {
      const result = await acquireLock({
        lockPath,
        pid: 4242,
        now: clock.now,
        sleep: async (ms) => {
          await clock.sleep(ms);
          guard.close();
        },
      });

      expect(result.isOk()).toBe(true);
      if (!result.isOk()) throw new Error("ロックを取れませんでした");
      expect(clock.sleeps()).toBe(1);
      expect(readFileSync(lockPath, "utf8")).toBe("4242");
      result.value.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      if (guard.open) guard.close();
      removeTempHome(home);
    }
  });

  it("古い PID を回収しているあいだは、別の取得処理に OS の排他を渡さない", async () => {
    const home = createTempHome();
    const lockPath = join(home, "db.lock");
    const contender = new Database(`${lockPath}.guard`, { timeout: 0 });
    writeFileSync(lockPath, "99999999");
    let contenderResult = "not-run";

    try {
      const result = await acquireLock({
        lockPath,
        pid: 4242,
        isProcessAlive: () => {
          try {
            contender.exec("BEGIN IMMEDIATE");
            contenderResult = "acquired";
            contender.exec("ROLLBACK");
          } catch (error) {
            if (!(error instanceof Database.SqliteError)) throw error;
            contenderResult = error.code;
          }
          return false;
        },
      });

      expect(result.isOk()).toBe(true);
      if (!result.isOk()) throw new Error("ロックを取れませんでした");
      expect(contenderResult).toBe("SQLITE_BUSY");
      expect(readFileSync(lockPath, "utf8")).toBe("4242");
      result.value.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      contender.close();
      removeTempHome(home);
    }
  });

  it("OS の排他を持つプロセスが強制終了すると、補助ファイルが残っていてもロックを取れる", async () => {
    const home = createTempHome();
    const lockPath = join(home, "db.lock");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      const Database = require("better-sqlite3");
      const database = new Database(process.argv[1], { timeout: 0 });
      database.exec("BEGIN IMMEDIATE");
      process.send("locked");
      setInterval(() => {}, 60_000);
    `,
        `${lockPath}.guard`,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const pid = child.pid;
    if (pid === undefined) throw new Error("ロックの持ち主を起動できませんでした");
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("排他の取得を確認できませんでした")), 5000);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("排他の取得前に終了しました"));
        });
        child.once("message", (message) => {
          clearTimeout(timer);
          if (message === "locked") resolve();
          else reject(new Error("排他の取得結果が違います"));
        });
      });
      writeFileSync(lockPath, String(pid));
      const clock = fakeClock();

      const result = await acquireLock({
        lockPath,
        pid: 4242,
        now: clock.now,
        sleep: async (ms) => {
          await clock.sleep(ms);
          child.kill("SIGKILL");
          await exited;
        },
      });

      expect(result.isOk()).toBe(true);
      if (!result.isOk()) throw new Error("ロックを取れませんでした");
      expect(clock.sleeps()).toBe(1);
      expect(readFileSync(lockPath, "utf8")).toBe("4242");
      expect(existsSync(`${lockPath}.guard`)).toBe(true);
      result.value.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      removeTempHome(home);
    }
  });

  it("別の生きているプロセスがロックを持っているあいだは待ち、外れると取って進む", async () => {
    const home = createTempHome();
    const lockPath = join(home, "db.lock");
    const holder = spawnLiveProcess();
    writeFileSync(lockPath, String(holder.pid));

    try {
      const clock = fakeClock();
      const sleep = async (ms: number): Promise<void> => {
        await clock.sleep(ms);
        if (clock.sleeps() === 1) rmSync(lockPath);
      };

      const result = await acquireLock({
        lockPath,
        pid: 4242,
        now: clock.now,
        sleep,
      });

      expect(result.isOk()).toBe(true);
      if (!result.isOk()) throw new Error("ロックを取れませんでした");
      expect(clock.sleeps()).toBe(1);
      expect(readFileSync(lockPath, "utf8")).toBe("4242");
      result.value.release();
    } finally {
      await holder.kill();
      removeTempHome(home);
    }
  });

  it("持ち主の PID が死んでいれば、ロックを消して取る", async () => {
    const home = createTempHome();
    const lockPath = join(home, "db.lock");
    const exited = spawnSync(process.execPath, ["-e", ""]);
    const deadPid = exited.pid;
    if (deadPid === undefined) throw new Error("子プロセスを起動できませんでした");
    writeFileSync(lockPath, String(deadPid));

    try {
      const clock = fakeClock();

      const result = await acquireLock({
        lockPath,
        pid: 4242,
        now: clock.now,
        sleep: clock.sleep,
      });

      expect(result.isOk()).toBe(true);
      if (!result.isOk()) throw new Error("ロックを取れませんでした");
      expect(clock.sleeps()).toBe(0);
      expect(readFileSync(lockPath, "utf8")).toBe("4242");
      result.value.release();
    } finally {
      removeTempHome(home);
    }
  });

  it("ロックのファイルを作れなければ、失敗を返す", async () => {
    const home = createTempHome();

    try {
      const result = await acquireLock({ lockPath: join(home, "missing", "db.lock"), pid: 4242 });

      expect(result.isErr()).toBe(true);
      if (!result.isErr()) throw new Error("ロックを取れてしまいました");
      expect(result.error.type).toBe("lock_failed");
    } finally {
      removeTempHome(home);
    }
  });

  it("ロックを持っているあいだにファイルの持ち主が変わったら、外すときに消さない", async () => {
    const home = createTempHome();
    const lockPath = join(home, "db.lock");

    try {
      const result = await acquireLock({ lockPath, pid: 4242 });
      expect(result.isOk()).toBe(true);
      if (!result.isOk()) throw new Error("ロックを取れませんでした");
      writeFileSync(lockPath, "9999");

      result.value.release();

      expect(readFileSync(lockPath, "utf8")).toBe("9999");
    } finally {
      removeTempHome(home);
    }
  });

  it("60 秒たっても取れなければ失敗を返す", async () => {
    const home = createTempHome();
    const lockPath = join(home, "db.lock");
    writeFileSync(lockPath, String(process.pid));

    try {
      const clock = fakeClock();

      const result = await acquireLock({
        lockPath,
        pid: 4242,
        timeoutMs: 60_000,
        intervalMs: 500,
        now: clock.now,
        sleep: clock.sleep,
      });

      expect(result.isErr()).toBe(true);
      if (!result.isErr()) throw new Error("ロックを取れてしまいました");
      expect(result.error).toEqual({
        type: "lock_timeout",
        message: "データベースのロックを 60 秒待っても取れませんでした",
      });
      expect(clock.sleeps()).toBe(120);
      expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    } finally {
      removeTempHome(home);
    }
  });
});

describe("起動の処理", () => {
  it("空のデータの置き場所で起動すると、データベースができて全テーブルがそろい、ロックが残らない", async () => {
    const home = createTempHome();

    try {
      const result = await startDatabase({ homeDir: home });

      expect(result.isOk()).toBe(true);
      if (!result.isOk()) throw new Error("起動に失敗しました");
      const opened = result.value;
      try {
        expect(tableNames(opened.sqlite)).toHaveLength(17);
        expect(existsSync(join(home, "sukuna.db"))).toBe(true);
        expect(existsSync(join(home, "db.lock"))).toBe(false);
      } finally {
        opened.close();
      }
    } finally {
      removeTempHome(home);
    }
  });

  it("わざと失敗するマイグレーションを当てると、起動の処理が失敗を返し、ロックが残らない", async () => {
    const home = createTempHome();
    const broken = [
      {
        tag: "0000_broken",
        when: 1,
        statements: ["CREATE TABLE broken (id text)", "CREATE TABLE broken (id text)"],
        hash: "broken",
      },
    ];

    try {
      const result = await startDatabase({ homeDir: home, migrations: broken });

      expect(result.isErr()).toBe(true);
      if (!result.isErr()) throw new Error("起動に成功してしまいました");
      expect(result.error.type).toBe("migration_failed");
      expect(existsSync(join(home, "db.lock"))).toBe(false);

      const opened = openDatabase(home);
      try {
        expect(tableNames(opened.sqlite)).toEqual([]);
      } finally {
        opened.close();
      }
    } finally {
      removeTempHome(home);
    }
  });

  it("データの置き場所を作れなければ、起動の処理は失敗を返す", async () => {
    const home = createTempHome();
    const filePath = join(home, "not-a-directory");
    writeFileSync(filePath, "");

    try {
      const result = await startDatabase({ homeDir: join(filePath, "data") });

      expect(result.isErr()).toBe(true);
      if (!result.isErr()) throw new Error("起動に成功してしまいました");
      expect(result.error.type).toBe("open_failed");
    } finally {
      removeTempHome(home);
    }
  });

  it("データベースを開けなければ、起動の処理は失敗を返し、ロックが残らない", async () => {
    const home = createTempHome();
    mkdirSync(join(home, "sukuna.db"));

    try {
      const result = await startDatabase({ homeDir: home });

      expect(result.isErr()).toBe(true);
      if (!result.isErr()) throw new Error("起動に成功してしまいました");
      expect(result.error.type).toBe("open_failed");
      expect(existsSync(join(home, "db.lock"))).toBe(false);
    } finally {
      removeTempHome(home);
    }
  });

  it("ほかのプロセスがロックを持ったままなら、起動の処理は失敗を返し、データベースを作らない", async () => {
    const home = createTempHome();
    writeFileSync(join(home, "db.lock"), String(process.pid));
    const clock = fakeClock();

    try {
      const result = await startDatabase({
        homeDir: home,
        lock: { timeoutMs: 60_000, intervalMs: 500, now: clock.now, sleep: clock.sleep },
      });

      expect(result.isErr()).toBe(true);
      if (!result.isErr()) throw new Error("起動に成功してしまいました");
      expect(result.error.type).toBe("lock_timeout");
      expect(existsSync(join(home, "sukuna.db"))).toBe(false);
      expect(existsSync(join(home, "db.lock"))).toBe(true);
    } finally {
      removeTempHome(home);
    }
  });
});
