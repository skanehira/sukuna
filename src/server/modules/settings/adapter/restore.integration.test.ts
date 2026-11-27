import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { existsSync, mkdirSync, readdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
} from "../../../../shared/db/test-helpers";
import { startDatabase } from "../../../../shared/db/startup";
import { createRestoreFiles } from "./restore-files";
import { launchdReadiness } from "./launchd-readiness";
import { createSettingsDependencies } from "./dependencies";
import { createSettingsRoutes } from "./routes";
import { runRestore } from "../usecase/run-restore";
import type { RemovedService } from "../domain/launchd-port";
import { rotateLog } from "../../../../shared/log/rotate";

const at = new Date(2026, 10, 28, 10, 15).getTime();
const backupPath = (home: string) => join(home, "backups", "sukuna-2026-11-25.db");

function setValue(db: ReturnType<typeof openMigratedDatabase>["sqlite"], value: string) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sample', ?)").run(
    JSON.stringify(value),
  );
}
function values(db: ReturnType<typeof openMigratedDatabase>["sqlite"]) {
  return Object.fromEntries(
    db
      .prepare("SELECT key, value FROM settings")
      .all()
      .map((row) => {
        const { key, value } = row as { key: string; value: string };
        return [key, JSON.parse(value)];
      }),
  );
}

it.each([false, true])(
  "復元がSQLiteを検査した結果だけを採用する (壊れた写し=%s)",
  async (corrupt) => {
    const home = createTempHome();
    const database = openMigratedDatabase(home);
    const files = createRestoreFiles(home);
    const trace: string[] = [];
    const services = {
      stop: async (service: string, removed?: (receipt: RemovedService) => void) => {
        trace.push(`stop ${service}`);
        removed?.({ waitForExit: async () => {} });
      },
      bootstrap: async (service: string) => {
        trace.push(`start ${service}`);
      },
    };
    try {
      mkdirSync(join(home, "backups"));
      setValue(database.sqlite, "before");
      if (corrupt) writeFileSync(backupPath(home), "invalid backup");
      else await database.sqlite.backup(backupPath(home));
      setValue(database.sqlite, "current");
      database.close();
      files.createRequest({ backupId: "2026-11-25", requestedAt: at });
      const result = await runRestore({
        ready: async () => [],
        files,
        services,
        now: () => at,
        sleep: async (ms) => {
          trace.push(`sleep ${ms}`);
        },
      });
      expect(trace).toEqual([
        "sleep 2000",
        "stop runner",
        "stop server",
        "start runner",
        "start server",
      ]);
      const opened = openMigratedDatabase(home);
      try {
        expect(values(opened.sqlite)).toMatchObject(
          corrupt
            ? {
                sample: "current",
                last_restore: {
                  backupId: "2026-11-25",
                  at,
                  status: "failed",
                  message: expect.any(String),
                },
              }
            : {
                sample: "before",
                flow_paused: true,
                last_restore: { backupId: "2026-11-25", at, status: "done", message: null },
              },
        );
        expect(result.status).toBe(corrupt ? "failed" : "done");
        expect(existsSync(join(home, "restore.json"))).toBe(false);
        expect(readdirSync(join(home, "backups")).sort()).toEqual([
          "before-restore-20261128-101500.db",
          "sukuna-2026-11-25.db",
        ]);
      } finally {
        opened.close();
      }
    } finally {
      if (database.sqlite.open) database.close();
      removeTempHome(home);
    }
  },
);

it("途中で止まった復元を起動時に記録して依頼を取り除く", async () => {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  database.close();
  try {
    writeFileSync(
      join(home, "restore.json"),
      JSON.stringify({ backupId: "2026-11-25", requestedAt: at }),
    );
    const result = (
      await startDatabase({ homeDir: home, lock: { now: () => at + 1 } })
    )._unsafeUnwrap();
    try {
      expect(values(result.sqlite).last_restore).toEqual({
        backupId: "2026-11-25",
        at: at + 1,
        status: "failed",
        message: "復元の途中で止まりました",
      });
      expect(existsSync(join(home, "restore.json"))).toBe(false);
    } finally {
      result.close();
    }
  } finally {
    removeTempHome(home);
  }
});

