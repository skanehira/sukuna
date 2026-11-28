import type { LineInfo } from "../../buffer/line";
import type { Event, Project } from "./types";

const RESULT_HEAD = "  ⎿  ";
const RESULT_INDENT = "     ";
const RESULT_ROWS = 3;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
export function toolSubject(name: string, input: unknown, cwd: string): string {
  const args = record(input);
  const path = args.file_path ?? args.notebook_path ?? args.path;
  if (typeof path === "string")
    return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
  const value =
    name === "Bash"
      ? args.command
      : name === "WebFetch"
        ? args.url
        : name === "Agent" || name === "Task"
          ? args.description
          : args.pattern;
  return typeof value === "string" ? value.split("\n")[0] : "";
}
function toolTarget(
  name: string,
  input: unknown,
  result: string | null,
  id: string,
  cwd: string,
): { url: string } | undefined {
  const args = record(input);
  if (["Read", "Edit", "Write", "NotebookEdit"].includes(name)) {
    const path = toolSubject(name, input, cwd);
    if (path)
      return {
        url: `/conversations/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}&line=1`,
      };
  }
  if (name.startsWith("mcp__sukuna__issue_") && name !== "mcp__sukuna__issue_list") {
    let issue = args;
    if (name === "mcp__sukuna__issue_create") {
      try {
        const parsed = record(JSON.parse(result ?? "{}"));
        issue = record(parsed.issue ?? parsed);
      } catch {
        return;
      }
    }
    const target = issue.number;
    if (typeof target === "string" || typeof target === "number")
      return { url: `/issues/${encodeURIComponent(target)}` };
  }
}
export function stoppedText(
  reason: string,
  detail?: string,
  resetsAt?: number | null,
  closed = false,
): string {
  switch (reason) {
    case "user":
      return "止めました";
    case "restarted":
      return "作業が止まりました (AI を動かすプロセスが再起動しました)";
    case "credits_required":
      return "止まっています: クレジットの購入が要ります";
    case "usage_limit":
      return closed
        ? "利用枠切れで止まっています。続きを送ると再開します"
        : `止まっています: 利用枠を使い切りました。${resetsAt == null ? "15 分ごとに再開を試みます" : `${new Date(resetsAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })} に戻り、自動で再開します`}`;
    default:
      return `止まっています: ${detail ?? "作業に失敗しました"}`;
  }
}
export function eventLines(
  event: Event,
  id: string,
  cwd: string,
  result: string | null = null,
  expanded = false,
): LineInfo[] {
  const { seq } = event;
  const line = (kind: LineInfo["kind"], text: string, extra: Partial<LineInfo> = {}): LineInfo => ({
    kind,
    text,
    seq,
    ...extra,
  });
  const body = (text: string): LineInfo[] =>
    text.split("\n").map((text, seqLine) => line("text", text, { seqLine }));
  switch (event.type) {
    case "user_message": {
      const { origin, text, images } = event.payload;
      if (origin === "answer_text" || origin === "resume") return [];
      if (origin === "flow") return [line("separator", "自動フローが指示を送りました")];
      if (origin === "finish_proposal") return [line("separator", "確定事項の案を求めました")];
      return [
        line("speaker", "あなた"),
        ...body(text),
        ...(images.length
          ? [
              line(
                "note",
                `画像 ${images.length} 件${event.missingImages ? ` (見つかりません ${event.missingImages} 件)` : ""}`,
              ),
            ]
          : []),
      ];
    }
    case "assistant_text":
      return [line("speaker", "AI"), ...body(event.payload.text)];
    case "tool_use": {
      const { name, input } = event.payload;
      const target = toolTarget(name, input, result, id, cwd);
      const tool = name.startsWith("mcp__") ? name.split("__").at(-1)! : name;
      return [
        line("tool", `● ${tool}(${toolSubject(name, input, cwd)})`, {
          seqLine: 0,
          ...(target ? { target } : {}),
        }),
      ];
    }
    case "tool_result": {
      const { content, truncated } = event.payload;
      const output = content.replace(/\n+$/, "");
      if (output === "") return [line("tool", `${RESULT_HEAD}(出力なし)`)];
      const rows = output.split("\n");
      const shown = rows
        .slice(0, RESULT_ROWS)
        .map((text, seqLine) =>
          line("tool", `${seqLine === 0 ? RESULT_HEAD : RESULT_INDENT}${text}`, { seqLine }),
        );
      const rest = rows.length - RESULT_ROWS;
      return rest > 0
        ? [...shown, line("tool", `${RESULT_INDENT}… +${rest} 行${truncated ? "以上" : ""}`)]
        : shown;
    }
    case "diff": {
      let seqLine = 0;
      const created = (event.payload.content ?? "").split("\n");
      if (created.at(-1) === "") created.pop();
      const hunks =
        event.payload.change === "create"
          ? [{ old_start: 1, new_start: 1, lines: created.map((text) => `+${text}`) }]
          : event.payload.hunks;
      const lines = hunks.flatMap((hunk) => {
        let oldLine = hunk.old_start,
          newLine = hunk.new_start;
        return hunk.lines.map((text) => {
          const kind = text.startsWith("+") ? "add" : text.startsWith("-") ? "del" : "code";
          const number = kind === "del" ? oldLine : newLine;
          if (kind !== "add") oldLine++;
          if (kind !== "del") newLine++;
          return line(kind, `${number} ${text}`, { seqLine: seqLine++ });
        });
      });
      return lines.length > 25 && !expanded
        ? [
            ...lines.slice(0, 10),
            line("menu", `残り ${lines.length - 10} 行 (Enter か zo で開く)`, {
              action: `conversation.diff.${seq}`,
              id: `diff:${seq}`,
            }),
          ]
        : lines;
    }
    case "answer":
      return [
        line("speaker", "あなた"),
        ...Object.entries(event.payload.answers).map(([index, answer], seqLine) =>
          line(
            "text",
            `Q${Number(index) + 1}: ${[answer.choices.join("、"), answer.text].filter(Boolean).join(": ")}`,
            { seqLine },
          ),
        ),
      ];
    case "permission_decision":
      return [line("note", event.payload.behavior === "allow" ? "許可しました" : "拒否しました")];
    case "stopped":
      return [
        line(
          "separator",
          stoppedText(event.payload.reason, event.payload.detail, event.payload.resets_at),
        ),
      ];
    case "resumed":
      return [line("separator", "再開しました")];
    default:
      return [];
  }
}
export function switchLines(projects: Project[], currentProject?: string): LineInfo[] {
  return projects.flatMap((project) => [
    { kind: "heading" as const, text: project.name },
    ...project.conversations.map((conversation): LineInfo => ({
      kind: "row",
      text: `会話: ${conversation.title}`,
      id: `conversation:${conversation.id}`,
      target: { url: `/conversations/${encodeURIComponent(conversation.id)}` },
    })),
    ...project.issues
      .filter((issue) => !["draft", "done", "withdrawn"].includes(issue.state))
      .map((issue): LineInfo => ({
        kind: "row",
        text: `#${issue.number} ${issue.title}`,
        id: `issue:${issue.id}`,
        target: { url: `/issues/${encodeURIComponent(issue.id)}` },
      })),
    {
      kind: "menu" as const,
      text: `${project.name} で会話を始める`,
      action: `conversation.start.${project.id}`,
    },
    ...(project.id === currentProject
      ? [
          {
            kind: "menu" as const,
            text: "worktree を作って会話を始める",
            action: `conversation.worktree.${project.id}`,
          },
        ]
      : []),
  ]);
}
