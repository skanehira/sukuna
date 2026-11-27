import { spawn } from "node:child_process";
export type CommandResult = { stdout: string; stderr: string; exitCode: number };
export type CommandOptions = {
  cwd: string;
  stdin?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
};
export function runCommand(
  command: string,
  args: string[],
  opts: CommandOptions,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: "pipe",
      signal: opts.signal,
      env: opts.env && { ...process.env, ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ stdout, stderr: error.message, exitCode: 1 }));
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    child.stdin.on("error", () => {});
    child.stdin.end(opts.stdin);
  });
}
