import { serve } from "@hono/node-server";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { readEnvironment } from "../shared/env";
import { createLogger } from "../shared/log";
import { createApp } from "./app";
import { buildId } from "./build-id";
import { attachUpgradeHandler, getDatabase, initializeRuntime } from "./runtime";
import { createWorkspaceDependencies } from "./modules/workspace/adapter/dependencies";

const environment = readEnvironment("server", process.env, homedir(), (path) => {
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
  log({ level: "error", component: "server", message: environment.error.message });
  process.exit(1);
}
const env = environment.value;
const clientDir = fileURLToPath(new URL("../client", import.meta.url));
const initialized = await initializeRuntime({ homeDir: env.home }, { socket: env.socket, log });
if (initialized.isErr()) {
  log({ level: "error", component: "db.migrate", message: initialized.error.message });
  process.exit(1);
}
const server = serve(
  {
    fetch: createApp({
      clientDir,
      build: buildId,
      workspace: createWorkspaceDependencies(() => getDatabase().db),
    }).fetch,
    port: env.port,
    hostname: "0.0.0.0",
  },
  (info) =>
    log({
      level: "info",
      component: "server",
      message: `listening on http://${info.address}:${info.port}`,
    }),
);
server.on("error", (error) => {
  log({ level: "error", component: "server", message: "サーバーを起動できませんでした。", error });
  process.exit(1);
});
attachUpgradeHandler(server);
