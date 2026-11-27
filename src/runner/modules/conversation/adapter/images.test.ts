import { afterEach, expect, it } from "vite-plus/test";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AsyncQueue } from "../../../../shared/async-queue";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
} from "../../../../shared/db/test-helpers";
import { ok } from "neverthrow";
import { createLogger } from "../../../../shared/log";
import { readEnvironment } from "../../../../shared/env";
import { startRunnerApp } from "../../../app";
import { RunnerLink } from "../../../../server/runner-link";
import { createApp } from "../../../../server/app";
import { createMessageRepository } from "../../../../server/modules/conversation/adapter/message-repository";
import {
  createClockFake,
  createTailscaleFake,
  incomingWith,
} from "../../../../server/modules/identity/test-support";
import type { AgentOutput, AgentSession, OpenParams } from "../domain/agent-port";
import type { Clock } from "../domain/clock";
import { ScriptedAgent, turnEnd } from "./scripted-agent";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
  "base64",
);
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const fixtures = [
  { id: "01J00000000000000000000001", extension: "png", mediaType: "image/png", data: png },
  { id: "01J00000000000000000000002", extension: "gif", mediaType: "image/gif", data: gif },
  {
    id: "01J00000000000000000000003",
    extension: "jpg",
    mediaType: "image/jpeg",
    data: Buffer.from(
      "/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAyAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAGAQEBAAAAAAAAAAAAAAAAAAAGBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIsATX9//9k=",
      "base64",
    ),
  },
  {
    id: "01J00000000000000000000004",
    extension: "webp",
    mediaType: "image/webp",
    data: Buffer.from(
      "UklGRjgAAABXRUJQVlA4ICwAAACQAQCdASoCAAIAAgA0JaACdLoAA5gA/vmTb/+QH/+QH/+QH/8gP+IXeyAwAA==",
      "base64",
    ),
  },
];
class RecordingAgent extends ScriptedAgent {
  messages: { text: string; images: { data: Buffer; mediaType: string }[] }[] = [];
  outputs = new Map<string, AsyncQueue<AgentOutput>>();
  constructor() {
    super({ rules: [] });
  }
  override open(params: OpenParams): AgentSession {
    this.opened.push(params);
    const output = new AsyncQueue<AgentOutput>();
    this.outputs.set(params.context.conversationId, output);
    output.push({ kind: "init", sessionId: params.sessionId, commands: [] });
    return {
      output,
      send: (message) => {
        this.messages.push(message);
      },
      interrupt: async () => {
        output.push(turnEnd("error_during_execution"));
      },
      commands: async () => [],
      close: () => output.close(),
    };
  }
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(clock?: Clock) {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  const agent = new RecordingAgent();
  const notices: unknown[] = [];
  const logs: Record<string, unknown>[] = [];
  const runner = await startRunnerApp({
    database,
    agent,
    clock,
    environment: readEnvironment("runner", { SUKUNA_HOME: home }, home, () => true)._unsafeUnwrap(),
    log: createLogger({
      now: () => 1000,
      write: (line) => {
        logs.push(JSON.parse(line));
      },
      level: "info",
    }),
  });
  let connected = false;
  const link = new RunnerLink({
    socket: join(home, "runner.sock"),
    log: () => {},
    notice: (notice) => {
      if (notice.kind === "notice") notices.push(notice);
    },
    connection: (value) => {
      connected = value;
    },
  });
  link.start();
  await expect.poll(() => connected).toBe(true);
  const app = createApp({
    build: "test",
    identity: {
      login: "test@example.com",
      devIdentity: "1",
      tailscale: createTailscaleFake().api,
      clock: createClockFake(),
    },
    messages: { runner: link, repository: createMessageRepository(database.db) },
  });
  const id = (
    await runner.runtime.start({ projectId: "p", kind: "chat", title: "会話", cwd: home })
  )._unsafeUnwrap().conversationId;
  const post = async (text: string, images: string[], clientMessageId: string, mode = "send") => {
    const response = await app.request(
      `/api/conversations/${id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, images, clientMessageId, mode }),
      },
      incomingWith("127.0.0.1", 1234),
    );
    return { status: response.status, body: await response.json() };
  };
  const ipc = async (operation: string) =>
    (await link.call("POST", `/conversations/${id}/${operation}`, {}))._unsafeUnwrap();
  const save = (image: (typeof fixtures)[number], conversationId = id) => {
    const directory = join(home, "images", conversationId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${image.id}.${image.extension}`), image.data);
  };
  cleanups.push(async () => {
    link.stop();
    await runner.shutdown();
    database.close();
    removeTempHome(home);
  });
  return { home, database, agent, notices, logs, runner, id, post, ipc, save };
}
const delivered = { status: 202, body: { result: "delivered", queueItem: null } };
const missing = {
  status: 400,
  body: { error: { code: "invalid_input", message: "画像が見つかりません。貼り直してください" } },
};
function imageReferences(id: string, images = fixtures) {
  return images.map((image) => ({
    path: `images/${id}/${image.id}.${image.extension}`,
    media_type: image.mediaType,
  }));
}
function received(images = fixtures) {
  return images.map(({ data, mediaType }) => ({ data, mediaType }));
}
function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    queue: f.runner.runtime.store.queue(f.id),
    events: f.runner.runtime.store.events(f.id),
    conversation: f.runner.runtime.store.get(f.id),
    messages: [...f.agent.messages],
    opened: f.agent.opened.length,
  };
}

