import { objectOf, type ActivityEvent } from "./stage";

export function toolTarget(name: string, input: unknown, cwd: string): string {
  const fields = objectOf(input);
  if (name === "Bash") return stringOf(fields.command).split(/\r?\n/)[0] ?? "";
  if (["Read", "Edit", "Write", "NotebookEdit"].includes(name)) {
    const path = stringOf(name === "NotebookEdit" ? fields.notebook_path : fields.file_path);
    return path.startsWith("/") ? relativePath(cwd, path) : path;
  }
  if (name === "Grep" || name === "Glob") return stringOf(fields.pattern);
  if (name === "WebFetch") return stringOf(fields.url);
  if (name === "Task" || name === "Agent") return stringOf(fields.description);
  return "";
}

export function formatLastAction(name: string, input: unknown, cwd: string): string {
  const tool = name.startsWith("mcp__") ? name.split("__").slice(2).join("__") : name;
  const target = toolTarget(name, input, cwd);
  const text = target ? `${tool}(${target})` : tool;
  const characters = Array.from(text);
  return characters.length > 60 ? `${characters.slice(0, 60).join("")}…` : text;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function relativePath(cwd: string, path: string): string {
  const from = cwd.split("/").filter(Boolean);
  const to = path.split("/").filter(Boolean);
  while (from.length > 0 && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  return [...from.map(() => ".."), ...to].join("/") || ".";
}

export function lastActionInTurn(
  events: readonly (ActivityEvent & { seq: number })[],
  cwd: string,
) {
  const start = events.findLast(
    (event) => event.type === "user_message" || event.type === "resumed",
  );
  const tool = events.findLast(
    (event) => event.seq > (start?.seq ?? 0) && event.type === "tool_use",
  );
  const payload = objectOf(tool?.payload);
  return {
    lastAction: tool
      ? formatLastAction(stringOf(payload.name), payload.input, cwd)
      : "応答を作成中",
    lastActionAt: tool?.createdAt ?? null,
    turnStartedAt: start?.createdAt ?? 0,
  };
}
