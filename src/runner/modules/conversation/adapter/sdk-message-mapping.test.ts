import { describe, expect, it } from "vite-plus/test";
import { mapSdkMessage } from "./sdk-message-mapping";
import { outputEvents, toolResultEvents } from "../domain/event-mapping";
import { classifyStop } from "../domain/stop-reason";

const usage = {
  input_tokens: 10,
  output_tokens: 20,
  cache_creation_input_tokens: 30,
  cache_read_input_tokens: 40,
};

describe("SDK の出力の変換", () => {
  it.each(
    [
      "MCP result",
      [{ type: "text", text: "MCP result" }],
      { content: [{ type: "text", text: "Agent result" }], totalTokens: 10 },
      { type: "update", filePath: "invalid", structuredPatch: "unknown" },
      { type: "unknown", filePath: "a.ts", structuredPatch: [] },
      { structuredPatch: [] },
    ].map((value) => [value]),
  )("ツール固有の結果 %j があっても正常な tool_result を残す", (toolResult) => {
    expect(
      mapSdkMessage({
        type: "user",
        uuid: "mcp",
        tool_use_result: toolResult,
        message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "saved" }] },
      }),
    ).toEqual([
      {
        kind: "tool_result",
        uuid: "mcp:result:0",
        toolUseId: "tool",
        isError: false,
        content: "saved",
        images: [],
        omittedImages: 0,
        diff: null,
        parentToolUseId: null,
      },
    ]);
  });

  it("画像を含む結果は文字のブロックだけを本文にし、base64 の対象の形式の画像だけを取り出して、ほかの画像を数える", () => {
    const png = Buffer.from("png-bytes");
    expect(
      mapSdkMessage({
        type: "user",
        uuid: "shot",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool",
              content: [
                { type: "text", text: "Took a screenshot." },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: png.toString("base64") },
                },
                { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/bmp", data: "Qk0=" },
                },
                { type: "text", text: "Saved." },
              ],
            },
          ],
        },
      }),
    ).toEqual([
      {
        kind: "tool_result",
        uuid: "shot:result:0",
        toolUseId: "tool",
        isError: false,
        content: "Took a screenshot.\nSaved.",
        images: [{ mediaType: "image/png", data: png }],
        omittedImages: 2,
        diff: null,
        parentToolUseId: null,
      },
    ]);
  });

  it("画像を含まない配列の結果は、配列を JSON の文字にしたまま残す", () => {
    const content = [{ type: "text", text: '{"issue":{"number":43}}' }];
    expect(
      mapSdkMessage({
        type: "user",
        uuid: "mcp",
        message: { content: [{ type: "tool_result", tool_use_id: "tool", content }] },
      }),
    ).toEqual([
      {
        kind: "tool_result",
        uuid: "mcp:result:0",
        toolUseId: "tool",
        isError: false,
        content: JSON.stringify(content),
        images: [],
        omittedImages: 0,
        diff: null,
        parentToolUseId: null,
      },
    ]);
  });

  it.each(["edit", "update"] as const)("%s の差分を全hunk合計5000行で切る", (change) => {
    for (const count of [4999, 5000, 5001])
      for (const parts of [[count], [3000, count - 3000]]) {
        const hunks = parts.map((length, index) => ({
          old_start: index + 1,
          old_lines: length,
          new_start: index + 1,
          new_lines: length,
          lines: Array.from({ length }, (_, line) => `+${index}:${line}`),
        }));
        const expectedHunks =
          parts.length === 1
            ? [{ ...hunks[0], lines: hunks[0].lines.slice(0, 5000) }]
            : [hunks[0], { ...hunks[1], lines: hunks[1].lines.slice(0, 2000) }];
        const output = outputEvents({
          kind: "tool_result",
          uuid: "r",
          toolUseId: "t",
          isError: false,
          content: "ok",
          images: [],
          omittedImages: 0,
          parentToolUseId: null,
          diff: { path: "a.ts", change, hunks },
        });
        expect(output).toEqual([
          {
            type: "tool_result",
            sdkUuid: "r",
            payload: {
              tool_use_id: "t",
              is_error: false,
              content: "ok",
              bytes: 2,
              truncated: false,
            },
          },
          {
            type: "diff",
            sdkUuid: "r:diff",
            payload: {
              tool_use_id: "t",
              path: "a.ts",
              change,
              hunks: expectedHunks,
              truncated: count > 5000,
            },
          },
        ]);
      }
    const first = {
      old_start: 1,
      old_lines: 5001,
      new_start: 1,
      new_lines: 5001,
      lines: Array.from({ length: 5001 }, () => "+x"),
    };
    expect(
      outputEvents({
        kind: "tool_result",
        uuid: "r",
        toolUseId: "t",
        isError: false,
        content: "ok",
        images: [],
        omittedImages: 0,
        parentToolUseId: null,
        diff: { path: "a.ts", change, hunks: [first, { ...first, lines: ["+later"] }] },
      }),
    ).toEqual([
      {
        type: "tool_result",
        sdkUuid: "r",
        payload: { tool_use_id: "t", is_error: false, content: "ok", bytes: 2, truncated: false },
      },
      {
        type: "diff",
        sdkUuid: "r:diff",
        payload: {
          tool_use_id: "t",
          path: "a.ts",
          change,
          hunks: [{ ...first, lines: first.lines.slice(0, 5000) }],
          truncated: true,
        },
      },
    ]);
  });
  it("発言・ツール・サブエージェントの発言・番の終わりを順に写す", () => {
    expect(
      mapSdkMessage({
        type: "assistant",
        uuid: "a",
        parent_tool_use_id: "parent",
        message: {
          content: [
            { type: "text", text: "実行します" },
            { type: "tool_use", id: "t", name: "Edit", input: { file_path: "a.ts" } },
          ],
        },
      }),
    ).toEqual([
      { kind: "assistant_text", uuid: "a:text:0", text: "実行します", parentToolUseId: "parent" },
      {
        kind: "tool_use",
        uuid: "a:tool:1",
        toolUseId: "t",
        name: "Edit",
        input: { file_path: "a.ts" },
        parentToolUseId: "parent",
      },
    ]);
    expect(
      mapSdkMessage({
        type: "result",
        subtype: "success",
        usage,
        total_cost_usd: 0.12,
        duration_ms: 123,
        permission_denials: [{ tool: "Bash" }],
      }),
    ).toEqual([
      {
        kind: "turn_end",
        subtype: "success",
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheCreationInputTokens: 30,
          cacheReadInputTokens: 40,
        },
        costUsd: 0.12,
        durationMs: 123,
        permissionDenials: 1,
        terminalReason: null,
      },
    ]);
    expect(mapSdkMessage({ type: "unknown" })).toEqual([]);
  });

  it.each(["edit", "update", "create"])(
    "%s のツール結果を差分とともに保存用の形へ写す",
    (change) => {
      const source = {
        type: "user",
        uuid: "r",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t", content: "ok", is_error: false }],
        },
        tool_use_result: {
          type: change,
          filePath: "a.ts",
          content: "new",
          structuredPatch: [
            { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] },
          ],
        },
      };
      const output = mapSdkMessage(source);
      expect(output.flatMap(outputEvents)).toEqual([
        {
          type: "tool_result",
          sdkUuid: "r:result:0",
          payload: { tool_use_id: "t", is_error: false, content: "ok", truncated: false, bytes: 2 },
        },
        {
          type: "diff",
          sdkUuid: "r:result:0:diff",
          payload: {
            tool_use_id: "t",
            path: "a.ts",
            change,
            hunks:
              change === "create"
                ? []
                : [
                    {
                      old_start: 1,
                      old_lines: 1,
                      new_start: 1,
                      new_lines: 1,
                      lines: ["-old", "+new"],
                    },
                  ],
            ...(change === "create" ? { content: "new" } : {}),
            truncated: false,
          },
        },
      ]);
    },
  );

  it("大きいツール結果・入力・差分を UTF-8 と行の上限で切る", () => {
    const result = outputEvents({
      kind: "tool_result",
      uuid: "r",
      toolUseId: "t",
      isError: false,
      content: "あ".repeat(30000),
      images: [],
      omittedImages: 0,
      parentToolUseId: null,
      diff: {
        path: "new",
        change: "create",
        hunks: [],
        content: Array.from({ length: 5001 }, () => "x").join("\n"),
      },
    });
    expect(result).toEqual([
      {
        type: "tool_result",
        sdkUuid: "r",
        payload: {
          tool_use_id: "t",
          is_error: false,
          content: "あ".repeat(21845),
          truncated: true,
          bytes: 90000,
        },
      },
      {
        type: "diff",
        sdkUuid: "r:diff",
        payload: {
          tool_use_id: "t",
          path: "new",
          change: "create",
          hunks: [],
          content: Array.from({ length: 5000 }, () => "x").join("\n"),
          truncated: true,
        },
      },
    ]);
    expect(
      outputEvents({
        kind: "tool_use",
        uuid: "u",
        toolUseId: "t",
        name: "Bash",
        input: { nested: ["a".repeat(16385)] },
        parentToolUseId: null,
      }),
    ).toEqual([
      {
        type: "tool_use",
        sdkUuid: "u",
        payload: {
          tool_use_id: "t",
          name: "Bash",
          input: { nested: ["a".repeat(16384)] },
          parent_tool_use_id: null,
        },
      },
    ]);
  });
});

