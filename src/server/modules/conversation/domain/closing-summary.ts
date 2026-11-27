import { z } from "zod";
import { closingPrSchema } from "../../../../shared/lifecycle";

export function parseClosingCommits(output: string): { hash: string; subject: string }[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const dateEnd = line.indexOf("\t");
      const hashEnd = line.indexOf("\t", dateEnd + 1);
      const timestamp = line.slice(0, dateEnd);
      const at = Number(timestamp);
      const hash = line.slice(dateEnd + 1, hashEnd);
      if (
        dateEnd < 0 ||
        hashEnd < 0 ||
        !/^\d+$/.test(timestamp) ||
        !Number.isSafeInteger(at) ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)
      )
        throw new Error("git log の結果を読み取れませんでした");
      return { at, hash, subject: line.slice(hashEnd + 1) };
    })
    .sort((a, b) => b.at - a.at)
    .map(({ hash, subject }) => ({ hash, subject }));
}

export function parseUncommittedPaths(output: string): string[] {
  const tokens = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index]!;
    if (token.length < 4 || token[2] !== " ")
      throw new Error("git status の結果を読み取れませんでした");
    paths.push(token.slice(3));
    if (/[RC]/.test(token.slice(0, 2))) index += 1;
  }
  return [...new Set(paths)].sort();
}

export function parseClosingCount(output: string): number {
  const value = output.trim();
  const count = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(count))
    throw new Error("git rev-list の結果を読み取れませんでした");
  return count;
}

const closingPrRows = z.array(
  closingPrSchema.extend({ createdAt: z.iso.datetime({ offset: true }) }),
);
export function parseClosingPrs(output: string, firstEventAt: number) {
  const rows = closingPrRows.safeParse(JSON.parse(output));
  if (!rows.success) throw new Error("gh の結果を読み取れませんでした");
  return {
    received: rows.data.length,
    reachedStart: rows.data.some(({ createdAt }) => Date.parse(createdAt) <= firstEventAt),
    items: rows.data
      .filter(({ createdAt }) => Date.parse(createdAt) > firstEventAt)
      .map(({ number, title, url, state }) => ({ number, title, url, state })),
  };
}

export function limitClosingItems<T>(items: T[], limit: number) {
  return { items: items.slice(0, limit), more: Math.max(items.length - limit, 0) };
}