it("復元の公開APIが登録なし・対象なし・二重依頼を区別する", async () => {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  const kickstart = vi.fn(async () => {});
  let registered = false;
  try {
    mkdirSync(join(home, "backups"));
    const deps = createSettingsDependencies(
      () => database.db,
      home,
      () => {},
      {
        launchd: { registered: async () => registered, kickstart },
        now: () => at,
      },
    );
    const app = createSettingsRoutes(deps);
    const post = (backupId: string) =>
      app.request("/backup/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backupId }),
      });
    expect((await post("2026-11-25")).status).toBe(404);
    await database.sqlite.backup(backupPath(home));
    const missing = await post("2026-11-25");
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({
      error: { code: "conflict", message: expect.stringContaining("導入のコマンド") },
    });
    expect(existsSync(join(home, "restore.json"))).toBe(false);
    registered = true;
    const [response, duplicate] = await Promise.all([post("2026-11-25"), post("2026-11-25")]);
    expect([response.status, duplicate.status]).toEqual([202, 409]);
    const accepted = (await response.json()) as { requestId: string };
    expect(accepted).toEqual({ restarting: true, requestId: expect.any(String) });
    expect(await (await app.request(`/backup/restore/${accepted.requestId}`)).json()).toEqual({
      status: "pending",
    });
    expect(kickstart).toHaveBeenCalledExactlyOnceWith("restore");
  } finally {
    database.close();
    removeTempHome(home);
  }
});

it("外部処理が停止を待つ間に起動し直しても一つの復元を追跡する", async () => {
  const home = createTempHome();
  const first = openMigratedDatabase(home);
  const files = createRestoreFiles(home);
  const wait = () => {
    let resolve = () => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { resolve, promise };
  };
  const reached = wait();
  const resume = wait();
  const kickstart = vi.fn(async () => {});
  let database = first;
  try {
    mkdirSync(join(home, "backups"));
    setValue(database.sqlite, "restored");
    await database.sqlite.backup(backupPath(home));
    setValue(database.sqlite, "current");
    const deps = createSettingsDependencies(
      () => database.db,
      home,
      () => {},
      {
        launchd: { registered: async () => true, kickstart },
        now: () => at,
      },
    );
    const app = createSettingsRoutes(deps);
    const post = () =>
      app.request("/backup/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backupId: "2026-11-25" }),
      });
    const accepted = (await (await post()).json()) as { requestId?: string };
    const pending = runRestore({
      files,
      ready: async () => [],
      now: () => at,
      sleep: async () => {},
      services: {
        stop: async (service) => {
          if (service === "runner") {
            reached.resolve();
            await resume.promise;
          }
          if (service === "server") database.close();
        },
        bootstrap: async () => {},
      },
    });
    await reached.promise;
    let duplicate: number;
    try {
      database.close();
      database = (await startDatabase({ homeDir: home }))._unsafeUnwrap();
      duplicate = (await post()).status;
    } finally {
      resume.resolve();
      await pending;
    }
    database = openMigratedDatabase(home);
    expect(duplicate).toBe(409);
    expect(kickstart).toHaveBeenCalledTimes(1);
    expect(accepted.requestId).toEqual(expect.any(String));
    expect(await (await app.request(`/backup/restore/${accepted.requestId}`)).json()).toMatchObject(
      { status: "done", backupId: "2026-11-25" },
    );
    expect(values(database.sqlite).sample).toBe("restored");
  } finally {
    if (database.sqlite.open) database.close();
    removeTempHome(home);
  }
});

