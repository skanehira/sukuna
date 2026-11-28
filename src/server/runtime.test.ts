import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import WebSocket from "ws";
import type { OpenedDatabase } from "../shared/db/open";
import { createTempHome, removeTempHome } from "../shared/db/test-helpers";
import { attachUpgradeHandler, getDatabase, initializeRuntime } from "./runtime";
import { directoriesIn, xdgVariablesIn } from "../test/directories";

function settle(socket: WebSocket): Promise<"open" | "error"> {
  return new Promise((resolve) => {
    socket.once("open", () => resolve("open"));
    socket.once("error", () => resolve("error"));
  });
}

describe("attachUpgradeHandler", () => {
  let server: Server | undefined;
  const clients: WebSocket[] = [];
  const rawSockets = new Set<Socket>();

  afterEach(async () => {
    for (const client of clients) client.terminate();
    clients.length = 0;
    for (const socket of rawSockets) socket.destroy();
    rawSockets.clear();
    if (server !== undefined) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  it("/ws への接続を受け付け、ほかのパスへの接続は受け付けない", async () => {
    const httpServer = createServer((_request, response) => {
      response.end("ok");
    });
    httpServer.on("connection", (socket) => {
      rawSockets.add(socket);
    });
    attachUpgradeHandler(httpServer, {
      hub: () => undefined,
    });
    server = httpServer;
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const { port } = httpServer.address() as AddressInfo;

    const accepted = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    clients.push(accepted);
    expect(await settle(accepted)).toBe("open");
    expect(accepted.readyState).toBe(WebSocket.OPEN);

    const crossOrigin = new WebSocket("ws://127.0.0.1:" + port + "/ws", {
      origin: "https://other.example.invalid",
      handshakeTimeout: 500,
    });
    clients.push(crossOrigin);
    expect(await settle(crossOrigin)).toBe("error");

    const rejected = new WebSocket(`ws://127.0.0.1:${port}/other`, { handshakeTimeout: 500 });
    clients.push(rejected);
    expect(await settle(rejected)).toBe("error");
  });
});

describe("initializeRuntime", () => {
  it("2 回初期化しても、データベースの接続は 1 つのまま", async () => {
    const home = createTempHome();
    let database: OpenedDatabase | undefined;

    try {
      const first = await initializeRuntime({ directories: directoriesIn(home) });
      expect(first.isOk()).toBe(true);
      if (!first.isOk()) throw new Error("初期化に失敗しました");
      database = getDatabase();

      const second = await initializeRuntime({ directories: directoriesIn(home) });
      expect(second.isOk()).toBe(true);
      expect(getDatabase()).toBe(database);
    } finally {
      database?.close();
      removeTempHome(home);
    }
  });
});

it("設定ルートと共有スキーマを HMR で読み直しても同じ SQLite と配信を使う", async () => {
  const home = createTempHome();
  const probe = `
    import assert from "node:assert/strict";
    import { join, resolve } from "node:path";
    import { createServer } from "vite";
    const home = process.argv[1];
    const loader = await createServer({
      configFile:false, root:process.cwd(), envDir:false,
      cacheDir:join(home, "vite-cache"),
      define:{__SUKUNA_BUILD_ID__:JSON.stringify("settings-hmr-test")},
      server:{middlewareMode:true, ws:false, watch:null}, optimizeDeps:{entries:[]},
    });
    let runtime;
    try {
      runtime = await loader.ssrLoadModule("/src/server/runtime.ts");
      const started = await runtime.initializeRuntime({directories:{data:home,state:home,runtime:home}}, {log:()=>{}});
      assert.equal(started.isOk(), true);
      const database = runtime.getDatabase();
      const hub = runtime.getWsHub();
      const client = {
        bufferedAmount: 0, sent: [], close() {},
        send(message) { this.sent.push(JSON.parse(message)); },
      };
      hub.add(client);
      const read = async (path, init) => {
        const {default:app} = await loader.ssrLoadModule("/src/server/dev.ts");
        const response = await app.request("http://127.0.0.1"+path, init, {
          incoming:{socket:{remoteAddress:"127.0.0.1",remotePort:2500}},
        });
        assert.equal(response.status, 200);
        return response.json();
      };
      assert.deepEqual((await read("/api/settings")).keymap.entries, []);
      const entries = [{ keys:"Q", context:"normal", to:{ action:"open" } }];
      await read("/api/settings/keymap", {method:"PUT",headers:{"content-type":"application/json"}, body:JSON.stringify({entries})});
      for (const name of [
        "src/server/dev.ts",
        "src/server/modules/settings/adapter/dependencies.ts",
        "src/server/app.ts",
        "src/server/modules/settings/adapter/routes.ts",
        "src/server/modules/settings/usecase/get-settings.ts",
        "src/server/modules/settings/usecase/save-keymap.ts",
        "src/shared/settings/keymap-schema.ts",
        "src/shared/settings/settings-schema.ts",
      ]) {
        const file = resolve(name);
        assert.ok(loader.moduleGraph.getModulesByFile(file)?.size, name);
        loader.moduleGraph.onFileChange(file);
        assert.deepEqual((await read("/api/settings")).keymap.entries, entries, name);
        const after = await loader.ssrLoadModule("/src/server/runtime.ts");
        assert.equal(after.getDatabase(), database, name);
        assert.equal(after.getWsHub(), hub, name);
      }
      await read("/api/settings/keymap", {method:"PUT",headers:{"content-type":"application/json"}, body:JSON.stringify({entries:[]})});
      assert.deepEqual(client.sent.map((event) => [event.topic,event.type]), [
        ["app","settings_changed"], ["app","settings_changed"],
      ]);
    } finally {
      if (runtime) {
        runtime.getRunnerLink().stop();
        runtime.getDatabase().close();
      }
      await loader.close();
    }
  `;
  try {
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", probe, home], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: {
        ...process.env,
        ...xdgVariablesIn(home),
        SUKUNA_RUNNER_SOCKET: home + "/runner.sock",
      },
      timeout: 20_000,
    });
  } finally {
    removeTempHome(home);
  }
}, 30_000);
