import type { Result } from "neverthrow";
import type { z } from "zod";
import type { questionsSchema } from "../../../../shared/events";

export type AgentError = { message: string };
export type QuestionRequest = { requestId: string; questions: z.infer<typeof questionsSchema> };
export type PermissionRequest = {
  requestId: string;
  toolName: string;
  input: unknown;
  title?: string;
  reason?: string;
  blockedPath?: string;
};
export type PermissionDecision = { behavior: "allow" } | { behavior: "deny"; message: string };
export type AppTool = {
  name: string;
  description: string;
  input: z.ZodRawShape;
  alwaysLoad: boolean;
  handler(
    input: unknown,
    ctx: { conversationId: string; projectId: string; issueId: string | null },
  ): Promise<{ text: string; isError: boolean }>;
};
export type OpenParams = {
  sessionId: string;
  resume: boolean;
  cwd: string;
  model: "opus" | "sonnet" | "haiku" | null;
  permissionMode: "bypassPermissions" | "default" | "acceptEdits" | "plan";
  appendSystemPrompt: string;
  additionalDirectories?: string[];
  appTools: AppTool[];
  context: { conversationId: string; projectId: string; issueId: string | null };
  onQuestion(req: QuestionRequest): Promise<Record<string, string>>;
  onPermission(req: PermissionRequest): Promise<PermissionDecision>;
};
export type CompleteParams = {
  model: "haiku";
  system: string;
  prompt: string;
  title: string;
  purpose: string;
  signal?: AbortSignal;
};
export interface AgentPort {
  open(params: OpenParams): AgentSession;
  fork(
    sessionId: string,
    opts: { dir: string },
  ): Promise<Result<{ sessionId: string }, AgentError>>;
  complete(
    params: CompleteParams,
  ): Promise<Result<{ text: string; inputTokens: number; outputTokens: number }, AgentError>>;
}
export interface AgentSession {
  readonly output: AsyncIterable<AgentOutput>;
  send(msg: { text: string; images: { data: Buffer; mediaType: string }[] }): void;
  interrupt(): Promise<void>;
  commands(): Promise<{ name: string; description: string }[]>;
  close(): void;
}
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};
export type DiffOutput = {
  path: string;
  change: "edit" | "create" | "update";
  hunks: {
    old_start: number;
    old_lines: number;
    new_start: number;
    new_lines: number;
    lines: string[];
  }[];
  content?: string;
};
export type AgentOutput =
  | { kind: "init"; sessionId: string; commands: { name: string; description: string }[] }
  | { kind: "text_delta"; text: string; parentToolUseId: string | null }
  | { kind: "assistant_text"; uuid: string; text: string; parentToolUseId: string | null }
  | {
      kind: "tool_use";
      uuid: string;
      toolUseId: string;
      name: string;
      input: unknown;
      parentToolUseId: string | null;
    }
  | {
      kind: "tool_result";
      uuid: string;
      toolUseId: string;
      isError: boolean;
      content: string;
      diff: DiffOutput | null;
      parentToolUseId: string | null;
    }
  | { kind: "assistant_error"; error: string }
  | {
      kind: "rate_limit";
      status: "allowed" | "allowed_warning" | "rejected";
      resetsAt: number | null;
      overageStatus: string | null;
      errorCode: string | null;
      raw: unknown;
    }
  | { kind: "background_task"; taskId: string; running: boolean }
  | {
      kind: "turn_end";
      subtype: string;
      usage: TokenUsage;
      costUsd: number;
      durationMs: number;
      permissionDenials: number;
      terminalReason: string | null;
    };

export interface CommandCache {
  remember(
    conversationId: string,
    projectId: string,
    commands: { name: string; description: string }[],
  ): void;
  read(conversationId: string, projectId: string): { name: string; description: string }[];
}
