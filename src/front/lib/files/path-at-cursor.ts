type FileLocation = { path: string; line: number };

function normalize(path: string): string[] | null {
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(segment);
  }
  return parts;
}

export function relativeFilePath(path: string, cwd: string): string | null {
  if (!path || path.includes("\0") || path.includes("\\")) return null;
  const parts = normalize(path);
  if (!parts) return null;
  if (path.startsWith("/")) {
    const prefix = normalize(cwd);
    if (!prefix || !cwd.startsWith("/") || !prefix.every((part, i) => parts[i] === part))
      return null;
    parts.splice(0, prefix.length);
  }
  return parts.length && parts[0] !== ".git" ? parts.join("/") : null;
}

export function pathAtCursor(
  text: string,
  column: number,
  cwd: string,
): FileLocation | { outside: true } | null {
  const word = Array.from(text.matchAll(/\S+/g)).find(
    (match) => column >= match.index && column < match.index + match[0].length,
  );
  if (!word) return null;
  const token = word[0].replace(/^[`'"()[\]<>]+|[`'"()[\]<>.,;:]+$/g, "");
  if (!token) return null;
  const suffix = /:(\d+)(?::\d+)?$/.exec(token);
  const path = relativeFilePath(suffix ? token.slice(0, suffix.index) : token, cwd);
  if (path === null) return { outside: true };
  const line = suffix ? Number(suffix[1]) : 1;
  return { path, line: Number.isSafeInteger(line) ? Math.max(1, line) : 1 };
}
