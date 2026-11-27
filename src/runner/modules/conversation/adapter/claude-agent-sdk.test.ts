import { expect, it } from "vite-plus/test";
import { ClaudeAgentSdk, type QueryLike } from "./claude-agent-sdk";
import { AsyncQueue } from "../../../../shared/async-queue";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { OpenParams } from "../domain/agent-port";

it.each(["success", "startup", "stream", "result"] as const)(
  "complete の %s をResultで返し作成済み実行を閉じる",
  async (mode) => {
    let closed = 0;
    const sdk = new ClaudeAgentSdk({
      query: () => {
        if (mode === "startup") throw new Error("起動失敗");
        return {
          async *[Symbol.asyncIterator]() {
            if (mode === "stream") throw new Error("受信失敗");
            yield {
              type: "assistant",
              uuid: "a",
              message: { content: [{ type: "text", text: "要約" }] },
            };
            yield {
              type: "result",
              subtype: mode === "result" ? "error_during_execution" : "success",
              usage: { input_tokens: 12, output_tokens: 34 },
              errors: ["API失敗"],
            };
          },
          interrupt: () => Promise.resolve(),
          stopTask: () => Promise.resolve(),
          supportedCommands: () => Promise.resolve([]),
          close: () => {
            closed++;
          },
        };
      },
      forkSession: () => Promise.resolve({ sessionId: "fork" }),
    });
    const result = await sdk.complete({
      purpose: "summary",
      model: "haiku",
      prompt: "要約して",
      system: "system",
      title: "題名",
    });
    expect({ result: result.isOk() ? result.value : result.error, closed }).toEqual({
      result:
        mode === "success"
          ? { text: "要約", inputTokens: 12, outputTokens: 34 }
          : {
              message: mode === "startup" ? "起動失敗" : mode === "stream" ? "受信失敗" : "API失敗",
            },
      closed: mode === "startup" ? 0 : 1,
    });
  },
);

it("SDK の実行で再開設定と保存期間を渡し、入力・質問・許可・バックグラウンド停止を通す", async () => {
  const captured: { prompt?: AsyncIterable<SDKUserMessage>; options?: Options } = {};
  const messages = new AsyncQueue<unknown>();
  const actions: string[] = [];
  const requests: unknown[] = [];
  const query: QueryLike = {
    [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
    interrupt: () => {
      actions.push("interrupt");
      return Promise.resolve();
    },
    stopTask: (id) => {
      actions.push(id);
      return Promise.resolve();
    },
    supportedCommands: () => Promise.resolve([{ name: "dev-spec", description: "設計" }]),
    close: () => messages.close(),
  };
  const sdk = new ClaudeAgentSdk({
    query: (args) => {
      captured.prompt = args.prompt as AsyncIterable<SDKUserMessage>;
      captured.options = args.options;
      return query;
    },
    forkSession: () => Promise.resolve({ sessionId: "fork" }),
  });
  const params: OpenParams = {
    sessionId: "session",
    resume: true,
    cwd: "/repo",
    model: null,
    permissionMode: "bypassPermissions",
    appendSystemPrompt: "追加",
    additionalDirectories: ["/project"],
    appTools: [],
    context: { conversationId: "c", projectId: "p", issueId: null },
    onQuestion: () => Promise.resolve({ 方針: "A" }),
    onPermission: (request) => {
      requests.push(request);
      return Promise.resolve({ behavior: "deny", message: "不要" });
    },
  };
  const session = sdk.open(params);
  session.send({ text: "hello", images: [] });
  expect(await captured.prompt?.[Symbol.asyncIterator]().next()).toEqual({
    done: false,
    value: {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
      parent_tool_use_id: null,
      session_id: "session",
      origin: { kind: "human" },
    },
  });
  expect({
    resume: captured.options?.resume,
    cwd: captured.options?.cwd,
    additionalDirectories: captured.options?.additionalDirectories,
    settings: captured.options?.settings,
    settingSources: captured.options?.settingSources,
    systemPrompt: captured.options?.systemPrompt,
  }).toEqual({
    resume: "session",
    cwd: "/repo",
    additionalDirectories: ["/project"],
    settings: { cleanupPeriodDays: 36500 },
    settingSources: undefined,
    systemPrompt: { type: "preset", preset: "claude_code", append: "追加" },
  });
  const canUseTool = captured.options?.canUseTool;
  if (!canUseTool) throw new Error("許可の受け口なし");
  const requestOptions = {
    signal: new AbortController().signal,
    toolUseID: "request",
    requestId: "request",
  };
  expect(
    await canUseTool(
      "AskUserQuestion",
      { questions: [{ question: "方針", header: "方針", options: [], multiSelect: false }] },
      requestOptions,
    ),
  ).toEqual({
    behavior: "allow",
    updatedInput: {
      questions: [{ question: "方針", header: "方針", options: [], multiSelect: false }],
      answers: { 方針: "A" },
    },
  });
  expect(
    await canUseTool(
      "Bash",
      { command: "ls" },
      {
        ...requestOptions,
        requestId: "control-id",
        title: "コマンドの実行",
        decisionReason: "確認のルール",
        blockedPath: "/repo",
      },
    ),
  ).toEqual({
    behavior: "deny",
    message: "不要",
  });
  expect(requests).toEqual([
    {
      requestId: "control-id",
      toolName: "Bash",
      input: { command: "ls" },
      title: "コマンドの実行",
      reason: "確認のルール",
      blockedPath: "/repo",
    },
  ]);
  messages.push({ type: "system", subtype: "task_started", task_id: "task" });
  messages.push({
    type: "assistant",
    uuid: "a",
    message: { content: [{ type: "text", text: "done" }] },
  });
  const iterator = session.output[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();
  await session.interrupt();
  expect(actions).toEqual(["interrupt", "task"]);
  expect(await session.commands()).toEqual([{ name: "dev-spec", description: "設計" }]);
  session.close();
});
