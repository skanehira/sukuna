import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { startDatabase } from "../shared/db/startup";
import { readEnvironment } from "../shared/env";
import { createLogger } from "../shared/log";
import { startRunnerApp } from "./app";

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
const database = await startDatabase({ homeDir: environment.value.home });
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
const keepAlive = setInterval(() => {}, 60_000);
let stopping = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(keepAlive);
  const deadline = setTimeout(() => process.exit(1), 19_000);
  try {
    await runnerApp.shutdown();
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
