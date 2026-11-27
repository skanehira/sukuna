import type { GhRunner } from "../../../../shared/gh/gh-runner";

function githubRepository(origin: string): string | null {
  const scp = /^(?:[^@/:]+@)?github\.com:(.+)$/i.exec(origin);
  let path = scp?.[1];
  if (path === undefined) {
    try {
      const url = new URL(origin);
      const host = url.hostname.toLowerCase();
      if (host !== "github.com" && !(url.protocol === "ssh:" && host === "ssh.github.com"))
        return null;
      if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return null;
      path = url.pathname.slice(1);
    } catch {
      return null;
    }
  }
  const name = path.replace(/\/$/, "").replace(/\.git$/i, "");
  return /^[\w.-]+\/[\w.-]+$/.test(name) ? `https://github.com/${name}` : null;
}

export function createProjectGithub(gh: GhRunner) {
  return {
    async inspect(
      origin: string | null,
      cwd: string,
    ): Promise<{ available: boolean; reason?: string }> {
      const repository = origin === null ? null : githubRepository(origin);
      if (repository === null) return { available: false };
      const result = await gh.run(["repo", "view", repository, "--json", "nameWithOwner"], { cwd });
      if (result.exitCode === 0) return { available: true };
      return {
        available: false,
        reason: /auth login|not logged|authentication required/i.test(result.stderr)
          ? "gh にログインしていません。ターミナルで gh auth login を実行してください"
          : "GitHub のリポジトリを確認できませんでした。origin と gh の接続を確認してください。",
      };
    },
  };
}
