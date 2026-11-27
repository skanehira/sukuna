import { runCommand, type CommandOptions, type CommandResult } from "../../../../shared/command";
export interface GitRunner {
  run(args: string[], opts: CommandOptions): Promise<CommandResult>;
}
export function createGitCli(
  runner: GitRunner = { run: (args, opts) => runCommand("git", args, opts) },
): GitRunner {
  return runner;
}
