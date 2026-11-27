import { realpathSync } from "node:fs";
import { connect } from "node:net";
import type { CommandResult } from "../../../../shared/command";
import type { LaunchdPort, PersistentService, ServiceReadiness } from "../domain/launchd-port";

type Endpoint = { path: string } | { port: number; host: string };

function canConnect(endpoint: Endpoint): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(endpoint);
    const finish = (ready: boolean) => {
      socket.destroy();
      resolve(ready);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function launchdReadiness(options: {
  launchd: Pick<LaunchdPort, "pid">;
  port: number;
  socket: string;
  openFiles(args: string[]): Promise<CommandResult>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): ServiceReadiness {
  const ready = async (target: PersistentService) => {
    const pid = await options.launchd.pid(target);
    if (pid === null) return false;
    const process = ["-nP", "-a", "-p", String(pid)];
    const server = target === "server";
    const endpoint = server ? { port: options.port, host: "127.0.0.1" } : { path: options.socket };
    const result = await options.openFiles(
      server
        ? [...process, `-i4TCP:${options.port}`, "-sTCP:LISTEN", "-Fp"]
        : [...process, "-U", "-Fn"],
    );
    if (result.exitCode !== 0) return false;
    const lines = result.stdout.split("\n");
    if (!lines.includes(`p${pid}`)) return false;
    if (!server) {
      const path = realPath(options.socket);
      if (
        !lines.some(
          (line) =>
            line.startsWith("n/") && realPath(line.slice(1).replace(/ type=.*$/, "")) === path,
        )
      )
        return false;
    }
    return (await canConnect(endpoint)) && (await options.launchd.pid(target)) === pid;
  };
  return async (targets) => {
    const deadline = options.now() + 30_000;
    let missing = [...targets];
    while (options.now() < deadline) {
      const results = await Promise.allSettled(targets.map(ready));
      missing = targets.filter((_, index) => {
        const result = results[index];
        return result?.status !== "fulfilled" || !result.value;
      });
      if (missing.length === 0) return missing;
      await options.sleep(250);
    }
    return missing;
  };
}
