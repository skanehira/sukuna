import { join } from "node:path";
import { launchdReadiness } from "./launchd-readiness";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { runCommand } from "../../../../shared/command";
import { isProcessAlive } from "../../../../shared/db/startup";
import { createInstallFiles } from "./install-files";
import { createLaunchctl } from "./launchctl";

export function launchdEnvironment(home: string, userHome = homedir(), repository = process.cwd()) {
  const files = createInstallFiles(home, userHome, repository);
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
        socket: join(home, "runner.sock"),
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
