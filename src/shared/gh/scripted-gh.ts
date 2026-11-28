import { existsSync } from "node:fs";
import { ghScriptSchema, type GhScript } from "../gh-script";
import type { CommandOptions, CommandResult } from "../command";
import type { GhRunner } from "./gh-runner";
export class ScriptedGh implements GhRunner {
  readonly calls: { args: string[]; cwd: string; stdin?: string }[] = [];
  private script: ReturnType<typeof ghScriptSchema.parse>;
  constructor(script: GhScript) {
    this.script = ghScriptSchema.parse(script);
  }
  run(args: string[], opts: CommandOptions): Promise<CommandResult> {
    this.calls.push({
      args: [...args],
      cwd: opts.cwd,
      ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
    });
    const response =
      this.script.responses.find(
        (r) =>
          new RegExp(r.match).test(args.join(" ")) &&
          (r.whenFileExists === undefined || existsSync(r.whenFileExists)),
      ) ?? this.script.fallback;
    return Promise.resolve({
      stdout: response.stdout,
      stderr: response.stderr,
      exitCode: response.exit_code,
    });
  }
}