describe("ツールの結果の画像の保存", () => {
  const megabytes5 = 5 * 1024 * 1024;
  const result = (images: { mediaType: string; data: Buffer }[], omittedImages = 0) =>
    ({
      kind: "tool_result",
      uuid: "r",
      toolUseId: "t",
      isError: false,
      content: "Took a screenshot.",
      images,
      omittedImages,
      diff: null,
      parentToolUseId: null,
    }) as const;
  const saved = () => {
    const calls: { mediaType: string; bytes: number }[] = [];
    return {
      calls,
      save: (image: { mediaType: string; data: Buffer }) => {
        calls.push({ mediaType: image.mediaType, bytes: image.data.length });
        return `img-${calls.length}`;
      },
    };
  };
  const payload = (extra: object) => ({
    type: "tool_result",
    sdkUuid: "r",
    payload: {
      tool_use_id: "t",
      is_error: false,
      content: "Took a screenshot.",
      truncated: false,
      bytes: 18,
      ...extra,
    },
  });

  it.each([
    { name: "ちょうど 5 MB の画像は保存する", bytes: megabytes5, kept: true },
    { name: "5 MB を 1 バイト超える画像は保存しない", bytes: megabytes5 + 1, kept: false },
  ])("$name", ({ bytes, kept }) => {
    const target = saved();
    expect(
      toolResultEvents(
        result([{ mediaType: "image/png", data: Buffer.alloc(bytes) }]),
        target.save,
      ),
    ).toEqual([
      payload(
        kept ? { images: [{ id: "img-1", media_type: "image/png" }] } : { omitted_images: 1 },
      ),
    ]);
    expect(target.calls).toEqual(kept ? [{ mediaType: "image/png", bytes }] : []);
  });

  it("20 枚目までを保存し、21 枚目からは保存せずに数える", () => {
    const target = saved();
    const images = Array.from({ length: 21 }, () => ({
      mediaType: "image/webp",
      data: Buffer.from("x"),
    }));
    expect(toolResultEvents(result(images), target.save)).toEqual([
      payload({
        images: Array.from({ length: 20 }, (_, index) => ({
          id: `img-${index + 1}`,
          media_type: "image/webp",
        })),
        omitted_images: 1,
      }),
    ]);
  });

  it("書き込めなかった画像と、取り出せなかった画像を保存できなかった数に足す", () => {
    expect(
      toolResultEvents(
        result(
          [
            { mediaType: "image/png", data: Buffer.from("a") },
            { mediaType: "image/gif", data: Buffer.from("b") },
          ],
          2,
        ),
        (image) => (image.mediaType === "image/png" ? null : "gif-id"),
      ),
    ).toEqual([
      payload({ images: [{ id: "gif-id", media_type: "image/gif" }], omitted_images: 3 }),
    ]);
  });
});