it("ログ整理に失敗してもSQLiteを復元し、依頼したIDに結果を返す", async () => {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  const files = createRestoreFiles(home);
  const requestId = "11111111-1111-4111-8111-111111111111";
  const warning = vi.fn();
  try {
    mkdirSync(join(home, "backups"));
    mkdirSync(join(home, "logs"));
    const log = join(home, "logs", "restore.log");
    writeFileSync(log, "");
    truncateSync(log, 100_000_001);
    mkdirSync(log + ".1");
    setValue(database.sqlite, "saved");
    await database.sqlite.backup(backupPath(home));
    setValue(database.sqlite, "current");
    database.close();
    files.createRequest({ backupId: "2026-11-25", requestedAt: at, requestId });
    const result = await runRestore({
      ready: async () => [],
      files,
      rotate: () => rotateLog(log),
      warning,
      now: () => at,
      sleep: async () => {},
      services: { stop: async () => {}, bootstrap: async () => {} },
    });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("done");
    expect(files.lookup(requestId)).toEqual(result);
    const reopened = openMigratedDatabase(home);
    try {
      expect(values(reopened.sqlite).sample).toBe("saved");
    } finally {
      reopened.close();
    }
  } finally {
    if (database.sqlite.open) database.close();
    removeTempHome(home);
  }
});

it("停止に失敗しても接続中のHTTPから同じ依頼の結果を読める", async () => {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  const files = createRestoreFiles(home);
  try {
    mkdirSync(join(home, "backups"));
    await database.sqlite.backup(backupPath(home));
    const app = createSettingsRoutes(
      createSettingsDependencies(
        () => database.db,
        home,
        () => {},
        {
          launchd: { registered: async () => true, kickstart: async () => {} },
          now: () => at,
        },
      ),
    );
    const post = () =>
      app.request("/backup/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backupId: "2026-11-25" }),
      });
    const accepted = (await (await post()).json()) as { requestId: string };
    await runRestore({
      ready: async () => [],
      files,
      now: () => at,
      sleep: async () => {},
      services: {
        stop: async () => {
          throw new Error("ランナーを停止できませんでした。");
        },
        bootstrap: async () => {},
      },
    });
    const lookup = await app.request(`/backup/restore/${accepted.requestId}`);
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toEqual({
      requestId: accepted.requestId,
      at,
      backupId: "2026-11-25",
      status: "failed",
      message: "ランナーを停止できませんでした。",
    });
    const another = (await (await post()).json()) as { requestId: string };
    expect(another.requestId).not.toBe(accepted.requestId);
    expect(await (await app.request(`/backup/restore/${another.requestId}`)).json()).toEqual({
      status: "pending",
    });
    expect((await app.request(`/backup/restore/${accepted.requestId}`)).status).toBe(200);
    expect(database.sqlite.open).toBe(true);
    expect((await app.request("/backup/restore/22222222-2222-4222-8222-222222222222")).status).toBe(
      404,
    );
  } finally {
    database.close();
    removeTempHome(home);
  }
});

it("補助の結果ファイルを置き換えられなくても停止失敗を照会し次の依頼を受けられる", async () => {
  const home = createTempHome();
  const db = openMigratedDatabase(home);
  const files = createRestoreFiles(home);
  try {
    mkdirSync(join(home, "backups"));
    await db.sqlite.backup(backupPath(home));
    mkdirSync(join(home, "restore-result.json"));
    const app = createSettingsRoutes(
      createSettingsDependencies(
        () => db.db,
        home,
        () => {},
        {
          launchd: { registered: async () => true, kickstart: async () => {} },
          now: () => at,
        },
      ),
    );
    const post = () =>
      app.request("/backup/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backupId: "2026-11-25" }),
      });
    const accepted = (await (await post()).json()) as { requestId: string };
    await runRestore({
      files,
      now: () => at,
      sleep: async () => {},
      ready: async () => [],
      services: {
        stop: async () => {
          throw new Error("ランナーを停止できませんでした。");
        },
        bootstrap: async () => {},
      },
    });
    expect(await (await app.request(`/backup/restore/${accepted.requestId}`)).json()).toEqual({
      requestId: accepted.requestId,
      at,
      backupId: "2026-11-25",
      status: "failed",
      message: "ランナーを停止できませんでした。",
    });
    const second = await post();
    expect(second.status).toBe(202);
    const another = (await second.json()) as { requestId: string };
    expect(await (await app.request(`/backup/restore/${another.requestId}`)).json()).toEqual({
      status: "pending",
    });
  } finally {
    db.close();
    removeTempHome(home);
  }
});

