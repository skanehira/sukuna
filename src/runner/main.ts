import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { rotateLog } from "../shared/log/rotate";
import { createBackupFiles } from "./modules/settings/adapter/backup-files";
import { startBackup } from "./modules/settings/usecase/backup";
import { systemClock } from "./modules/conversation/adapter/system-clock";
import { startDatabase } from "../shared/db/startup";
import { readEnvironment } from "../shared/env";
import { createLogger } from "../shared/log";
import { startRunnerApp } from "./app";

const startedAt = systemClock.now();
const environment = readEnvironment("runner", process.env, homedir(), (path) => {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
});
const log = createLogger({
  now: () => Date.now(),
  write: (line) => console.log(line),
  level: environment.isOk() ? environment.value.logLevel : "info",
});
if (environment.isErr()) {
  log({ level: "error", component: "runner", message: environment.error.message });
  process.exit(1);
}
try {
  rotateLog(join(environment.value.directories.state, "logs", "runner.log"));
} catch (error) {
  log({ level: "warn", component: "runner", message: "ログを整理できませんでした。", error });
}
const database = await startDatabase({
  directories: environment.value.directories,
  restoreReceiptWarning: (error) =>
    log({
      level: "warn",
      component: "runner.restore",
      message: "補助の復元結果ファイルを処理できませんでした。",
      error,
    }),
});
if (database.isErr()) {
  log({ level: "error", component: "db.migrate", message: database.error.message });
  process.exit(1);
}

const openedDatabase = database.value;
export const runnerApp = await startRunnerApp({
  database: database.value,
  environment: environment.value,
  log,
}).catch((error: unknown) => {
  log({ level: "error", component: "runner", message: "ランナーを起動できませんでした。", error });
  openedDatabase.close();
  process.exit(1);
});
const backup = startBackup(
  createBackupFiles(environment.value.directories.data, openedDatabase.sqlite),
  systemClock,
  {
    startedAt,
    failure: (error) =>
      log({
        level: "warn",
        component: "runner.backup",
        message: "バックアップを保存できませんでした。",
        error,
      }),
  },
);
const keepAlive = setInterval(() => {}, 60_000);
let stopping = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(keepAlive);
  const deadline = setTimeout(() => process.exit(1), 19_000);
  try {
    await Promise.all([runnerApp.shutdown(), backup.stop()]);
    openedDatabase.close();
    log({ level: "info", component: "runner", message: `received ${signal}` });
    clearTimeout(deadline);
    process.exit(0);
  } catch (error) {
    log({ level: "error", component: "runner", message: "ランナーの終了に失敗しました。", error });
    process.exit(1);
  }
}
process.once("SIGTERM", (signal) => void shutdown(signal));
process.once("SIGINT", (signal) => void shutdown(signal));
log({
  level: "info",
  component: "runner",
  message: "started",
});
