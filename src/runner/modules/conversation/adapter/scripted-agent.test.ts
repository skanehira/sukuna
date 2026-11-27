import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedAgent } from "./scripted-agent";
import type { OpenParams, AgentOutput } from "../domain/agent-port";
const params: OpenParams = {
  sessionId: "session",
  resume: false,
  cwd: "/tmp",
  model: null,
  permissionMode: "bypassPermissions",
  appendSystemPrompt: "",
  appTools: [],
  context: { conversationId: "c", projectId: "p", issueId: null },
  onQuestion: () => Promise.resolve({}),
  onPermission: () => Promise.resolve({ behavior: "allow" }),
};

async function turn(iterator: AsyncIterator<AgentOutput>): Promise<AgentOutput[]> {
  const outputs: AgentOutput[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) throw new Error("番の終わりがありません");
    outputs.push(next.value);
    if (next.value.kind === "turn_end") return outputs;
  }
}

describe("台本型の AI", () => {
  it("最初に一致した規則・fallback・停止・1 回きりの呼び出しで台本を使う", async () => {
    const agent = new ScriptedAgent({
      rules: [
        { match: "^hi", steps: [{ text: "hello" }, { end: "success" }] },
        { match: "hi", steps: [{ text: "wrong" }] },
      ],
      fallback: [{ hold: true }],
      completions: [{ purpose: "recap", match: "memo", text: "summary" }],
    });
    const session = agent.open(params);
    const iterator = session.output[Symbol.asyncIterator]();
    session.send({ text: "hi", images: [] });
    const outputs = await turn(iterator);
    expect(outputs.map((o) => o.kind)).toEqual([
      "init",
      "text_delta",
      "assistant_text",
      "turn_end",
    ]);
    session.send({ text: "other", images: [] });
    await session.interrupt();
    expect((await turn(iterator)).map((o) => (o.kind === "turn_end" ? o.subtype : o.kind))).toEqual(
      ["error_during_execution"],
    );
    expect(
      await agent.complete({
        model: "haiku",
        prompt: "memo",
        system: "",
        purpose: "recap",
        title: "要約",
      }),
    ).toEqual({ value: { text: "summary", inputTokens: 0, outputTokens: 0 } });
    session.close();
  });

  it("アプリのツールを実行し、shell を会話の作業ディレクトリで実行する", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sukuna-script-")));
    const contexts: unknown[] = [];
    const agent = new ScriptedAgent({
      rules: [],
      fallback: [
        { tool: "mcp__sukuna__report", input: { done: true }, result: "unused" },
        { shell: "printf '%s' \"$PWD\"; exit 7" },
        { end: "success" },
      ],
    });
    const session = agent.open({
      ...params,
      cwd: dir,
      appTools: [
        {
          name: "report",
          description: "report",
          input: {},
          alwaysLoad: true,
          handler: (input, ctx) => {
            contexts.push({ input, ctx });
            return Promise.resolve({ text: "reported", isError: false });
          },
        },
      ],
    });
    try {
      session.send({ text: "run", images: [] });
      const outputs = await turn(session.output[Symbol.asyncIterator]());
      expect(
        outputs.flatMap((o) =>
          o.kind === "tool_result" ? [{ content: o.content, isError: o.isError }] : [],
        ),
      ).toEqual([
        { content: "reported", isError: false },
        { content: dir, isError: true },
      ]);
      expect(contexts).toEqual([{ input: { done: true }, ctx: params.context }]);
    } finally {
      session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it("台本の連続出力を指定回数だけ送り、停止した場合は残りを送らない", async () => {
  const agent = new ScriptedAgent({
    rules: [],
    fallback: [{ stream: { prefix: "出力 ", count: 3, interval_ms: 2 } }, { end: "success" }],
  });
  const session = agent.open(params);
  const output = session.output[Symbol.asyncIterator]();
  try {
    session.send({ text: "run", images: [] });
    expect(
      (await turn(output)).flatMap((event) =>
        event.kind === "assistant_text" ? [event.text] : [],
      ),
    ).toEqual(["出力 1", "出力 2", "出力 3"]);

    session.send({ text: "cancel", images: [] });
    await session.interrupt();
    expect((await turn(output)).map((event) => event.kind)).toEqual(["turn_end"]);
  } finally {
    session.close();
  }
});
