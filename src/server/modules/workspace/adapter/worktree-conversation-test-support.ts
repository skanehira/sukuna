import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AsyncQueue } from "../../../../shared/async-queue";
import { ScriptedAgent } from "../../../../runner/modules/conversation/adapter/scripted-agent";
import {
  ClaudeAgentSdk,
  type SdkApi,
} from "../../../../runner/modules/conversation/adapter/claude-agent-sdk";
import type {
  AgentPort,
  OpenParams,
} from "../../../../runner/modules/conversation/domain/agent-port";
import type { Clock } from "../../../../runner/modules/conversation/domain/clock";

export class WorkspaceClock implements Clock {
  time = 1000;
  timers = new Map<number, { at: number; callback: () => void | Promise<void> }>();
  private next = 0;
  now = () => this.time;
  setTimeout(callback: () => void | Promise<void>, milliseconds: number): () => void {
    const id = ++this.next;
    this.timers.set(id, { at: this.time + milliseconds, callback });
    return () => {
      this.timers.delete(id);
    };
  }
  async advance(milliseconds: number): Promise<void> {
    this.time += milliseconds;
    for (const [id, timer] of this.timers) {
      if (timer.at <= this.time) {
        this.timers.delete(id);
        await timer.callback();
      }
    }
  }
}

export function createWorkspaceAgent(backend: "scripted" | "sdk") {
  const sdk: SdkApi = {
    query({ prompt, options }) {
      if (typeof prompt === "string" || !options?.cwd) throw new Error("会話の入力が必要です");
      const cwd = options.cwd;
      const output = new AsyncQueue<unknown>();
      output.push({
        type: "system",
        subtype: "init",
        session_id: options.resume ?? options.sessionId,
      });
      let held = false;
      let closed = false;
      const end = (subtype: string) => output.push({ type: "result", subtype });
      void (async () => {
        for await (const message of prompt) {
          if (closed) break;
          const content = message.message.content;
          const text = Array.isArray(content)
            ? content
                .flatMap((part) => (part.type === "text" && "text" in part ? [part.text] : []))
                .join("")
            : content;
          const result = spawnSync("/bin/pwd", [], { cwd, encoding: "utf8" });
          const toolId = randomUUID();
          output.push({
            type: "assistant",
            uuid: randomUUID(),
            message: {
              content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command: "pwd" } }],
            },
          });
          output.push({
            type: "user",
            uuid: randomUUID(),
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolId,
                  is_error: result.status !== 0,
                  content: result.stdout ?? result.error?.message ?? "",
                },
              ],
            },
          });
          if (text === "first-hold") held = true;
          else if (text === "first-usage") {
            output.push({
              type: "rate_limit_event",
              rate_limit_info: { status: "rejected", resetsAt: 10 },
            });
            end("error_during_execution");
          } else
            end(
              text === "first-failed" || result.status !== 0 ? "error_during_execution" : "success",
            );
        }
      })();
      return {
        [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
        interrupt: async () => {
          if (held) {
            held = false;
            end("error_during_execution");
          }
        },
        stopTask: async () => {},
        supportedCommands: async () => [],
        close: () => {
          closed = true;
          output.close();
        },
      };
    },
    forkSession: async () => ({ sessionId: randomUUID() }),
  };
  const delegate: AgentPort =
    backend === "sdk"
      ? new ClaudeAgentSdk(sdk)
      : new ScriptedAgent({
          rules: [
            { match: "^first-hold$", steps: [{ shell: "pwd" }, { hold: true }] },
            {
              match: "^first-failed$",
              steps: [{ shell: "pwd" }, { end: "error_during_execution" }],
            },
            {
              match: "^first-usage$",
              steps: [
                { shell: "pwd" },
                { rate_limit: { status: "rejected", resetsAt: 10 } },
                { end: "error_during_execution" },
              ],
            },
          ],
          fallback: [{ shell: "pwd" }, { end: "success" }],
        });
  const opened: OpenParams[] = [];
  const delivered: { text: string; images: { data: Buffer; mediaType: string }[] }[] = [];
  const closed: number[] = [];
  let beforeClose: ((finish: () => void) => void) | undefined;
  const agent: AgentPort & { opened: OpenParams[] } = {
    opened,
    fork: delegate.fork.bind(delegate),
    complete: delegate.complete.bind(delegate),
    open(params) {
      const index = opened.length;
      opened.push(params);
      const session = delegate.open(params);
      return {
        ...session,
        send(input) {
          delivered.push(input);
          session.send(input);
        },
        close() {
          closed.push(index);
          if (index === 0 && beforeClose) beforeClose(() => session.close());
          else session.close();
        },
      };
    },
  };
  return {
    agent,
    opened,
    delivered,
    closed,
    delayClose(callback: (finish: () => void) => void) {
      beforeClose = callback;
    },
  };
}
