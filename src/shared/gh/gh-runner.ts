import { readFileSync } from "node:fs";
import { runCommand, type CommandOptions, type CommandResult } from "../command";
import { ghScriptSchema } from "../gh-script";
import { ScriptedGh } from "./scripted-gh";
export interface GhRunner {
  run(args: string[], opts: CommandOptions): Promise<CommandResult>;
}
export function createGhRunner(scriptPath: string | null): GhRunner {
  if (scriptPath !== null)
    return new ScriptedGh(ghScriptSchema.parse(JSON.parse(readFileSync(scriptPath, "utf8"))));
  return { run: (args, opts) => runCommand("gh", args, opts) };
}
