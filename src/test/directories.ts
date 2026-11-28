import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  readEnvironment,
  resolveDirectories,
  type Directories,
  type Environment,
} from "../shared/env";

export function directoriesIn(home: string): Directories {
  return { data: home, state: join(home, "state"), runtime: home };
}

export function xdgVariablesIn(root: string) {
  return {
    XDG_DATA_HOME: join(root, "d"),
    XDG_STATE_HOME: join(root, "s"),
    XDG_RUNTIME_DIR: join(root, "r"),
  };
}

export function xdgDirectoriesIn(root: string): Directories {
  return resolveDirectories(xdgVariablesIn(root), root);
}

export function testEnvironment(
  home: string,
  env: Readonly<Record<string, string | undefined>> = {},
): Environment {
  const environment = readEnvironment(
    "runner",
    { SUKUNA_RUNNER_SOCKET: join(home, "runner.sock"), ...env },
    home,
    () => true,
  )._unsafeUnwrap();
  return { ...environment, directories: directoriesIn(home) };
}

export function separateDirectoriesIn(root: string): Directories {
  const directories = {
    data: join(root, "data"),
    state: join(root, "state"),
    runtime: join(root, "runtime"),
  };
  for (const directory of Object.values(directories)) mkdirSync(directory);
  return directories;
}

export function vitePlusVariables(env: NodeJS.ProcessEnv = process.env) {
  const base = (name: string, fallback: string) => {
    const value = env[name];
    return value && isAbsolute(value) ? value : join(homedir(), fallback);
  };
  const data = env.VP_DATA_DIR ?? join(base("XDG_DATA_HOME", ".local/share"), "vite-plus");
  return {
    VP_DATA_DIR: data,
    VP_BIN_DIR: env.VP_BIN_DIR ?? join(data, "bin"),
    VP_CACHE_DIR: env.VP_CACHE_DIR ?? join(base("XDG_CACHE_HOME", ".cache"), "vite-plus"),
  };
}
