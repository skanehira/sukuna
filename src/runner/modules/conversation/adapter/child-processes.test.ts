import { once } from "node:events";
import { expect, it } from "vite-plus/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChildProcesses } from "./child-processes";
it("記録した PID のうち Claude の子だけを止め、生き残りは強制終了して記録を空にする", async () => {
  const home = mkdtempSync(join(tmpdir(), "sukuna-children-"));
  mkdirSync(join(home, "runner"));
  writeFileSync(join(home, "runner/children"), "101\n102\n103\n");
  const signals: unknown[] = [];
  const living = new Set([101, 102]);
  const manager = new ChildProcesses(home, {
    command: (pid) =>
      Promise.resolve(
        living.has(pid)
          ? pid === 101
            ? "node /sdk/claude-agent-sdk/cli.js --session-id test"
            : "node unrelated.js --label claude"
          : "",
      ),
    kill: (pid, signal) => {
      signals.push({ pid, signal });
      if (signal === "SIGKILL") living.delete(pid);
    },
    wait: () => Promise.resolve(),
  });
  try {
    await manager.cleanup();
    expect(signals).toEqual([
      { pid: 101, signal: "SIGTERM" },
      { pid: 101, signal: "SIGKILL" },
    ]);
    expect(readFileSync(join(home, "runner/children"), "utf8")).toBe("");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("別のランナーが記録した生きた子プロセスを次の起動で停止する", async () => {
  const { runCommand } = await import("../../../../shared/command");
  const home = mkdtempSync(join(tmpdir(), "sukuna-real-child-"));
  mkdirSync(join(home, "claude-agent-sdk"));
  const fixturePath = join(home, "claude-agent-sdk/cli.js");
  writeFileSync(fixturePath, "setInterval(() => {}, 60000)");
  const first = new ChildProcesses(home);
  const child = first.spawn({
    command: process.execPath,
    args: [fixturePath],
    cwd: home,
    env: process.env,
    signal: new AbortController().signal,
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const pid = child.pid;
  if (pid === undefined) throw new Error("子プロセスなし");
  try {
    await once(child, "spawn");
    const second = new ChildProcesses(home, {
      command: async (target) =>
        (await runCommand("ps", ["-p", String(target), "-o", "command="], { cwd: home })).stdout,
      kill: (target, signal) => {
        process.kill(target, signal);
      },
      wait: () => exited,
    });
    await second.cleanup();
    await exited;
    expect({
      signal: child.signalCode,
      recorded: readFileSync(join(home, "runner/children"), "utf8"),
    }).toEqual({ signal: "SIGTERM", recorded: "" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
