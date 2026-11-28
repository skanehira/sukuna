import { launchdReadiness } from "./launchd-readiness";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { runCommand } from "../../../../shared/command";
import { isProcessAlive } from "../../../../shared/db/startup";
import { runnerSocketIn, type Directories } from "../../../../shared/env";
import { createInstallFiles } from "./install-files";
import { createLaunchctl } from "./launchctl";

export function launchdEnvironment(
  directories: Directories,
  userHome = homedir(),
  repository = process.cwd(),
) {
  const files = createInstallFiles(directories, userHome, repository);
  const launchd = createLaunchctl({
    uid: process.getuid?.() ?? 0,
    plist: files.plistPath,
    run: (args) =>
      runCommand("launchctl", args, { cwd: repository, signal: AbortSignal.timeout(27_000) }),
    alive: isProcessAlive,
    now: Date.now,
    sleep,
  });
  return {
    files,
    launchd,
    readiness: (port: number) =>
      launchdReadiness({
        launchd,
        port,
        socket: runnerSocketIn(directories),
        now: Date.now,
        sleep,
        openFiles: (args) =>
          runCommand("/usr/sbin/lsof", args, {
            cwd: repository,
            signal: AbortSignal.timeout(1_000),
          }),
      }),
  };
}
