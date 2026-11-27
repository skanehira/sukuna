import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { err, ok, type Result } from "neverthrow";
import { runCommand } from "../../../../shared/command";
import type { ContentMatch } from "../../../../shared/files";
import type { SearchClockPort, SearchPort, WorkspaceError } from "../domain/ports";

const rgMissing: WorkspaceError = {
  code: "internal",
  message: "rg が見つかりません。Mac に ripgrep を入れてください",
};
const matchSchema = z.object({
  type: z.literal("match"),
  data: z.object({
    path: z.object({ text: z.string() }),
    lines: z.object({ text: z.string() }),
    line_number: z.number(),
    submatches: z.array(z.object({ start: z.number() })).min(1),
  }),
});

const searchClock: SearchClockPort = {
  schedule: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};

async function symlinkNames(cwd: string): Promise<string[]> {
  const paths = await runCommand(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd },
  );
  const candidates = paths.stdout
    .split("\0")
    .filter((path) => path && !path.split("/").includes(".git"));
  const links = (
    await Promise.all(
      candidates.map(async (path) => {
        const info = await lstat(join(cwd, path)).catch(() => undefined);
        return info?.isSymbolicLink() ? path : undefined;
      }),
    )
  ).filter((path): path is string => path !== undefined);
  if (links.length === 0) return [];
  const ignored = await runCommand("git", ["check-ignore", "--no-index", "-z", "--stdin"], {
    cwd,
    stdin: `${links.join("\0")}\0`,
  });
  const excluded = new Set(ignored.stdout.split("\0"));
  return links.filter((path) => !excluded.has(path));
}

export function createRg(
  clock: SearchClockPort = searchClock,
  environment: NodeJS.ProcessEnv = process.env,
): SearchPort {
  const env = Object.fromEntries(
    Object.entries(environment).filter(([name]) => name !== "RIPGREP_CONFIG_PATH"),
  );
  return {
    files: async (cwd) => {
      const listed = await new Promise<Result<string[], WorkspaceError>>((resolve) => {
        const child = spawn("rg", ["--files", "--null", "--hidden", "-g", "!.git"], {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.resume();
        child.on("error", () => resolve(err(rgMissing)));
        child.on("close", (code) =>
          resolve(
            code === 0 || code === 1
              ? ok(stdout.split("\0").filter(Boolean).sort())
              : err({ code: "internal", message: "ファイルの一覧を取得できませんでした" }),
          ),
        );
      });
      if (listed.isErr()) return listed;
      const links = await symlinkNames(cwd);
      return ok([...new Set([...listed.value, ...links])].sort());
    },
    content: (cwd, query) =>
      new Promise((resolve) => {
        const child = spawn(
          "rg",
          ["--json", "--hidden", "-g", "!.git", "--max-columns", "500", "-e", query],
          { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
        );
        const matches: ContentMatch[] = [];
        let pending = "";
        let stderr = "";
        let timedOut = false;
        let truncated = false;
        const cancel = clock.schedule(() => {
          timedOut = true;
          child.kill();
        }, 10_000);
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          pending += chunk;
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            const parsed = matchSchema.safeParse(JSON.parse(line));
            if (!parsed.success) continue;
            if (matches.length === 1_000) {
              truncated = true;
              child.kill();
              break;
            }
            const data = parsed.data.data;
            const text = data.lines.text.replace(/\r?\n$/, "");
            const start = data.submatches[0].start;
            const col = Buffer.from(text).subarray(0, start).toString("utf8").length;
            matches.push({
              path: data.path.text,
              line: data.line_number,
              col,
              text: Array.from(text).slice(0, 500).join(""),
            });
          }
        });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", () => {
          cancel();
          resolve(err(rgMissing));
        });
        child.on("close", (code) => {
          cancel();
          if (code !== 0 && code !== 1 && !timedOut && !truncated) {
            resolve(err({ code: "invalid_input", message: stderr.split(/\r?\n/)[0] }));
            return;
          }
          matches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
          resolve(ok({ matches, truncated, timedOut }));
        });
      }),
  };
}