it("中断からの起動は、補助結果を読めなくても同じ受付の失敗を維持して後始末する", async () => {
  const home = createTempHome();
  const db = openMigratedDatabase(home);
  const requestId = "11111111-1111-4111-8111-111111111111";
  const outcome = {
    requestId,
    at,
    backupId: "2026-11-25",
    status: "failed",
    message: "ランナーを停止できませんでした。",
  };
  try {
    db.sqlite
      .prepare("INSERT INTO settings (key,value) VALUES ('last_restore',?)")
      .run(JSON.stringify(outcome));
    db.close();
    mkdirSync(join(home, "restore-result.json"));
    createRestoreFiles(home).createRequest({ requestId, backupId: "2026-11-25", requestedAt: at });
    const reopened = (await startDatabase({ homeDir: home }))._unsafeUnwrap();
    try {
      expect(values(reopened.sqlite).last_restore).toEqual(outcome);
      expect(existsSync(join(home, "restore.json"))).toBe(false);
    } finally {
      reopened.close();
    }
  } finally {
    if (db.sqlite.open) db.close();
    removeTempHome(home);
  }
});

it.each([null, "server", "runner"] as const)(
  "サービスの起動確認後だけ完了となる (起動失敗=%s)",
  async (missing) => {
    const home = createTempHome();
    const db = openMigratedDatabase(home);
    const files = createRestoreFiles(home);
    const requestId = "11111111-1111-4111-8111-111111111111";
    const started: string[] = [];
    const tcp = createServer((client) => client.end());
    const unix = createServer((client) => client.end());
    const socket = join(home, "runner.sock");
    const occupied = missing === "server" ? createServer() : tcp;
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    const port = (occupied.address() as AddressInfo).port;
    if (missing === "server") await new Promise<void>((resolve) => occupied.close(() => resolve()));
    if (missing !== "runner") {
      unix.listen(socket);
      await once(unix, "listening");
    }
    let elapsed = 0;
    const check = launchdReadiness({
      launchd: { pid: async (target) => (target === "server" ? 44 : 45) },
      port,
      socket,
      openFiles: async (args) => ({
        exitCode: 0,
        stdout: args.includes("-U") ? `p45\nn${socket}\n` : "p44\n",
        stderr: "",
      }),
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    });
    try {
      mkdirSync(join(home, "backups"));
      setValue(db.sqlite, "saved");
      await db.sqlite.backup(backupPath(home));
      setValue(db.sqlite, "current");
      db.close();
      files.createRequest({ requestId, backupId: "2026-11-25", requestedAt: at });
      const result = await runRestore({
        files,
        now: () => at,
        sleep: async () => {},
        ready: async (targets) => {
          expect(started.sort()).toEqual(["runner", "server"]);
          expect(targets).toEqual(["runner", "server"]);
          expect(files.lookup(requestId)).toEqual({ status: "pending" });
          const staged = openMigratedDatabase(home);
          try {
            expect(values(staged.sqlite)).toMatchObject({
              sample: "saved",
              flow_paused: true,
              last_restore: { status: "failed", requestId },
            });
          } finally {
            staged.close();
          }
          return check(targets);
        },
        services: {
          stop: async () => {},
          bootstrap: async (service) => {
            started.push(service);
          },
        },
      });
      if (missing === null) expect(result).toMatchObject({ status: "done", message: null });
      else {
        expect(result).toMatchObject({
          status: "failed",
          message: expect.stringMatching(
            new RegExp(`データベースを復元しました.*dev\\.sukuna\\.${missing}`),
          ),
        });
      }
      const reopened = openMigratedDatabase(home);
      try {
        expect(values(reopened.sqlite)).toMatchObject({
          sample: "saved",
          flow_paused: true,
          last_restore: result,
        });
      } finally {
        reopened.close();
      }
      expect(files.lookup(requestId)).toEqual(result);
    } finally {
      if (db.sqlite.open) db.close();
      await Promise.all(
        [tcp, unix].map(
          (listener) => new Promise<void>((resolve) => listener.close(() => resolve())),
        ),
      );
      removeTempHome(home);
    }
  },
);