it("直接送信は実画像のバイトと形式をAIへ渡し、相対パスと形式を保存する", async () => {
  const f = await fixture();
  fixtures.forEach((image) => f.save(image));
  expect(
    await f.post(
      "画像を確認",
      fixtures.map((image) => image.id),
      "direct",
    ),
  ).toEqual(delivered);
  expect(f.agent.messages).toEqual([{ text: "画像を確認", images: received() }]);
  expect(f.runner.runtime.store.events(f.id).map((event) => event.payload)).toEqual([
    {
      text: "画像を確認",
      images: imageReferences(f.id),
      origin: "developer",
      client_ids: ["direct"],
      queued_ids: [],
      client_receipts: [
        { client_id: "direct", result: "delivered", received_at: expect.any(Number) },
      ],
    },
  ]);
  fixtures.forEach((image) =>
    rmSync(join(f.home, "images", f.id, `${image.id}.${image.extension}`)),
  );
  const before = snapshot(f);
  expect({
    response: await f.post("再送", [fixtures[0]!.id], "direct"),
    after: snapshot(f),
  }).toEqual({ response: delivered, after: before });
});

it.each(["manual", "send", "interrupt", "automatic"])(
  "%sの配達はキューのposition順に画像を並べ、新しい画像を末尾へ付ける",
  async (mode) => {
    const f = await fixture();
    fixtures.forEach((image) => f.save(image));
    await f.post("作業開始", [], "start");
    await f.post("先の指示", [fixtures[1]!.id, fixtures[0]!.id], "first");
    await f.post("後の指示", [fixtures[1]!.id], "second");
    f.database.sqlite
      .prepare(
        "UPDATE queued_instructions SET position = CASE client_id WHEN 'first' THEN 2 ELSE 1 END WHERE conversation_id = ?",
      )
      .run(f.id);
    const queue = f.runner.runtime.store.queue(f.id);
    if (mode === "automatic") {
      f.agent.outputs.get(f.id)!.push(turnEnd("success"));
      await expect.poll(() => f.agent.messages.length).toBe(2);
    } else if (mode === "interrupt") {
      expect(await f.post("新しい指示", [fixtures[0]!.id], "new", "interrupt")).toEqual(delivered);
    } else {
      await f.ipc("stop");
      if (mode === "manual") expect((await f.ipc("queue/deliver")).status).toBe(200);
      else expect(await f.post("新しい指示", [fixtures[0]!.id], "new")).toEqual(delivered);
    }
    const images = [
      fixtures[1]!,
      fixtures[1]!,
      fixtures[0]!,
      ...(["send", "interrupt"].includes(mode) ? [fixtures[0]!] : []),
    ];
    const text = `後の指示\n\n先の指示${["send", "interrupt"].includes(mode) ? "\n\n新しい指示" : ""}`;
    expect({
      messages: f.agent.messages,
      queue: f.runner.runtime.store.queue(f.id),
      payload: f.runner.runtime.store
        .events(f.id)
        .filter((event) => event.type === "user_message")
        .at(-1)?.payload,
    }).toEqual({
      messages: [
        { text: "作業開始", images: [] },
        { text, images: received(images) },
      ],
      queue: [],
      payload: {
        text,
        images: imageReferences(f.id, images),
        origin: mode === "interrupt" ? "interrupt" : mode === "send" ? "developer" : "queued",
        client_ids: ["second", "first", ...(["send", "interrupt"].includes(mode) ? ["new"] : [])],
        queued_ids: queue.map((entry) => entry.id),
        client_receipts: [
          ...queue.map((entry) => ({
            client_id: entry.clientId,
            result: "queued",
            queued_id: entry.id,
            received_at: entry.createdAt,
          })),
          ...(["send", "interrupt"].includes(mode)
            ? [{ client_id: "new", result: "delivered", received_at: expect.any(Number) }]
            : []),
        ],
      },
    });
    const before = snapshot(f);
    expect({ response: await f.post("再送", ["missing"], "first"), after: snapshot(f) }).toEqual({
      response: { status: 202, body: { result: "queued", queueItem: null } },
      after: before,
    });
  },
);

