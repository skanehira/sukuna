import { afterEach, expect, it } from "vite-plus/test";
import { ok } from "neverthrow";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
} from "../../../../shared/db/test-helpers";
import { startRunnerApp } from "../../../../runner/app";
import { ScriptedAgent } from "../../../../runner/modules/conversation/adapter/scripted-agent";
import { createApp } from "../../../app";
import { RunnerLink, runnerUnavailable } from "../../../runner-link";
import { incomingWith } from "../../identity/test-support";
import { createMessageRepository } from "./message-repository";
import { createProgressRepository } from "./progress-repository";
import { createTimelineFilePort } from "./timeline-file";
import { testEnvironment } from "../../../../test/directories";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  const agent = new ScriptedAgent({ rules: [], fallback: [{ text: "受信" }, { hold: true }] });
  const clock = { time: 1000, now: () => clock.time, setTimeout: () => () => {} };
  const runner = await startRunnerApp({
    database,
    agent,
    environment: testEnvironment(home),
    clock,
    log: () => {},
  });
  const calls: unknown[] = [];
  const link = new RunnerLink({
    socket: join(home, "runner.sock"),
    log: () => {},
    notice: () => {},
    connection: () => {},
  });
  const server = createApp({
    build: "test",
    messages: {
      runner: {
        call: (method, path, input) => {
          calls.push({ method, path, input });
          return link.call(method, path, input);
        },
      },
      repository: createMessageRepository(database.db),
    },
    progress: {
      repository: createProgressRepository(database.db),
      timeline: createTimelineFilePort({ configDir: home, sleep: async () => {} }),
    },
  });
  const id = (
    await runner.runtime.start({ projectId: "p", kind: "chat", title: "会話", cwd: home })
  )._unsafeUnwrap().conversationId;
  mkdirSync(join(home, "images", id), { recursive: true });
  writeFileSync(
    join(home, "images", id, "existing-image.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const request = async (input: unknown, address = "127.0.0.1") => {
    const response = await server.request(
      `/api/conversations/${id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
      incomingWith(address, 1234),
    );
    return { status: response.status, body: await response.json() };
  };
  cleanups.push(async () => {
    await runner.shutdown();
    database.close();
    removeTempHome(home);
  });
  return { home, database, agent, runner, server, id, request, calls, clock };
}
const input = {
  text: "タイムラインのタスク a「題名」について: 表示の本文\n",
  images: [],
  mode: "send",
  clientMessageId: "first",
  timeline_comments: [],
};

it("公開送信は入力名・由来・画像IDをIPCへ渡す", async () => {
  const f = await fixture();
  const comments = [{ task_id: "a", text: "  本文\n" }];
  expect(
    await f.request({
      ...input,
      origin: "flow",
      images: ["existing-image"],
      timeline_comments: comments,
    }),
  ).toEqual({ status: 202, body: { result: "delivered", queueItem: null } });
  expect(f.calls).toEqual([
    {
      method: "POST",
      path: `/conversations/${f.id}/messages`,
      input: {
        text: input.text,
        images: ["existing-image"],
        interrupt: false,
        client_id: "first",
        origin: "developer",
        timeline_comments: comments,
      },
    },
  ]);
  expect(
    f.runner.runtime.store
      .events(f.id)
      .filter((event) => event.type === "user_message")
      .map((event) => event.payload),
  ).toEqual([
    {
      text: input.text,
      images: [{ path: `images/${f.id}/existing-image.png`, media_type: "image/png" }],
      origin: "developer",
      timeline_comments: comments,
      client_ids: ["first"],
      queued_ids: [],
      client_receipts: [{ client_id: "first", result: "delivered", received_at: 1000 }],
    },
  ]);
});

it("公開送信は空配列だけのキューと割り込みを配達し、再送時にも旧相談へ戻さない", async () => {
  const f = await fixture();
  expect(await f.request(input)).toEqual({
    status: 202,
    body: { result: "delivered", queueItem: null },
  });
  const queued = await f.request({ ...input, clientMessageId: "second" });
  const item = f.runner.runtime.store.queue(f.id)[0]!;
  expect(queued).toEqual({
    status: 202,
    body: {
      result: "queued",
      queueItem: {
        id: item.id,
        text: input.text,
        images: [],
        position: 1,
        stockItemId: null,
        clientId: "second",
        createdAt: 1000,
        timeline_comments: [],
      },
    },
  });
  expect(await f.request({ ...input, mode: "interrupt", clientMessageId: "third" })).toEqual({
    status: 202,
    body: { result: "delivered", queueItem: null },
  });
  expect(await f.request({ ...input, clientMessageId: "second" })).toEqual({
    status: 202,
    body: { result: "queued", queueItem: null },
  });
  const sessionId = f.runner.runtime.store.get(f.id)!.sessionId;
  mkdirSync(join(f.home, "timeline/sessions"), { recursive: true });
  writeFileSync(
    join(f.home, `timeline/sessions/${sessionId}.json`),
    JSON.stringify({
      version: 1,
      reports: [],
      journal: [{ at: 1, toolUseId: "plan", ops: [{ op: "add", id: "a", title: "題名" }] }],
    }),
  );
  const response = await f.server.request(
    `/api/conversations/${f.id}/progress`,
    {},
    incomingWith("127.0.0.1", 1234),
  );
  const progress = (await response.json()) as {
    timeline: { comments: unknown[]; unresolvedComments: unknown[] };
  };
  expect({
    sent: f.agent.sent.map((message) => message.text),
    queue: f.runner.runtime.store.queue(f.id),
    comments: progress.timeline.comments,
    unresolvedComments: progress.timeline.unresolvedComments,
    saved: f.runner.runtime.store.events(f.id).flatMap((event) =>
      event.type === "user_message"
        ? [
            {
              origin: event.payload.origin,
              comments: event.payload.timeline_comments,
              legacy: event.payload.timeline_legacy_texts,
            },
          ]
        : [],
    ),
  }).toEqual({
    sent: [input.text, `${input.text}\n\n${input.text}`],
    queue: [],
    comments: [],
    unresolvedComments: [],
    saved: [
      { origin: "developer", comments: [], legacy: undefined },
      { origin: "interrupt", comments: [], legacy: undefined },
    ],
  });
});

it.each([
  { timeline_comments: null },
  { timeline_comments: {} },
  { timeline_comments: [{ task_id: 1, text: "本文" }] },
  { mode: "other" },
  { clientMessageId: "" },
  { images: Array.from({ length: 21 }, () => "image") },
])("公開送信の不正な入力 %j は400で保存しない", async (invalid) => {
  const f = await fixture();
  expect({
    response: await f.request({ ...input, ...invalid }),
    calls: f.calls,
    events: f.runner.runtime.store.events(f.id),
    queue: f.runner.runtime.store.queue(f.id),
  }).toEqual({
    response: {
      status: 400,
      body: { error: { code: "invalid_input", message: "入力を確認してください。" } },
    },
    calls: [],
    events: [],
    queue: [],
  });
});

it("ランナー切断後の公開送信は503と未配達を返す", async () => {
  const f = await fixture();
  await f.runner.shutdown();
  expect({ response: await f.request(input), events: f.runner.runtime.store.events(f.id) }).toEqual(
    { response: { status: 503, body: { error: runnerUnavailable } }, events: [] },
  );
});

function stateOf(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    events: f.runner.runtime.store.events(f.id),
    queue: f.runner.runtime.store.queue(f.id),
    runState: f.runner.runtime.store.get(f.id)!.runState,
    sent: f.agent.sent.map((message) => message.text),
    opened: f.agent.opened.length,
  };
}
it.each(["send", "interrupt"])(
  "作業中の空入力を預けるか割り込みで届けた後も初回結果を返す: mode=%s",
  async (mode) => {
    const f = await fixture();
    await f.request(input);
    await f.request({ ...input, text: "預かった指示", clientMessageId: "pending" });
    const empty = { ...input, text: "", mode, clientMessageId: "empty-active" };
    const first = await f.request(empty);
    if (mode === "send") {
      const item = f.runner.runtime.store
        .queue(f.id)
        .find((entry) => entry.clientId === "empty-active")!;
      expect(first).toEqual({
        status: 202,
        body: {
          result: "queued",
          queueItem: {
            id: item.id,
            text: "",
            images: [],
            position: 2,
            stockItemId: null,
            clientId: "empty-active",
            createdAt: 1000,
            timeline_comments: [],
          },
        },
      });
      await f.runner.runtime.stop(f.id);
      await f.runner.runtime.deliverQueue(f.id);
    } else expect(first).toEqual({ status: 202, body: { result: "delivered", queueItem: null } });
    expect({
      sent: f.agent.sent.map((message) => message.text),
      queue: f.runner.runtime.store.queue(f.id),
    }).toEqual({ sent: [input.text, "預かった指示"], queue: [] });
    const before = stateOf(f);
    expect({ response: await f.request(empty), after: stateOf(f) }).toEqual({
      response: {
        status: 202,
        body: { result: mode === "send" ? "queued" : "delivered", queueItem: null },
      },
      after: before,
    });
  },
);
it.each(
  ["send", "interrupt"].flatMap((mode) =>
    [0, 599999, 600000, 600001].flatMap((elapsed) =>
      [false, true].map((queueRemains) => ({ mode, elapsed, queueRemains })),
    ),
  ),
)(
  "空入力を配達後に再送する: mode=$mode elapsed=$elapsed queue=$queueRemains",
  async ({ mode, elapsed, queueRemains }) => {
    const f = await fixture();
    await f.request(input);
    await f.request({ ...input, text: "預かった指示", clientMessageId: "queued" });
    await f.runner.runtime.stop(f.id);
    const empty = { ...input, text: "", mode, clientMessageId: "empty-replay" };
    expect(await f.request(empty)).toEqual({
      status: 202,
      body: { result: "delivered", queueItem: null },
    });
    expect({
      sent: f.agent.sent.map((message) => message.text),
      queue: f.runner.runtime.store.queue(f.id),
      messages: f.runner.runtime.store.events(f.id).filter((event) => event.type === "user_message")
        .length,
    }).toEqual({ sent: [input.text, "預かった指示"], queue: [], messages: 2 });
    if (queueRemains)
      await f.request({ ...input, text: "残っている指示", clientMessageId: "tail" });
    f.clock.time += elapsed;
    const before = stateOf(f);
    const responses = await Promise.all([f.request(empty), f.request(empty)]);
    if (elapsed <= 600000) {
      expect({ responses, after: stateOf(f) }).toEqual({
        responses: [
          { status: 202, body: { result: "delivered", queueItem: null } },
          { status: 202, body: { result: "delivered", queueItem: null } },
        ],
        after: before,
      });
    } else if (!queueRemains) {
      expect({ responses, after: stateOf(f) }).toEqual({
        responses: [
          {
            status: 400,
            body: { error: { code: "invalid_input", message: "入力を確認してください。" } },
          },
          {
            status: 400,
            body: { error: { code: "invalid_input", message: "入力を確認してください。" } },
          },
        ],
        after: before,
      });
    } else {
      const newQueue = f.runner.runtime.store.queue(f.id);
      const item = newQueue.find((entry) => entry.clientId === "empty-replay")!;
      const result =
        mode === "interrupt"
          ? { result: "delivered", queueItem: null }
          : {
              result: "queued",
              queueItem: {
                id: item.id,
                text: "",
                images: [],
                position: 2,
                stockItemId: null,
                clientId: "empty-replay",
                createdAt: 601001,
                timeline_comments: [],
              },
            };
      expect({
        responses,
        sent: f.agent.sent.map((message) => message.text),
        queued: newQueue.length,
        messages: f.runner.runtime.store
          .events(f.id)
          .filter((event) => event.type === "user_message").length,
      }).toEqual({
        responses: [
          { status: 202, body: result },
          { status: 202, body: result },
        ],
        sent:
          mode === "interrupt"
            ? [input.text, "預かった指示", "残っている指示"]
            : [input.text, "預かった指示"],
        queued: mode === "interrupt" ? 0 : 2,
        messages: mode === "interrupt" ? 3 : 2,
      });
    }
  },
);
it.each(
  ["send", "interrupt"].flatMap((mode) => [false, true].map((working) => ({ mode, working }))),
)(
  "初回の空入力は400で実行・キュー・受付記録を変えない: mode=$mode working=$working",
  async ({ mode, working }) => {
    const f = await fixture();
    if (working) await f.request(input);
    const before = stateOf(f);
    expect({
      response: await f.request({ ...input, text: "", mode, clientMessageId: "empty-first" }),
      after: stateOf(f),
    }).toEqual({
      response: {
        status: 400,
        body: { error: { code: "invalid_input", message: "入力を確認してください。" } },
      },
      after: before,
    });
  },
);

it("本文が空でも画像IDのある入力は配達する", async () => {
  const f = await fixture();
  expect(await f.request({ ...input, text: "", images: ["existing-image"] })).toEqual({
    status: 202,
    body: { result: "delivered", queueItem: null },
  });
});
it("IPCが成功状態で壊れた受付結果を返したら500にする", async () => {
  const f = await fixture();
  const server = createApp({
    build: "test",
    messages: {
      runner: { call: async () => ok({ status: 200, body: { result: "queued" } }) },
      repository: createMessageRepository(f.database.db),
    },
  });
  const response = await server.request(
    `/api/conversations/${f.id}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    incomingWith("127.0.0.1", 1234),
  );
  expect({ status: response.status, body: await response.json() }).toEqual({
    status: 500,
    body: {
      error: {
        code: "internal",
        message: "指示の受付結果を取得できませんでした。もう一度操作してください。",
      },
    },
  });
});
it("構造化情報のない既存キューは情報省略のまま公開する", async () => {
  const f = await fixture();
  await f.request({ ...input, clientMessageId: "start" });
  const { timeline_comments: _comments, ...legacy } = { ...input, clientMessageId: "legacy" };
  const result = await f.request(legacy);
  expect(result.status).toBe(202);
  const queue = f.runner.runtime.store.queue(f.id)[0]!;
  expect(result.body).toEqual({
    result: "queued",
    queueItem: {
      id: queue.id,
      text: input.text,
      images: [],
      position: 1,
      stockItemId: null,
      clientId: "legacy",
      createdAt: f.clock.time,
    },
  });
});
