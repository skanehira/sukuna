import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { runCommand } from "../../../../shared/command";
export type ProcessOperations = {
  command(pid: number): Promise<string>;
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  wait(ms: number): Promise<void>;
};
const processes: ProcessOperations = {
  command: async (pid) =>
    (await runCommand("ps", ["-p", String(pid), "-o", "command="], { cwd: "/" })).stdout.trim(),
  kill: (pid, signal) => {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  },
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
function isClaudeCommand(command: string): boolean {
  return command
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .some(
      (part) =>
        /(?:^|\/)claude$/.test(part) ||
        /\/claude\/versions\/[^/]+$/.test(part) ||
        /\/claude-agent-sdk\/cli\.(?:js|mjs)$/.test(part),
    );
}
export class ChildProcesses {
  private path: string;
  private pids = new Set<number>();
  private operations: ProcessOperations;
  constructor(home: string, operations: ProcessOperations = processes) {
    this.operations = operations;
    mkdirSync(join(home, "runner"), { recursive: true });
    this.path = join(home, "runner/children");
  }
  spawn = (options: SpawnOptions) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.pid !== undefined) {
      const pid = child.pid;
      this.pids.add(pid);
      this.save();
      child.once("exit", () => {
        this.pids.delete(pid);
        this.save();
      });
    }
    return child;
  };
  private save(): void {
    writeFileSync(this.path, [...this.pids].map((pid) => `${pid}\n`).join(""), { mode: 0o600 });
  }
  async cleanup(): Promise<number[]> {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") raw = "";
      else throw error;
    }
    const pids = raw
      .split("\n")
      .filter((s) => /^\d+$/.test(s))
      .map(Number)
      .filter((pid) => pid > 0);
    const targets: number[] = [];
    for (const pid of pids)
      if (isClaudeCommand(await this.operations.command(pid))) {
        this.operations.kill(pid, "SIGTERM");
        targets.push(pid);
      }
    if (targets.length) {
      await this.operations.wait(5000);
      for (const pid of targets)
        if (isClaudeCommand(await this.operations.command(pid)))
          this.operations.kill(pid, "SIGKILL");
    }
    this.pids.clear();
    this.save();
    return targets;
  }
}