it.each(["manual", "send", "interrupt"])(
  "%sの欠落画像は400で拒み、キュー・記録・AIの実行を変えない",
  async (mode) => {
    const f = await fixture();
    f.save(fixtures[0]!);
    await f.post("作業開始", [], "start");
    f.save({ ...fixtures[0]!, id: "missing" });
    await f.post("預かった指示", [fixtures[0]!.id, "missing"], "queued");
    rmSync(join(f.home, "images", f.id, "missing.png"));
    if (mode !== "interrupt") await f.ipc("stop");
    const before = snapshot(f);
    const retry = async () =>
      mode === "manual"
        ? await f.ipc("queue/deliver")
        : await f.post("追加", [], "new", mode === "interrupt" ? "interrupt" : "send");
    expect({ response: await retry(), after: snapshot(f) }).toEqual({
      response: mode === "manual" ? { status: missing.status, body: missing.body } : missing,
      after: before,
    });
    f.save({ ...fixtures[0]!, id: "missing" });
    const retried = await retry();
    expect({
      status: retried.status,
      messages: f.agent.messages,
      queue: f.runner.runtime.store.queue(f.id),
    }).toEqual({
      status: mode === "manual" ? 200 : 202,
      messages: [
        { text: "作業開始", images: [] },
        {
          text: mode === "manual" ? "預かった指示" : "預かった指示\n\n追加",
          images: received([fixtures[0]!, fixtures[0]!]),
        },
      ],
      queue: [],
    });
  },
);

