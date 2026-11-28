import { expect, it } from "vite-plus/test";
import { Hono } from "hono";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { createTempHome, removeTempHome } from "../shared/db/test-helpers";
import { RunnerLink } from "./runner-link";
it("ランナーが止まっているAPI操作には503とrunner_unavailableを返す", async () => {
  const link = new RunnerLink({
    socket: "/tmp/sukuna-missing-runner.sock",
    log: () => {},
    notice: () => {},
    connection: () => {},
  });
  const app = new Hono();
  app.post("/api/operate", () => link.forward("POST", "/conversations/a/stop"));
  const response = await app.request("/api/operate", { method: "POST" });
  expect({ status: response.status, body: await response.json() }).toEqual({
    status: 503,
    body: {
      error: {
        code: "runner_unavailable",
        message: "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
      },
    },
  });
});
class TestClock {
  now = 0;
  timers = new Map<() => void, number>();
  setTimeout = (callback: () => void, ms: number) => {
    this.timers.set(callback, this.now + ms);
    return () => {
      this.timers.delete(callback);
    };
  };
  advance(ms: number) {
    this.now += ms;
    for (const [callback, at] of this.timers) {
      if (at > this.now) continue;
      this.timers.delete(callback);
      callback();
    }
  }
}
async function fixture() {
  const home = createTempHome();
  const clock = new TestClock();
  const operations: string[] = [];
  let stream: ServerResponse | undefined;
  let operation: (response: ServerResponse) => void = (res) => res.end('{"ok":true}');
  let accepted = () => {};
  let connected = () => {};
  let disconnected = () => {};
  const server = createServer((req, res) => {
    if (req.url === "/changes") {
      stream = res;
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.flushHeaders();
    } else {
      operations.push(req.url ?? "");
      operation(res);
      accepted();
    }
  });
  server.listen(join(home, "runner.sock"));
  await once(server, "listening");
  const link = new RunnerLink({
    socket: join(home, "runner.sock"),
    clock,
    notice: () => {},
    log: () => {},
    connection: (value) => (value ? connected() : disconnected()),
  });
  return {
    link,
    clock,
    operations,
    operation: (fn: typeof operation) => {
      operation = fn;
    },
    accepted: () =>
      new Promise<void>((resolve) => {
        accepted = resolve;
      }),
    connected: () =>
      new Promise<void>((resolve) => {
        connected = resolve;
      }),
    disconnected: () =>
      new Promise<void>((resolve) => {
        disconnected = resolve;
      }),
    stream: () => {
      if (!stream) throw Error("changes is not connected");
      return stream;
    },
    close: async () => {
      link.stop();
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
      removeTempHome(home);
    },
  };
}
it("未対応の操作が平文の404を返したとき、API にランナー更新の案内を渡す", async () => {
  const s = await fixture();
  const connected = s.connected();
  s.link.start();
  await connected;
  s.operation((response) =>
    response.writeHead(404, { "content-type": "text/plain" }).end("404 Not Found"),
  );

  try {
    const message = "ランナーを更新してください。";
    const response = await s.link.forward(
      "POST",
      "/conversations/a/answers/checked",
      {},
      {
        missingRouteMessage: message,
      },
    );
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 503,
      body: { error: { code: "runner_unavailable", message } },
    });
  } finally {
    await s.close();
  }
});

it.each(["end", "close", "error"] as const)(
  "初回未接続とchangesの%s後は操作せず503を返し、回復後は成功する",
  async (ending) => {
    const s = await fixture();
    const unavailable = {
      status: 503,
      body: {
        error: {
          code: "runner_unavailable",
          message:
            "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
        },
      },
    };
    const operate = async () => {
      const response = await s.link.forward("POST", "/operation");
      return { status: response.status, body: await response.json() };
    };
    try {
      expect(await operate()).toEqual(unavailable);
      expect(s.operations).toEqual([]);
      let connected = s.connected();
      s.link.start();
      await connected;
      expect(await operate()).toEqual({ status: 200, body: { ok: true } });
      const disconnected = s.disconnected();
      if (ending === "end") s.stream().end();
      else s.stream().destroy(ending === "error" ? Error("broken") : undefined);
      await disconnected;
      expect(await operate()).toEqual(unavailable);
      expect(s.operations).toEqual(["/operation"]);
      connected = s.connected();
      s.clock.advance(1000);
      await connected;
      expect(await operate()).toEqual({ status: 200, body: { ok: true } });
      expect(s.operations).toEqual(["/operation", "/operation"]);
      s.operation((response) => {
        response.writeHead(409);
        response.end('{"error":{"code":"conflict","message":"状態を確認してください。"}}');
      });
      expect(await operate()).toEqual({
        status: 409,
        body: { error: { code: "conflict", message: "状態を確認してください。" } },
      });
    } finally {
      await s.close();
    }
  },
);
it.each([
  "deadline",
  "success",
  "conflict",
  "invalid-json",
  "response-error",
  "request-error",
] as const)("操作の10秒期限とタイマー解除: %s", async (outcome) => {
  const s = await fixture();
  try {
    let response: ServerResponse | undefined;
    s.operation((res) => {
      response = res;
    });
    const accepted = s.accepted();
    const pending = s.link.call("POST", "/operation");
    await accepted;
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    s.clock.advance(9999);
    await Promise.resolve();
    expect({ settled, activeTimers: s.clock.timers.size }).toEqual({
      settled: false,
      activeTimers: 1,
    });
    if (outcome === "deadline") s.clock.advance(1);
    if (outcome === "success") response?.end('{"result":"conflict"}');
    if (outcome === "conflict") {
      response?.writeHead(409);
      response?.end('{"error":{"code":"conflict","message":"状態を確認してください。"}}');
    }
    if (outcome === "invalid-json") response?.end("broken json");
    if (outcome === "response-error") {
      response?.writeHead(200, { "content-length": 100 });
      response?.write("{");
      response?.socket?.end();
    }
    if (outcome === "request-error") response?.destroy();
    const result = await pending;
    expect(result.isOk() ? result.value : result.error).toEqual(
      outcome === "success"
        ? { status: 200, body: { result: "conflict" } }
        : outcome === "conflict"
          ? {
              status: 409,
              body: { error: { code: "conflict", message: "状態を確認してください。" } },
            }
          : {
              code: "runner_unavailable",
              message:
                "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
            },
    );
    expect(s.clock.timers.size).toBe(0);
  } finally {
    await s.close();
  }
});
