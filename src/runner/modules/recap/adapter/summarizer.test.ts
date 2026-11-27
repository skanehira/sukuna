import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../../../../shared/async-queue";
import { expect, it } from "vite-plus/test";
import { ClaudeAgentSdk } from "../../conversation/adapter/claude-agent-sdk";
import { createSummarizer } from "./summarizer";
import type { SummaryInput } from "../domain/summarizer-port";

const input: SummaryInput = {
  chapters: [],
  decisions: [],
  questions: [],
  entries: [{ number: 1, speaker: "developer", text: "営業時間を調べます" }],
};

it("要約を会話から独立した記録なしの Haiku 呼び出しで中断できる", async () => {
  let captured: Options | undefined;
  const source = new AbortController();
  let closed = false;
  const sdk = new ClaudeAgentSdk({
    query: ({ options }) => {
      captured = options;
      const messages = new AsyncQueue<unknown>();
      options?.abortController?.signal.addEventListener(
        "abort",
        () => {
          messages.push({
            type: "result",
            subtype: "error_during_execution",
            errors: ["中断した要約"],
          });
          messages.close();
        },
        { once: true },
      );
      return {
        [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
        interrupt: async () => {},
        stopTask: async () => {},
        supportedCommands: async () => [],
        close: () => {
          closed = true;
        },
      };
    },
    forkSession: async () => ({ sessionId: "unused" }),
  });
  const result = createSummarizer(sdk).summarize(input, source.signal);
  expect(captured).toMatchObject({
    model: "haiku",
    title: "会話の目次を更新",
    tools: [],
    settingSources: [],
    persistSession: false,
    maxTurns: 1,
    effort: "low",
  });
  source.abort();
  await expect(result).rejects.toThrow("中断した要約");
  expect(closed).toBe(true);
});
