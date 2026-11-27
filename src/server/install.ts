import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createTailscaleLocalApi } from "./modules/identity/adapter/tailscale-local-api";
import { launchdEnvironment } from "./modules/settings/adapter/launchd-environment";
import { createRestoreFiles } from "./modules/settings/adapter/restore-files";
import {
  installApplication,
  uninstallApplication,
  updateApplication,
} from "./modules/settings/usecase/install";
import { runRestore } from "./modules/settings/usecase/run-restore";
import { readEnvironment } from "../shared/env";
import { rotateLog } from "../shared/log/rotate";

const userHome = homedir();
const repository = process.cwd();
const home = resolve(process.env.SUKUNA_HOME ?? join(userHome, ".sukuna"));

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string" },
      login: { type: "string" },
      uninstall: { type: "boolean" },
      runner: { type: "boolean" },
    },
  });
  const [command] = positionals;
  if (
    positionals.length > 1 ||
    (command && !["restore", "update"].includes(command)) ||
    (values.runner && command !== "update") ||
    (values.uninstall && command)
  )
    throw new Error("導入、update [--runner]、--uninstall のいずれかを指定してください。");
  if (process.platform !== "darwin") throw new Error("導入のコマンドは macOS で実行してください。");

  const { files, launchd, readiness } = launchdEnvironment(home, userHome, repository);
  if (command === "restore") {
    const result = await runRestore({
      files: createRestoreFiles(home),
      services: launchd,
      rotate: () => rotateLog(join(home, "logs", "restore.log")),
      ready: (targets) => readiness(files.installedPort())(targets),
      warning(kind, error) {
        const detail = error instanceof Error ? error.message : String(error);
        const message = {
          log: "復元ログを整理できませんでした。",
          receipt: "補助の復元結果ファイルを保存できませんでした。",
          database: "データベースに復元結果を保存できませんでした。",
          services: "サービスの再登録に失敗しました。",
        }[kind];
        console.warn(message, detail);
      },
      now: Date.now,
      sleep,
    });
    if (result.status === "failed") throw new Error(result.message ?? "復元に失敗しました。");
    return;
  }
  if (values.uninstall) {
    await uninstallApplication({ launchd, removePlist: files.removePlist });
    return;
  }
  if (command === "update") {
    await updateApplication(values.runner === true, {
      files,
      launchd,
      output: console.log,
      ready: readiness(files.installedPort()),
    });
    return;
  }
  const checked = readEnvironment(
    "server",
    {
      NODE_ENV: "production",
      PORT: values.port,
      SUKUNA_LOGIN: values.login,
      SUKUNA_HOME: home,
    },
    userHome,
    () => true,
  );
  if (checked.isErr()) throw new Error(checked.error.message);
  const { port, login } = checked.value;
  if (!login) throw new Error("--login に Tailscale のログイン名を指定してください。");
  await installApplication(
    {
      repository,
      node: process.execPath,
      home,
      userHome,
      port,
      login,
      path: process.env.PATH ?? "",
      ...(process.env.CLAUDE_CONFIG_DIR === undefined
        ? {}
        : { claudeConfigDir: process.env.CLAUDE_CONFIG_DIR }),
    },
    {
      files,
      launchd,
      output: console.log,
      identity: () => createTailscaleLocalApi().identity(),
      ready: readiness(port),
    },
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`ログ: ${join(home, "logs")}`);
  process.exitCode = 1;
}
