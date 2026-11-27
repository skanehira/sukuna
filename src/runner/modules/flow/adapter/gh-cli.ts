import { err, ok, Result } from "neverthrow";
import { z } from "zod";
import type { CommandResult } from "../../../../shared/command";
import { designCommitSchema } from "../../../../shared/api/design";
import type { DesignGithub } from "../domain/design-ports";
import type { GhRunner } from "../../../../shared/gh/gh-runner";
export function createGhCli(runner: GhRunner): GhRunner {
  return runner;
}

const pr = z.object({
  state: z.string(),
  mergeCommit: z.object({ oid: designCommitSchema }).nullish(),
});

export function createDesignGithub(runner: GhRunner): DesignGithub {
  return {
    async create(project, branch, title, body) {
      const response = await runner.run(
        [
          "pr",
          "create",
          "--base",
          project.defaultBranch,
          "--head",
          branch,
          "--title",
          title,
          "--body-file",
          "-",
        ],
        { cwd: project.path, stdin: body },
      );
      const output = response.stdout.trim();
      return response.exitCode === 0 && /^https:\/\/[^\s]+\/pull\/\d+$/.test(output)
        ? ok(output)
        : err({
            message: `設計書の PR を作れませんでした: ${firstError(response)}。時間をおいて、もう一度承認してください`,
          });
    },
    async view(project, url) {
      const response = await runner.run(["pr", "view", url, "--json", "state,mergeCommit"], {
        cwd: project.path,
      });
      if (response.exitCode !== 0) return err({ message: firstError(response) });
      const json = Result.fromThrowable((): unknown => JSON.parse(response.stdout))();
      const parsed = json.isOk() ? pr.safeParse(json.value) : null;
      return parsed?.success
        ? ok({ state: parsed.data.state, mergeCommit: parsed.data.mergeCommit?.oid ?? null })
        : err({ message: "設計書の PR の状態を確認できませんでした" });
    },
  };
}

function firstError(response: CommandResult) {
  return (
    (response.stderr || response.stdout).trim().split(/\r?\n/)[0] || "GitHub の応答がありません"
  );
}
