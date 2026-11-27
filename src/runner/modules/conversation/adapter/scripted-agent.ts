import { randomUUID } from "node:crypto";
import { ok } from "neverthrow";
import { agentScriptSchema, type AgentScript } from "../../../../shared/agent-script";
import { AsyncQueue } from "../../../../shared/async-queue";
import { runCommand } from "../../../../shared/command";
import type {
  AgentPort,
  AgentSession,
  AgentOutput,
  OpenParams,
  CompleteParams,
} from "../domain/agent-port";

export function turnEnd(subtype: string): Extract<AgentOutput, { kind: "turn_end" }> {
  return {
    kind: "turn_end",
    subtype,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    costUsd: 0,
    durationMs: 0,
    permissionDenials: 0,
    terminalReason: null,
  };
}
export class ScriptedAgent implements AgentPort {
  readonly opened: OpenParams[] = [];
  readonly receivedAnswers: { requestId: string; answers: Record<string, string> }[] = [];
  readonly permissionDecisions: {
    requestId: string;
    decision: import("../domain/agent-port").PermissionDecision;
  }[] = [];
  readonly sent: { sessionId: string; text: string }[] = [];
  private script: ReturnType<typeof agentScriptSchema.parse>;
  private uuid: () => string;
  constructor(script: AgentScript, uuid: () => string = randomUUID) {
    this.uuid = uuid;
    this.script = agentScriptSchema.parse(script);
  }
  fork(_sessionId: string, _opts: { dir: string }) {
    return Promise.resolve(ok({ sessionId: this.uuid() }));
  }
  complete(params: CompleteParams) {
    const completion = this.script.completions.find(
      (c) => c.purpose === params.purpose && new RegExp(c.match).test(params.prompt),
    );
    return Promise.resolve(ok({ text: completion?.text ?? "", inputTokens: 0, outputTokens: 0 }));
  }
  open(params: OpenParams): AgentSession {
    this.opened.push(params);
    const output = new AsyncQueue<AgentOutput>();
    output.push({ kind: "init", sessionId: params.sessionId, commands: [] });
    let cancelled = false;
    let release: (() => void) | null = null;
    let running = Promise.resolve();
    let shellAbort = new AbortController();
    const play = async (text: string) => {
      const steps = this.script.rules.find((r) => new RegExp(r.match).test(text))?.steps ??
        this.script.fallback ?? [{ end: "success" }];
      let ended = false;
      for (const step of steps) {
        if (cancelled) break;
        if ("text" in step) {
          output.push({ kind: "text_delta", text: step.text, parentToolUseId: null });
          output.push({
            kind: "assistant_text",
            uuid: this.uuid(),
            text: step.text,
            parentToolUseId: null,
          });
        }
        if ("tool" in step || "shell" in step) {
          const id = this.uuid();
          const name = "shell" in step ? "Bash" : step.tool;
          const input = "shell" in step ? { command: step.shell } : step.input;
          output.push({
            kind: "tool_use",
            uuid: this.uuid(),
            toolUseId: id,
            name,
            input,
            parentToolUseId: null,
          });
          let content = "";
          let isError = false;
          if ("shell" in step) {
            const result = await runCommand("/bin/sh", ["-c", step.shell], {
              cwd: params.cwd,
              signal: shellAbort.signal,
            });
            content = result.stdout + result.stderr;
            isError = result.exitCode !== 0;
          } else if (name.startsWith("mcp__sukuna__")) {
            const tool = params.appTools.find((t) => t.name === name.slice("mcp__sukuna__".length));
            if (!tool) {
              content = "ツールが登録されていません。";
              isError = true;
            } else {
              const result = await tool.handler(input, params.context);
              content = result.text;
              isError = result.isError;
            }
          } else content = step.result;
          output.push({
            kind: "tool_result",
            uuid: this.uuid(),
            toolUseId: id,
            isError,
            content,
            diff: "diff" in step ? (step.diff ?? null) : null,
            parentToolUseId: null,
          });
        }
        if ("ask" in step) {
          const requestId = this.uuid();
          this.receivedAnswers.push({
            requestId,
            answers: await params.onQuestion({ requestId, questions: step.ask }),
          });
        }
        if ("permission" in step) {
          const requestId = this.uuid();
          this.permissionDecisions.push({
            requestId,
            decision: await params.onPermission({
              requestId,
              toolName: step.permission.tool_name,
              input: step.permission.input,
            }),
          });
        }
        if ("hold" in step && !cancelled)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        if ("rate_limit" in step)
          output.push({
            kind: "rate_limit",
            ...step.rate_limit,
            resetsAt: step.rate_limit.resetsAt ?? null,
            overageStatus: step.rate_limit.overageStatus ?? null,
            errorCode: step.rate_limit.errorCode ?? null,
            raw: { rate_limit_info: step.rate_limit },
          });
        if ("end" in step) {
          output.push({ ...turnEnd(step.end), terminalReason: step.terminal_reason ?? null });
          ended = true;
          break;
        }
      }
      if (cancelled && !ended) output.push(turnEnd("error_during_execution"));
    };
    return {
      output,
      send: ({ text }) => {
        this.sent.push({ sessionId: params.sessionId, text });
        cancelled = false;
        shellAbort = new AbortController();
        running = play(text).catch(() => {
          output.push(turnEnd("error_during_execution"));
        });
      },
      interrupt: async () => {
        cancelled = true;
        shellAbort.abort();
        release?.();
        await running;
      },
      commands: () => Promise.resolve([]),
      close: () => {
        cancelled = true;
        shellAbort.abort();
        release?.();
        output.close();
      },
    };
  }
}
