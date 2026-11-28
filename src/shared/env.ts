import { isAbsolute, join } from "node:path";
import { err, ok, type Result } from "neverthrow";

export type Directories = {
  data: string;
  state: string;
  runtime: string;
};

type Variables = Readonly<Record<string, string | undefined>>;

export type Environment = {
  directories: Directories;
  socket: string;
  port: number;
  agent: "fake" | "real";
  agentScript: string | null;
  ghScript: string | null;
  logLevel: "debug" | "info" | "warn" | "error";
};

function baseDirectory(env: Variables, name: string): string | undefined {
  const value = env[name];
  return value && isAbsolute(value) ? value : undefined;
}

export function resolveDirectories(env: Variables, userHome: string): Directories {
  const state = join(
    baseDirectory(env, "XDG_STATE_HOME") ?? join(userHome, ".local", "state"),
    "sukuna",
  );
  const runtime = baseDirectory(env, "XDG_RUNTIME_DIR");
  return {
    data: join(baseDirectory(env, "XDG_DATA_HOME") ?? join(userHome, ".local", "share"), "sukuna"),
    state,
    runtime: runtime === undefined ? state : join(runtime, "sukuna"),
  };
}

export function runnerSocketIn(directories: Directories): string {
  return join(directories.runtime, "runner.sock");
}

export function readEnvironment(
  role: "server" | "runner",
  env: Variables,
  userHome: string,
  readable: (path: string) => boolean,
): Result<Environment, { message: string }> {
  const production = env.NODE_ENV === "production";
  const forbidden =
    role === "runner" ? ["SUKUNA_AGENT", "SUKUNA_AGENT_SCRIPT", "SUKUNA_GH"] : ["SUKUNA_GH"];
  for (const key of forbidden) {
    if (production && env[key] !== undefined)
      return err({ message: `本番では ${key} を指定できません。` });
  }
  const directories = resolveDirectories(env, userHome);
  const socket = env.SUKUNA_RUNNER_SOCKET ?? runnerSocketIn(directories);
  if (Buffer.byteLength(socket) > 103)
    return err({ message: "SUKUNA_RUNNER_SOCKET は 103 バイト以内で指定してください。" });
  const portText = role === "server" ? (env.PORT ?? "4580") : "4580";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535)
    return err({ message: "PORT は 1〜65535 の整数で指定してください。" });
  if (
    role === "runner" &&
    env.SUKUNA_AGENT === "fake" &&
    (!env.SUKUNA_AGENT_SCRIPT || !readable(env.SUKUNA_AGENT_SCRIPT))
  ) {
    return err({
      message: "SUKUNA_AGENT=fake には読み取り可能な SUKUNA_AGENT_SCRIPT が必要です。",
    });
  }
  const logLevel = env.SUKUNA_LOG_LEVEL;
  return ok({
    directories,
    socket,
    port,
    agent: env.SUKUNA_AGENT === "fake" ? "fake" : "real",
    agentScript: env.SUKUNA_AGENT_SCRIPT ?? null,
    ghScript: env.SUKUNA_GH ?? null,
    logLevel:
      logLevel === "debug" || logLevel === "warn" || logLevel === "error" ? logLevel : "info",
  });
}