it.each([false, true])(
  "正常終了後に画像を読めないと、通知とエラーログを出し、指示を残して明示再試行を待つ: 欠落もある=%s",
  async (alsoMissing) => {
    const f = await fixture();
    f.save(fixtures[0]!);
    if (alsoMissing) f.save({ ...fixtures[0]!, id: "missing" });
    await f.post("作業開始", [], "start");
    const imageIds = [...(alsoMissing ? ["missing"] : []), fixtures[0]!.id];
    await f.post("預かった指示", imageIds, "queued");
    if (alsoMissing) rmSync(join(f.home, "images", f.id, "missing.png"));
    const imageFile = join(f.home, "images", f.id, `${fixtures[0]!.id}.png`);
    const before = snapshot(f);
    chmodSync(imageFile, 0);
    try {
      f.agent.outputs.get(f.id)!.push(turnEnd("success"));
      await expect.poll(() => f.runner.runtime.store.get(f.id)?.runState).toBe("idle");
      await f.runner.runtime.serial(f.id, async () => ok(undefined));
      await expect.poll(() => f.notices.length).toBe(1);
      expect({
        queue: f.runner.runtime.store.queue(f.id),
        messages: f.agent.messages,
        events: f.runner.runtime.store
          .events(f.id)
          .filter((event) => event.type === "user_message"),
        eventTypes: f.runner.runtime.store.events(f.id).map((event) => event.type),
        notices: f.notices,
        errors: f.logs.filter((entry) => entry.level === "error"),
      }).toEqual({
        queue: before.queue,
        messages: before.messages,
        events: before.events,
        eventTypes: ["user_message", "turn_end"],
        notices: [
          {
            kind: "notice",
            level: "error",
            conversation_id: f.id,
            message: "画像を読み取れませんでした。もう一度操作してください。",
          },
        ],
        errors: [
          {
            level: "error",
            component: "runner.agent",
            conversation_id: f.id,
            message: "預かった指示を届けられませんでした。",
            time: "1970-01-01T00:00:01.000Z",
            error: {
              name: "Error",
              message: "画像を読み取れませんでした。もう一度操作してください。",
            },
          },
          {
            level: "error",
            component: "runner.agent",
            conversation_id: f.id,
            message: "画像を読み取れませんでした。もう一度操作してください。",
            time: "1970-01-01T00:00:01.000Z",
          },
        ],
      });
    } finally {
      chmodSync(imageFile, 0o600);
    }
    if (alsoMissing) f.save({ ...fixtures[0]!, id: "missing" });
    await f.runner.runtime.serial(f.id, async () => ok(undefined));
    expect(f.agent.messages).toEqual(before.messages);
    expect((await f.ipc("queue/deliver")).status).toBe(200);
    expect({
      messages: f.agent.messages,
      queue: f.runner.runtime.store.queue(f.id),
      notices: f.notices.length,
    }).toEqual({
      messages: [
        ...before.messages,
        {
          text: "預かった指示",
          images: received(alsoMissing ? [fixtures[0]!, fixtures[0]!] : [fixtures[0]!]),
        },
      ],
      queue: [],
      notices: 1,
    });
  },
);

it.each([false, true])(
  "正常終了の自動配達は欠落画像だけを除外し、件数のお知らせを出す: 全画像欠落=%s",
  async (allMissing) => {
    const f = await fixture();
    for (const id of ["missing-1", fixtures[0]!.id, "missing-2"]) f.save({ ...fixtures[0]!, id });
    await f.post("作業開始", [], "start");
    await f.post("預かった指示", ["missing-1", fixtures[0]!.id, "missing-2"], "queued");
    for (const id of ["missing-1", ...(allMissing ? [fixtures[0]!.id] : []), "missing-2"])
      rmSync(join(f.home, "images", f.id, `${id}.png`));
    f.agent.outputs.get(f.id)!.push(turnEnd("success"));
    await expect.poll(() => f.agent.messages.length).toBe(2);
    await expect.poll(() => f.notices.length).toBe(1);
    expect({
      message: f.agent.messages.at(-1),
      images: f.runner.runtime.store
        .events(f.id)
        .filter((event) => event.type === "user_message")
        .at(-1)?.payload.images,
      queue: f.runner.runtime.store.queue(f.id),
      notices: f.notices,
    }).toEqual({
      message: { text: "預かった指示", images: received(allMissing ? [] : [fixtures[0]!]) },
      images: imageReferences(f.id, allMissing ? [] : [fixtures[0]!]),
      queue: [],
      notices: [
        {
          kind: "notice",
          level: "info",
          conversation_id: f.id,
          message: `画像 ${allMissing ? 3 : 2} 件が見つからないため、外して届けました`,
        },
      ],
    });
  },
);