describe("停止理由", () => {
  it.each([
    ["rejected", null, null, "usage_limit", "usage_limited"],
    ["rejected", null, "credits_required", "credits_required", "failed"],
    ["rejected", "allowed", null, null, "idle"],
    ["rejected", "allowed_warning", null, null, "idle"],
    ["allowed", null, null, null, "idle"],
  ] as const)(
    "利用枠 %s と超過分 %s とエラー %s を判定する",
    (status, overageStatus, errorCode, reason, state) => {
      expect(
        classifyStop(
          { subtype: "success", terminalReason: null },
          { kind: "rate_limit", status, overageStatus, errorCode, resetsAt: 123, raw: {} },
          null,
          null,
        ),
      ).toEqual({
        state,
        stopped:
          reason === null
            ? null
            : { reason, ...(reason === "usage_limit" ? { resets_at: 123000 } : {}) },
      });
    },
  );
});

it("init・逐次出力・利用枠とバックグラウンドの見本を写す", () => {
  expect(
    mapSdkMessage({
      type: "system",
      subtype: "init",
      session_id: "session",
      slash_commands: ["dev-spec"],
      skills: ["dev-spec", "test"],
    }),
  ).toEqual([
    {
      kind: "init",
      sessionId: "session",
      commands: [
        { name: "dev-spec", description: "" },
        { name: "test", description: "" },
      ],
    },
  ]);
  expect(
    mapSdkMessage({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "途中" } },
    }),
  ).toEqual([{ kind: "text_delta", text: "途中", parentToolUseId: null }]);
  expect(
    mapSdkMessage({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "one" }, { task_id: "two" }],
    }),
  ).toEqual([
    { kind: "background_task", taskId: "one", running: true },
    { kind: "background_task", taskId: "two", running: true },
  ]);
  const rate = {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "rejected",
      resetsAt: 123,
      overageStatus: "denied",
      errorCode: "credits_required",
    },
  };
  expect(mapSdkMessage(rate)).toEqual([
    {
      kind: "rate_limit",
      status: "rejected",
      resetsAt: 123,
      overageStatus: "denied",
      errorCode: "credits_required",
      raw: rate,
    },
  ]);
});

