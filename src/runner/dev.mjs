import { fork } from "node:child_process";
import { once } from "node:events";
import { readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));

if (process.argv[2] === "--run") {
  if (!process.connected) process.exit(0);
  process.once("disconnect", () => process.kill(process.pid, "SIGTERM"));
  const server = await createServer({
    configFile: false,
    root,
    envDir: false,
    appType: "custom",
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { entries: [] },
  });

  try {
    await server.ssrLoadModule("/src/runner/main.ts");
  } catch (error) {
    await server.close();
    throw error;
  }
} else {
  let stopping = false;
  let changes = Promise.resolve();
  const snapshots = new Map();

  function startRunner() {
    const child = fork(fileURLToPath(import.meta.url), ["--run"], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      detached: true,
    });
    return { child, ended: once(child, "close") };
  }

  let runner = startRunner();

  async function stopRunner(signal) {
    if (runner.child.exitCode === null && runner.child.signalCode === null) {
      runner.child.kill(signal);
    }
    await runner.ended;
  }

  const watchers = ["src/runner", "src/shared", "src/server/modules/issue"].map((directory) => {
    const path = join(root, directory);
    return watch(path, { recursive: true }, (_event, filename) => {
      if (stopping || !filename || !/\.(?:[cm]?[jt]sx?|json|sql)$/.test(filename)) return;
      const file = join(path, filename);
      let snapshot;
      try {
        snapshot = readFileSync(file, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        snapshot = null;
      }
      if (snapshots.has(file) && snapshots.get(file) === snapshot) return;
      snapshots.set(file, snapshot);
      changes = changes.then(async () => {
        if (stopping) return;
        await stopRunner("SIGTERM");
        if (!stopping) runner = startRunner();
      });
    });
  });

  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    for (const watcher of watchers) watcher.close();
    await changes;
    await stopRunner(signal);
  }

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