it("利用枠後の自動再開は通常のお知らせを実ランナーから配信する", async () => {
  const callbacks = new Set<() => void | Promise<void>>();
  const f = await fixture({
    now: () => 1000,
    setTimeout: (callback) => {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
  });
  await f.post("作業開始", [], "start");
  f.agent.outputs.get(f.id)!.push({
    kind: "rate_limit",
    status: "rejected",
    resetsAt: 2000,
    overageStatus: null,
    errorCode: null,
    raw: { status: "rejected", resets_at: 2 },
  });
  f.agent.outputs.get(f.id)!.push(turnEnd("error_during_execution"));
  await expect.poll(() => f.runner.runtime.store.get(f.id)?.runState).toBe("usage_limited");
  for (const callback of callbacks) await callback();
  await expect.poll(() => f.notices.length).toBe(1);
  expect({
    messages: f.agent.messages,
    notices: f.notices,
    state: f.runner.runtime.store.get(f.id)?.runState,
  }).toEqual({
    messages: [
      { text: "作業開始", images: [] },
      { text: "中断したところから続けてください。", images: [] },
    ],
    notices: [
      {
        kind: "notice",
        level: "info",
        conversation_id: f.id,
        message: "利用枠が戻ったため、作業を再開しました。",
      },
    ],
    state: "working",
  });
});

it.each([
  "traversal",
  "absolute",
  "backslash",
  "other-conversation",
  "file-symlink",
  "directory-symlink",
  "unsupported",
])("会話の外や未対応形式の画像ID %s を400で拒み、保存も送信もしない", async (kind) => {
  const f = await fixture();
  const directory = join(f.home, "images", f.id);
  mkdirSync(directory, { recursive: true });
  f.save(fixtures[0]!, "other");
  let imageId = fixtures[0]!.id;
  if (kind === "file-symlink")
    symlinkSync(join(f.home, "images/other", `${imageId}.png`), join(directory, `${imageId}.png`));
  else if (kind === "directory-symlink") {
    rmSync(directory, { recursive: true });
    symlinkSync(join(f.home, "images/other"), directory);
  } else if (kind === "unsupported") writeFileSync(join(directory, `${imageId}.txt`), png);
  else if (kind === "traversal") imageId = `../other/${imageId}`;
  else if (kind === "absolute") imageId = join(f.home, "images/other", imageId);
  else if (kind === "backslash") imageId = `..\\other\\${imageId}`;
  const before = snapshot(f);
  expect({
    response: await f.post("画像の確認", [imageId], "outside"),
    after: snapshot(f),
  }).toEqual({ response: missing, after: before });
});

it("作業中の明示送信も欠落画像を400で拒み、既存キューと受付記録を保持する", async () => {
  const f = await fixture();
  f.save(fixtures[0]!);
  await f.post("作業開始", [], "start");
  await f.post("先に預かった指示", [fixtures[0]!.id], "queued");
  const before = snapshot(f);
  expect({
    response: await f.post("画像の確認", ["missing"], "rejected"),
    after: snapshot(f),
  }).toEqual({ response: missing, after: before });
  f.save({ ...fixtures[0]!, id: "missing" });
  const retried = await f.post("画像の確認", ["missing"], "rejected");
  const queued = f.runner.runtime.store.queue(f.id).at(-1)!;
  expect(retried).toEqual({
    status: 202,
    body: {
      result: "queued",
      queueItem: {
        id: queued.id,
        text: "画像の確認",
        images: ["missing"],
        position: 2,
        stockItemId: null,
        clientId: "rejected",
        createdAt: queued.createdAt,
      },
    },
  });
});
