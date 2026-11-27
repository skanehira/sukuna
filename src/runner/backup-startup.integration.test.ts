import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import { acquireLock } from "../shared/db/startup";
import { createTempHome, openMigratedDatabase, removeTempHome } from "../shared/db/test-helpers";

const childCode = `
  import { createServer } from "vite";
  import Database from "better-sqlite3";
  import { join } from "node:path";
  let at = Number(process.argv[1]);
  Date.now = () => at;
  process.once("message", (next) => {
    at = next;
    process.send({ kind: "clock", at });
  });
  const lockPath = join(process.env.SUKUNA_HOME, "db.lock.guard");
  const exec = Database.prototype.exec;
  let waiting = false;
  Database.prototype.exec = function(sql) {
    try {
      return exec.call(this, sql);
    } catch (error) {
      if (!waiting && error.code === "SQLITE_BUSY" && this.name === lockPath) {
        waiting = true;
        process.send({ kind: "waiting", at });
      }
      throw error;
    }
  };
  const server = await createServer({
    configFile: false,
    cacheDir: join(process.env.SUKUNA_HOME, "vite-cache"),
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { entries: [] },
  });
  await server.ssrLoadModule("/src/runner/main.ts");
  process.send({ kind: "ready" });
`;

it.each([
  { case: "03:00の直前に開始", start: -2, open: 1, saved: false, expected: true },
  { case: "03:00に開始", start: 0, open: 1, saved: false, expected: true },
  { case: "03:00の前に開く", start: -4_000, open: -3_000, saved: false, expected: false },
  { case: "03:00の分は保存済み", start: 0, open: 2, saved: true, expected: false },
])(
  "ランナーのDBロック待ちを含めて日次バックアップを判定する ($case)",
  async ({ start, open, saved, expected }) => {
    const home = createTempHome();
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const at = new Date(2026, 10, 21, 3).getTime();
    const yesterday = "sukuna-2026-11-20.db";
    const today = "sukuna-2026-11-21.db";
    const existing = join(home, "backups", saved ? today : yesterday);
    const database = openMigratedDatabase(home);
    mkdirSync(join(home, "backups"));
    await database.sqlite.backup(existing);
    database.close();
    const mtime = new Date(saved ? at + 1 : at - 86_400_000 + 100);
    utimesSync(existing, mtime, mtime);
    const lock = (await acquireLock({ lockPath: join(home, "db.lock") }))._unsafeUnwrap();
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", childCode, String(at + start)],
      {
        cwd: root,
        env: {
          ...process.env,
          HOME: home,
          NODE_ENV: "development",
          SUKUNA_HOME: home,
          SUKUNA_RUNNER_SOCKET: join(home, "runner.sock"),
          SUKUNA_AGENT: "fake",
          SUKUNA_AGENT_SCRIPT: join(root, "e2e", "agent-scripts", "conversation.json"),
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = once(child, "exit");
    const next = () =>
      Promise.race([
        once(child, "message").then(([message]) => message),
        exited.then(([code]) => {
          throw new Error(`ランナーが終了しました: ${code}\n${stderr}`);
        }),
      ]);
    try {
      expect(await next()).toEqual({ kind: "waiting", at: at + start });
      const clockSet = next();
      child.send(at + open);
      expect(await clockSet).toEqual({ kind: "clock", at: at + open });
      const ready = next();
      lock.release();
      expect(await ready).toEqual({ kind: "ready" });
      child.kill("SIGTERM");
      expect(await exited).toEqual([0, null]);

      expect(readdirSync(join(home, "backups")).sort()).toEqual(
        saved ? [today] : expected ? [yesterday, today] : [yesterday],
      );
      const verified = openMigratedDatabase(home);
      try {
        const result = verified.sqlite
          .prepare("SELECT value FROM settings WHERE key = 'backup_status'")
          .get();
        expect(result).toEqual(
          expected ? { value: JSON.stringify({ lastAt: at + open, lastError: null }) } : undefined,
        );
      } finally {
        verified.close();
      }
    } finally {
      lock.release();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
      removeTempHome(home);
    }
  },
  15_000,
);
