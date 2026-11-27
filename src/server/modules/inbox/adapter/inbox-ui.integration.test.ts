import { describe, expect, it, vi } from "vite-plus/test";
import { once } from "node:events";
import { Server } from "node:http";
import { serve } from "@hono/node-server";
import { WebSocket, WebSocketServer } from "ws";
import { eq } from "drizzle-orm";
import { conversations } from "../../../../shared/db/schema";
import { clientMessageSchema } from "../../../../shared/ws";
import { InboxStore, createInboxApi } from "../../../../front/lib/inbox-store";
import { Realtime, type RealtimeSocket } from "../../../../front/lib/realtime";
import { WsHub } from "../../../ws-hub";
import { inboxFixture } from "../test-support";

describe("一覧のHTTP・SQLite・WebSocketの接続", () => {
  const f = inboxFixture();
  it("開いたままrun_stateが変わると、changedを購読して行が新しいセクションへ移る", async () => {
    f.conversation("c", { runState: "working" });
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => f.request(new URL(request.url).pathname),
    });
    await once(server, "listening");
    if (!(server instanceof Server)) throw new Error("HTTPのサーバーではありません");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTPのポートがありません");
    const origin = `http://127.0.0.1:${address.port}`;
    const hub = new WsHub(f.sqlite);
    const wss = new WebSocketServer({ server });
    let inboxSubscribed = false;
    wss.on("connection", (socket) => {
      hub.add(socket);
      socket.on("message", (data) => {
        const message = clientMessageSchema.parse(
          JSON.parse(
            (data instanceof ArrayBuffer
              ? Buffer.from(data)
              : Array.isArray(data)
                ? Buffer.concat(data)
                : data
            ).toString(),
          ),
        );
        hub.receive(socket, message);
        if (message.op === "subscribe" && message.topic === "inbox") inboxSubscribed = true;
      });
      socket.on("close", () => hub.remove(socket));
    });
    const timers = new Map<() => void, number>();
    let now = 120000;
    const schedule = (fn: () => void, ms: number) => {
      let active = true;
      if (ms === 0)
        queueMicrotask(() => {
          if (active) fn();
        });
      else timers.set(fn, ms);
      return () => {
        active = false;
        timers.delete(fn);
      };
    };
    const store = new InboxStore(
      createInboxApi((input, init) =>
        fetch(new URL(input instanceof Request ? input.url : input.toString(), origin), init),
      ),
      { now: () => now, schedule, storage: { getItem: () => null, setItem: () => {} } },
    );
    const realtime = new Realtime({
      connect: () => new WebSocket(origin.replace("http", "ws")) as unknown as RealtimeSocket,
      setTimeout: schedule,
      unavailable: () => {},
      reload: () => {
        void store.reload();
      },
      gap: () => {},
      message: store.receive,
    });
    const stop = store.inbox.subscribe(() => {});
    realtime.subscribe("inbox");
    realtime.start();
    try {
      await vi.waitFor(() =>
        expect(
          store.inbox
            .snapshot()
            .data?.sections.map((section) => [section.name, section.rows.map((row) => row.key)]),
        ).toEqual([
          ["decision", []],
          ["instruction", []],
          ["working", ["conversation:c"]],
        ]),
      );
      await vi.waitFor(() => expect(inboxSubscribed).toBe(true));
      f.db
        .update(conversations)
        .set({ runState: "waiting_answer" })
        .where(eq(conversations.id, "c"))
        .run();
      hub.notice({
        kind: "conversation",
        conversation_id: "c",
        project_id: "p",
        issue_id: null,
        run_state: "waiting_answer",
        seq: 0,
      });
      await vi.waitFor(() => expect([...timers.values()]).toContain(1000));
      now += 1000;
      for (const [fn] of Array.from(timers).filter(([, ms]) => ms === 1000)) {
        timers.delete(fn);
        fn();
      }
      await vi.waitFor(() =>
        expect(
          store.inbox
            .snapshot()
            .data?.sections.map((section) => [section.name, section.rows.map((row) => row.key)]),
        ).toEqual([
          ["decision", ["conversation:c"]],
          ["instruction", []],
          ["working", []],
        ]),
      );
    } finally {
      stop();
      store.dispose();
      realtime.stop();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
