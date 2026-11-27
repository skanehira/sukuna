import {
  query,
  forkSession,
  createSdkMcpServer,
  tool,
  type Options,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { err, ok } from "neverthrow";
import { AsyncQueue } from "../../../../shared/async-queue";
import type { AgentPort, AgentSession, OpenParams, CompleteParams } from "../domain/agent-port";
import { mapSdkMessage } from "./sdk-message-mapping";
export interface QueryLike extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  stopTask(id: string): Promise<void>;
  supportedCommands(): Promise<{ name: string; description: string }[]>;
  close(): void;
}
export type SdkApi = {
  query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): QueryLike;
  forkSession(id: string, options: { dir: string }): Promise<{ sessionId: string }>;
};
const questions = z.array(
  z.object({
    question: z.string(),
    header: z.string(),
    options: z.array(z.object({ label: z.string(), description: z.string() })),
    multiSelect: z.boolean().default(false),
  }),
);
export class ClaudeAgentSdk implements AgentPort {
  private sdk: SdkApi;
  private spawnProcess: Options["spawnClaudeCodeProcess"];
  constructor(
    sdk: SdkApi = { query, forkSession },
    spawnProcess?: Options["spawnClaudeCodeProcess"],
  ) {
    this.sdk = sdk;
    this.spawnProcess = spawnProcess;
  }
  open(params: OpenParams): AgentSession {
    const input = new AsyncQueue<SDKUserMessage>();
    const tasks = new Set<string>();
    const server = createSdkMcpServer({
      name: "sukuna",
      tools: params.appTools.map((appTool) =>
        tool(
          appTool.name,
          appTool.description,
          appTool.input,
          async (value) => {
            const result = await appTool.handler(value, params.context);
            return {
              content: [{ type: "text" as const, text: result.text }],
              isError: result.isError,
            };
          },
          { alwaysLoad: appTool.alwaysLoad },
        ),
      ),
    });
    const run = this.sdk.query({
      prompt: input,
      options: {
        cwd: params.cwd,
        ...(params.additionalDirectories
          ? { additionalDirectories: params.additionalDirectories }
          : {}),
        ...(params.resume ? { resume: params.sessionId } : { sessionId: params.sessionId }),
        ...(params.model === null ? {} : { model: params.model }),
        permissionMode: params.permissionMode,
        allowDangerouslySkipPermissions: params.permissionMode === "bypassPermissions",
        includePartialMessages: true,
        systemPrompt: { type: "preset", preset: "claude_code", append: params.appendSystemPrompt },
        settings: { cleanupPeriodDays: 36500 },
        mcpServers: { sukuna: server },
        spawnClaudeCodeProcess: this.spawnProcess,
        canUseTool: async (name, value, options) => {
          if (name === "AskUserQuestion") {
            const raw = questions.parse(value.questions);
            try {
              const answers = await params.onQuestion({
                requestId: options.requestId,
                questions: raw.map((q) => ({
                  question: q.question,
                  header: q.header,
                  options: q.options,
                  multi_select: q.multiSelect,
                })),
              });
              return { behavior: "allow", updatedInput: { ...value, answers } };
            } catch (error) {
              return {
                behavior: "deny",
                message: error instanceof Error ? error.message : "開発者が割り込んだ",
              };
            }
          }
          const result = await params.onPermission({
            requestId: options.requestId,
            toolName: name,
            input: value,
            ...(options.title === undefined ? {} : { title: options.title }),
            ...(options.decisionReason === undefined ? {} : { reason: options.decisionReason }),
            ...(options.blockedPath === undefined ? {} : { blockedPath: options.blockedPath }),
          });
          return result.behavior === "allow" ? { behavior: "allow", updatedInput: value } : result;
        },
      },
    });
    return {
      output: {
        async *[Symbol.asyncIterator]() {
          for await (const raw of run)
            for (const output of mapSdkMessage(raw, tasks)) {
              if (output.kind === "background_task") {
                if (output.running) tasks.add(output.taskId);
                else tasks.delete(output.taskId);
              }
              yield output;
            }
        },
      },
      send: (message) =>
        input.push({
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "text", text: message.text },
              ...message.images.map((img) => ({
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: img.mediaType as
                    | "image/png"
                    | "image/jpeg"
                    | "image/gif"
                    | "image/webp",
                  data: img.data.toString("base64"),
                },
              })),
            ],
          },
          parent_tool_use_id: null,
          session_id: params.sessionId,
          origin: { kind: "human" },
        }),
      interrupt: async () => {
        await run.interrupt();
        await Promise.all([...tasks].map((id) => run.stopTask(id)));
        tasks.clear();
      },
      commands: () => run.supportedCommands(),
      close: () => {
        input.close();
        run.close();
      },
    };
  }
  async fork(sessionId: string, opts: { dir: string }) {
    try {
      return ok(await this.sdk.forkSession(sessionId, opts));
    } catch (error) {
      return err({
        message: error instanceof Error ? error.message : "会話の分岐に失敗しました。",
      });
    }
  }
  async complete(params: CompleteParams) {
    let run: QueryLike | undefined;
    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    const controller = new AbortController();
    const abort = () => controller.abort(params.signal?.reason);
    params.signal?.addEventListener("abort", abort, { once: true });
    try {
      params.signal?.throwIfAborted();
      run = this.sdk.query({
        prompt: params.prompt,
        options: {
          model: params.model,
          systemPrompt: params.system,
          title: params.title,
          tools: [],
          settingSources: [],
          persistSession: false,
          maxTurns: 1,
          effort: "low",
          sessionId: randomUUID(),
          ...(params.signal ? { abortController: controller } : {}),
          spawnClaudeCodeProcess: this.spawnProcess,
        },
      });
      for await (const raw of run)
        for (const output of mapSdkMessage(raw)) {
          if (output.kind === "assistant_text") text = output.text;
          if (output.kind === "turn_end") {
            if (output.subtype !== "success") {
              const failure = z.object({ errors: z.array(z.string()).optional() }).safeParse(raw);
              return err({
                message:
                  failure.success && failure.data.errors?.length
                    ? failure.data.errors.join("\n")
                    : "AI の要約に失敗しました。",
              });
            }
            inputTokens = output.usage.inputTokens;
            outputTokens = output.usage.outputTokens;
          }
        }
      return ok({ text, inputTokens, outputTokens });
    } catch (error) {
      return err({ message: error instanceof Error ? error.message : "AI の要約に失敗しました。" });
    } finally {
      params.signal?.removeEventListener("abort", abort);
      run?.close();
    }
  }
}
