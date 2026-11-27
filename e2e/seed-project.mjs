import { mkdirSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import Database from "better-sqlite3";

const [home, socketPath] = process.argv.slice(2);

function runnerReady() {
  return new Promise((resolve) => {
    const req = request({ socketPath, path: "/changes", timeout: 500 }, (response) => {
      resolve(response.statusCode === 200);
      response.destroy();
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

const deadline = Date.now() + 30_000;
while (!(await runnerReady())) {
  if (Date.now() >= deadline) throw new Error("E2E のランナーが起動しませんでした。");
  await setTimeout(50);
}

const project = join(home, "shop-api");
mkdirSync(project);
const db = new Database(join(home, "sukuna.db"), { fileMustExist: true });
try {
  db.prepare("INSERT INTO projects (id, name, path, default_branch) VALUES (?, ?, ?, ?)").run(
    "e2e-shop-api",
    "shop-api",
    project,
    "main",
  );
} finally {
  db.close();
}