it.each([
  ["success", null, null, null, { state: "idle", stopped: null }],
  ["error_during_execution", null, null, "user", { state: "stopped", stopped: { reason: "user" } }],
  ["error_during_execution", null, null, "interrupt", { state: "working", stopped: null }],
  ["error_max_turns", null, null, null, { state: "failed", stopped: { reason: "error" } }],
  [
    "error_during_execution",
    "api_error",
    null,
    null,
    { state: "failed", stopped: { reason: "api_error" } },
  ],
  ["success", null, "overloaded", null, { state: "failed", stopped: { reason: "api_error" } }],
  ["success", null, "rate_limit", null, { state: "idle", stopped: null }],
] as const)(
  "番の終わり %s と API エラー %s と発言のエラー %s と停止 %s を判定する",
  (subtype, terminalReason, assistantError, intent, expected) => {
    expect(classifyStop({ subtype, terminalReason }, null, assistantError, intent)).toEqual(
      expected,
    );
  },
);

it("保存上限の直前に元からある置換文字を消さない", () => {
  const text = "a".repeat(65533) + "�";
  expect(
    outputEvents({
      kind: "tool_result",
      uuid: "r",
      toolUseId: "t",
      isError: false,
      content: text + "x",
      images: [],
      omittedImages: 0,
      parentToolUseId: null,
      diff: null,
    }),
  ).toEqual([
    {
      type: "tool_result",
      sdkUuid: "r",
      payload: { tool_use_id: "t", is_error: false, content: text, bytes: 65537, truncated: true },
    },
  ]);
});
