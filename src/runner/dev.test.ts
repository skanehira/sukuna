import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  appendFileSync,
  cpSync,
  existsSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { expect, it } from "vite-plus/test";
import { migrations } from "../shared/db/migrate";
import { createTempHome, removeTempHome, tableNames } from "../shared/db/test-helpers";

it("開発用ランナーのコマンドを実行すると、全テーブルを用意して起動し、SIGTERM で終了する", async () => {
  const home = createTempHome();
  const child = spawn("vp", ["run", "dev:runner"], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { ...process.env, NODE_ENV: "development", VITEST: undefined, SUKUNA_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("ランナーを起動できませんでした");
  let stdout = "";
  let stderr = "";
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve));

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`起動を待てませんでした: ${stderr}`)),
        15_000,
      );
      const finish = (error?: Error): void => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      child.once("error", finish);
      child.once("exit", (code) => finish(new Error(`起動前に終了しました (${code}): ${stderr}`)));
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.includes("ERR_MODULE_NOT_FOUND")) finish(new Error(stderr));
      });
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const events = stdout
          .split("\n")
          .filter((line) => line.startsWith("{") && line.endsWith("}"));
        if (
          events.some((line) => {
            const event = JSON.parse(line) as { component: string; message: string };
            return event.component === "runner" && event.message === "started";
          })
        )
          finish();
      });
    });

    const sqlite = new Database(join(home, "sukuna.db"), { readonly: true });
    try {
      expect(tableNames(sqlite)).toEqual([
        "conversation_events",
        "conversations",
        "drafts",
        "issue_dependencies",
        "issue_events",
        "issues",
        "notifications",
        "pending_answers",
        "pr_snapshots",
        "projects",
        "push_subscriptions",
        "questions",
        "queued_instructions",
        "settings",
        "stock_items",
        "toc_entries",
        "worktrees",
      ]);
      expect(sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get()).toEqual({
        count: migrations.length,
      });
      expect(existsSync(join(home, "db.lock"))).toBe(false);
    } finally {
      sqlite.close();
    }
    process.kill(-pid, "SIGTERM");
    await exited;
    const messages = stdout
      .split("\n")
      .filter((line) => line.startsWith("{") && line.endsWith("}"))
      .map((line) => JSON.parse(line) as { component: string; message: string });
    expect(messages.map(({ component, message }) => ({ component, message }))).toEqual([
      { component: "runner", message: "started" },
      { component: "runner", message: "received SIGTERM" },
    ]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      process.kill(-pid, "SIGKILL");
      await exited;
    }
    removeTempHome(home);
  }
}, 20_000);

it.each([
  ["SIGTERM", "src/shared/db/startup.ts"],
  ["SIGINT", "src/shared/db/startup.ts"],
  ["SIGTERM", "src/server/modules/issue/adapter/issue-repository.ts"],
  ["SIGINT", "src/server/modules/issue/adapter/issue-repository.ts"],
] as const)(
  "開発用ランナーは %s で終了し、入口と依存 %s の変更を順に読み直す",
  async (signal, dependency) => {
    const sandbox = createTempHome();
    const root = fileURLToPath(new URL("../..", import.meta.url));
    cpSync(join(root, "src"), join(sandbox, "src"), { recursive: true });
    cpSync(join(root, "package.json"), join(sandbox, "package.json"));
    symlinkSync(join(root, "node_modules"), join(sandbox, "node_modules"), "dir");
    const home = join(sandbox, "data");
    const child = spawn("vp", ["run", "dev:runner"], {
      cwd: sandbox,
      env: { ...process.env, NODE_ENV: "development", VITEST: undefined, SUKUNA_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error("ランナーを起動できませんでした");
    const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
    const messages: { component: string; message: string }[] = [];
    const changed = new EventEmitter();
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (!line.startsWith("{")) return;
      const { component, message } = JSON.parse(line) as { component: string; message: string };
      messages.push({ component, message });
      changed.emit("message");
    });
    const waitForMessages = (count: number): Promise<void> =>
      new Promise((resolve, reject) => {
        const finish = (error?: Error): void => {
          clearTimeout(timeout);
          changed.off("message", observe);
          child.off("exit", stopped);
          if (error) reject(error);
          else resolve();
        };
        const observe = (): void => {
          if (messages.length >= count) finish();
        };
        const stopped = (): void => finish(new Error(`起動中に終了しました: ${stderr}`));
        const timeout = setTimeout(
          () =>
            finish(
              new Error(`変更の反映を待てませんでした: ${JSON.stringify(messages)} ${stderr}`),
            ),
          5_000,
        );
        changed.on("message", observe);
        child.once("exit", stopped);
        observe();
      });

    try {
      await waitForMessages(1);
      expect(messages).toEqual([{ component: "runner", message: "started" }]);
      const main = join(sandbox, "src/runner/main.ts");
      const before = readFileSync(main, "utf8");
      expect(before.split('message: "started",')).toHaveLength(2);
      writeFileSync(main, before.replace('message: "started",', 'message: "entry updated",'));
      await waitForMessages(3);
      expect(messages).toEqual([
        { component: "runner", message: "started" },
        { component: "runner", message: "received SIGTERM" },
        { component: "runner", message: "entry updated" },
      ]);

      appendFileSync(
        join(sandbox, dependency),
        '\nconsole.log(JSON.stringify({ component: "fixture", message: "shared updated" }));\n',
      );
      await waitForMessages(6);
      expect(messages).toEqual([
        { component: "runner", message: "started" },
        { component: "runner", message: "received SIGTERM" },
        { component: "runner", message: "entry updated" },
        { component: "runner", message: "received SIGTERM" },
        { component: "fixture", message: "shared updated" },
        { component: "runner", message: "entry updated" },
      ]);
      process.kill(-pid, signal);
      await exited;
      expect(messages).toEqual([
        { component: "runner", message: "started" },
        { component: "runner", message: "received SIGTERM" },
        { component: "runner", message: "entry updated" },
        { component: "runner", message: "received SIGTERM" },
        { component: "fixture", message: "shared updated" },
        { component: "runner", message: "entry updated" },
        { component: "runner", message: `received ${signal}` },
      ]);
      const sqlite = new Database(join(home, "sukuna.db"), { readonly: true });
      try {
        expect(sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get()).toEqual({
          count: migrations.length,
        });
        expect(existsSync(join(home, "db.lock"))).toBe(false);
      } finally {
        sqlite.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        process.kill(-pid, "SIGKILL");
        await exited;
      }
      lines.close();
      removeTempHome(sandbox);
    }
  },
  20_000,
);
