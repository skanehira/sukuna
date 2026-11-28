import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const entry = new URL("../dist/server/main.js", import.meta.url);
const client = new URL("../dist/client/", import.meta.url);
const index = new URL("index.html", client);
const host = "127.0.0.1";

async function unusedPort(): Promise<number> {
  const reservation = createServer().listen(0, host);
  await once(reservation, "listening");
  const address = reservation.address();
  reservation.close();
  await once(reservation, "close");
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function startBuiltServer(t: TestContext): Promise<number> {
  const port = await unusedPort();
  const home = await mkdtemp(join(tmpdir(), "sukuna-built-"));
  const child = spawn(process.execPath, [fileURLToPath(entry)], {
    cwd: home,
    env: {
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      NODE_ENV: "production",
      PORT: String(port),
      XDG_DATA_HOME: join(home, "data"),
      XDG_STATE_HOME: join(home, "state"),
      XDG_RUNTIME_DIR: join(home, "runtime"),
      SUKUNA_RUNNER_SOCKET: join(home, "runner.sock"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  t.after(async () => {
    child.kill("SIGTERM");
    const forceExit = setTimeout(() => child.kill("SIGKILL"), 1_000);
    try {
      await closed;
    } finally {
      clearTimeout(forceExit);
      await rm(home, { recursive: true, force: true });
    }
  });

  let output = "";
  child.on("error", (error) => {
    output += `${error}\n`;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  const lines = createInterface({
    input: child.stdout,
    signal: AbortSignal.timeout(5_000),
  });
  for await (const line of lines) {
    output += line + "\n";
    if (line.includes(`"message":"listening on http://0.0.0.0:${port}"`)) return port;
  }
  throw new Error(
    `ビルド済みサーバーがポート ${port} で待ち受けを開始できませんでした。\n${output}`,
  );
}

await test("ビルド済みサーバーの入口", { timeout: 20_000 }, async (t) => {
  let indexHtml: string;
  try {
    await access(entry);
    indexHtml = await readFile(index, "utf8");
  } catch (error) {
    throw new Error("ビルド成果物を開けませんでした。vp build の結果を確認してください。", {
      cause: error,
    });
  }
  const port = await startBuiltServer(t);
  const base = `http://${host}:${port}`;
  const request = { redirect: "manual", signal: t.signal } as const;

  await t.test("会話を直接開くと SPA の HTML とクライアントの JavaScript が届く", async () => {
    const response = await fetch(`${base}/conversations/abc`, request);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/);
    const html = await response.text();
    assert.equal(html, indexHtml);

    const modulePath = html.match(/<script\b[^>]*\bsrc="(\/[^/"][^"]*)"/)?.[1];
    assert.ok(modulePath, "HTML にクライアントの JavaScript がありません。");
    const javascript = await fetch(`${base}${modulePath}`, request);
    assert.equal(javascript.status, 200);
    assert.match(javascript.headers.get("content-type") ?? "", /\bjavascript\b/);
    const received = Buffer.from(await javascript.arrayBuffer());
    const artifact = await readFile(new URL(`.${modulePath}`, client));
    assert.ok(received.equals(artifact), `${modulePath} の内容がビルド成果物と一致しません。`);
  });

  await t.test("GET /api/health がヘルスチェックの JSON を返す", async () => {
    const response = await fetch(`${base}/api/health`, request);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
    assert.deepEqual(await response.json(), { status: "ok" });
  });

  await t.test("ログイン設定なしでビルド情報を返す", async () => {
    const response = await fetch(base + "/api/me", request);
    assert.equal(response.status, 200);
    assert.equal(typeof (await response.json()).build, "string");
  });

  await t.test("未登録の API は 404 を返す", async () => {
    const response = await fetch(`${base}/api/unknown`, request);
    await response.body?.cancel();
    assert.equal(response.status, 404);
  });

  await t.test("同じポートの /ws で WebSocket 接続が開く", async () => {
    const socket = new WebSocket(`ws://${host}:${port}/ws`, { handshakeTimeout: 3_000 });
    try {
      await once(socket, "open");
      assert.equal(socket.readyState, WebSocket.OPEN);
    } finally {
      socket.terminate();
    }
  });
});
