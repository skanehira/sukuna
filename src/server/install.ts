import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { tailscaleDnsName } from "./network-access";
import { launchdEnvironment } from "./modules/settings/adapter/launchd-environment";
import { directoriesForCommand } from "./modules/settings/adapter/install-files";
import { createRestoreFiles } from "./modules/settings/adapter/restore-files";
import {
  installApplication,
  uninstallApplication,
  updateApplication,
} from "./modules/settings/usecase/install";
import { runRestore } from "./modules/settings/usecase/run-restore";
import { readEnvironment, resolveDirectories } from "../shared/env";
import { rotateLog } from "../shared/log/rotate";

const userHome = homedir();
const repository = process.cwd();
let directories = resolveDirectories(process.env, userHome);

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

  directories = directoriesForCommand(command, process.env, userHome);
  const { files, launchd, readiness } = launchdEnvironment(directories, userHome, repository);
  if (command === "restore") {
    const result = await runRestore({
      files: createRestoreFiles(directories),
      services: launchd,
      rotate: () => rotateLog(join(directories.state, "logs", "restore.log")),
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
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    },
    userHome,
    () => true,
  );
  if (checked.isErr()) throw new Error(checked.error.message);
  const { port } = checked.value;
  await installApplication(
    {
      repository,
      node: process.execPath,
      stateDirectory: directories.state,
      userHome,
      port,
      path: process.env.PATH ?? "",
      ...(process.env.CLAUDE_CONFIG_DIR === undefined
        ? {}
        : { claudeConfigDir: process.env.CLAUDE_CONFIG_DIR }),
      terminal: process.env,
    },
    {
      files,
      launchd,
      output: console.log,
      dnsName: tailscaleDnsName,
      ready: readiness(port),
    },
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`ログ: ${join(directories.state, "logs")}`);
  process.exitCode = 1;
}
