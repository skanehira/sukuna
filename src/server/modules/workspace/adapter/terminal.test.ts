import { serve } from "@hono/node-server";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node-pty";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { WebSocket } from "ws";
import {
  terminalOpenedSchema,
  terminalOutputFrameSchema,
  type OpenTerminalInput,
  type TerminalOutputFrame,
} from "../../../../shared/api/terminal";
import { worktreeListSchema } from "../../../../shared/api/worktree";
import { openMigratedDatabase } from "../../../../shared/db/test-helpers";
import { createWorktreeActivity } from "../../../../shared/workspace/sqlite-worktree-activity";
import { createApp } from "../../../app";
import { createUpgradeHandler } from "../../../runtime";
import { createTailscaleLocalApi } from "../../identity/adapter/tailscale-local-api";
import { createUpgradeAuthorizer } from "../../identity/adapter/middleware";
import { createResolveIdentity } from "../../identity/usecase/resolve-identity";
import { createPtySessions } from "./pty-session";
import { activeFixtureJob } from "./terminal-test-helpers";
import { createWorktreeDependencies } from "./worktree-dependencies";

function git(cwd: string, ...args: string[]) {
  execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Terminal Test",
      "-c",
      "user.email=terminal@example.invalid",
      ...args,
    ],
    { cwd, stdio: "pipe" },
  );
}

function nextMatching<T>(
  history: T[],
  subscribe: (listener: (value: T) => void) => () => void,
  predicate: (value: T) => boolean,
) {
  const found = history.find(predicate);
  if (found !== undefined) return Promise.resolve(found);
  return new Promise<T>((resolve) => {
    const unsubscribe = subscribe((value) => {
      if (!predicate(value)) return;
      unsubscribe();
      resolve(value);
    });
  });
}

describe("ターミナル API と WebSocket", () => {
  let root: string;
  let project: string;
  let worktree: string;
  let home: string;
  let database: ReturnType<typeof openMigratedDatabase>;
  let server: ReturnType<typeof serve>;
  let baseUrl: string;
  let sessions: ReturnType<typeof createPtySessions>;
  let clients: WebSocket[];
  let rawOutput: string[];
  let rawListeners: Set<(data: string) => void>;
  const input: OpenTerminalInput = {
    projectId: "p",
    worktreeId: "w",
    conversationId: null,
    cols: 120,
    rows: 40,
  };

  function request(path: string, method: string, body?: unknown) {
    return fetch(`${baseUrl}${path}`, {
      method,
      ...(body
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
  }

  async function open(overrides: Partial<OpenTerminalInput> = {}) {
    return request("/api/terminals", "POST", { ...input, ...overrides });
  }

  async function openId() {
    const response = await open();
    expect(response.status).toBe(201);
    const body = terminalOpenedSchema.parse(await response.json());
    expect(body).toEqual({
      id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      cwd: worktree,
      label: "worktree: try-2",
      conversationId: null,
      reused: false,
    });
    return body.id;
  }

  function connect(id: string, headers?: Record<string, string>) {
    const socket = new WebSocket(`${baseUrl.replace("http:", "ws:")}/ws/terminals/${id}`, {
      headers: { origin: baseUrl, ...headers },
    });
    clients.push(socket);
    const history: TerminalOutputFrame[] = [];
    const listeners = new Set<(frame: TerminalOutputFrame) => void>();
    socket.on("message", (contents) => {
      const buffer = Array.isArray(contents)
        ? Buffer.concat(contents)
        : contents instanceof ArrayBuffer
          ? Buffer.from(contents)
          : contents;
      const frame = terminalOutputFrameSchema.parse(JSON.parse(buffer.toString()));
      history.push(frame);
      for (const listener of listeners) listener(frame);
    });
    const connected = once(socket, "open");
    void connected.catch(() => undefined);
    return {
      socket,
      connected,
      history,
      send: (frame: unknown) => socket.send(JSON.stringify(frame)),
      wait: (predicate: (frame: TerminalOutputFrame) => boolean) =>
        nextMatching(
          history,
          (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          predicate,
        ),
    };
  }

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "sukuna-terminal-")));
    home = join(root, "app");
    project = join(root, "repo");
    worktree = join(project, ".claude/worktrees/try-2");
    mkdirSync(project);
    mkdirSync(home);
    git(project, "init", "--quiet", "-b", "main");
    writeFileSync(join(project, "README"), "fixture");
    git(project, "add", "README");
    git(project, "commit", "--quiet", "-m", "fixture");
    writeFileSync(join(project, ".git/info/exclude"), ".claude/worktrees/\n");
    git(project, "worktree", "add", "--quiet", "-b", "try-2", worktree, "main");
    database = openMigratedDatabase(home);
    database.sqlite
      .prepare(
        "INSERT INTO projects (id, name, path, default_branch) VALUES ('p', 'sample', ?, 'main')",
      )
      .run(project);
    database.sqlite
      .prepare(
        "INSERT INTO worktrees (id, project_id, path, branch, origin) VALUES ('w', 'p', ?, 'try-2', 'user')",
      )
      .run(worktree);
    clients = [];
    rawOutput = [];
    rawListeners = new Set();
    sessions = createPtySessions({
      env: { HOME: root, PATH: "/usr/bin:/bin", SHELL: "/bin/sh", SUKUNA_TEST: "private-fixture" },
      spawn: (...args) => {
        const pty = spawn(...args);
        pty.onData((data) => {
          rawOutput.push(data);
          for (const listener of rawListeners) listener(data);
        });
        return pty;
      },
    });
    const identity = {
      login: "owner@example.invalid",
      devIdentity: "owner@example.invalid",
      tailscale: createTailscaleLocalApi(),
      clock: { now: () => 0 },
    };
    const app = createApp({
      build: "terminal-test",
      identity,
      worktrees: createWorktreeDependencies(() => database, { terminals: sessions }),
    });
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const authorizeTerminal = createUpgradeAuthorizer({
      resolve: createResolveIdentity({
        ...identity,
        get devIdentity() {
          return allowTerminal ? identity.devIdentity : undefined;
        },
      }),
    });
    allowTerminal = true;
    server.on("upgrade", createUpgradeHandler({ authorizeTerminal, terminals: sessions }));
  });

  let allowTerminal: boolean;

  afterEach(async () => {
    for (const client of clients ?? []) client.terminate();
    await sessions?.close();
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    database?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("実 worktree のログインシェルで pwd と環境を読み、開いている画面へ同じ出力を配信する", async () => {
    const id = await openId();
    const a = connect(id);
    const b = connect(id);
    await Promise.all([a.connected, b.connected]);
    await Promise.all([
      a.wait(({ type }) => type === "snapshot"),
      b.wait(({ type }) => type === "snapshot"),
    ]);
    let aOutput = "";
    let bOutput = "";
    a.send({
      type: "input",
      data: 'printf \'\\n\'; pwd; printf \'%s / %s / %s\\n\' "$TERM" "${SUKUNA_TEST-unset}" "$0"\r',
    });
    const commandResult = (data: string) =>
      data.replaceAll("\r", "").split("\n").includes("xterm-256color / unset / /bin/sh");
    await Promise.all([
      a.wait((f) => f.type === "output" && commandResult((aOutput += f.data))),
      b.wait((f) => f.type === "output" && commandResult((bOutput += f.data))),
    ]);
    for (const data of [aOutput, bOutput])
      expect(
        data
          .replaceAll("\r", "")
          .split("\n")
          .find((line) => line === worktree),
      ).toBe(worktree);
    const listed = worktreeListSchema.parse(
      await (await request("/api/projects/p/worktrees", "GET")).json(),
    );
    expect(listed.worktrees.map(({ id, terminalId }) => ({ id, terminalId }))).toEqual([
      { id: null, terminalId: null },
      { id: "w", terminalId: id },
    ]);
  });

  it("全接続を閉じてから届いた出力を一度だけ snapshot に載せる", async () => {
    const gate = join(worktree, ".reconnect");
    execFileSync("mkfifo", [gate]);
    const id = await openId();
    const a = connect(id);
    await a.connected;
    await a.wait(({ type }) => type === "snapshot");
    a.send({
      type: "input",
      data: "read -r gate < .reconnect; printf '\\n%s%s\\n' terminal- reconnect\r",
    });
    const closed = once(a.socket, "close");
    a.socket.close();
    await closed;
    await writeFile(gate, "continue\n");
    const marker = /(?:^|\r?\n)terminal-reconnect\r?\n/;
    let observed = "";
    await nextMatching(
      rawOutput,
      (listener) => {
        rawListeners.add(listener);
        return () => rawListeners.delete(listener);
      },
      (data) => marker.test((observed += data)),
    );
    const b = connect(id);
    await b.connected;
    const frame = await b.wait(({ type }) => type === "snapshot");
    expect(frame).toEqual({
      type: "snapshot",
      cols: 120,
      rows: 40,
      data: expect.stringMatching(/(?:^|\r?\n)terminal-reconnect(?:\r?\n|$)/),
    });
    expect(b.history).toEqual([frame]);
  });

  it("同時に同じ場所を要求すると同じ id を返し、会話の送信先を引き継ぐ", async () => {
    database.sqlite
      .prepare(
        "INSERT INTO conversations (id, project_id, kind, cwd, worktree_id) VALUES ('c', 'p', 'chat', ?, 'w')",
      )
      .run(worktree);
    const [a, b] = await Promise.all([open(), open({ worktreeId: null, conversationId: "c" })]);
    const responses = [a, b].sort((a, b) => b.status - a.status);
    const [created, reused] = await Promise.all(
      responses.map(async (res) => ({
        status: res.status,
        body: terminalOpenedSchema.parse(await res.json()),
      })),
    );
    expect(created).toEqual({
      status: 201,
      body: {
        id: expect.any(String),
        cwd: worktree,
        label: "worktree: try-2",
        conversationId: expect.toBeOneOf(["c", null]),
        reused: false,
      },
    });
    expect(reused).toEqual({
      status: 200,
      body: { ...created!.body, reused: true, conversationId: "c" },
    });
    const opening = await open();
    expect({ status: opening.status, body: await opening.json() }).toEqual(reused);
  });

  it.each([false, true])(
    "同じパスの新しい worktree は別の端末を開く (元のシェルで cd する: %s)",
    async (moved) => {
      const id = await openId();
      const old = connect(id);
      await old.connected;
      await old.wait(({ type }) => type === "snapshot");
      if (moved) {
        let output = "";
        old.send({ type: "input", data: "cd /; printf '\\n'; pwd\r" });
        await old.wait(
          (frame) => frame.type === "output" && /\r?\n\/\r?\n/.test((output += frame.data)),
        );
      }
      const directoryIdentity = () => {
        const { dev, ino } = statSync(worktree, { bigint: true });
        return { dev, ino };
      };
      const original = directoryIdentity();
      git(project, "worktree", "remove", worktree);
      git(project, "worktree", "add", "--quiet", worktree, "try-2");
      writeFileSync(join(worktree, "README"), "replacement-readme\n");
      const list = worktreeListSchema.parse(
        await (await request("/api/projects/p/worktrees", "GET")).json(),
      );
      expect(list.worktrees.map(({ id, terminalId }) => ({ id, terminalId }))).toEqual([
        { id: null, terminalId: null },
        { id: "w", terminalId: null },
      ]);
      expect(directoryIdentity()).not.toEqual(original);
      const recreated = await openId();
      expect(recreated).not.toBe(id);
      const current = connect(recreated);
      await current.connected;
      await current.wait(({ type }) => type === "snapshot");
      let output = "";
      current.send({ type: "input", data: "printf '\\n'; cat README\r" });
      expect(
        await current.wait(
          (frame) =>
            frame.type === "output" && /\r?\nreplacement-readme\r?\n/.test((output += frame.data)),
        ),
      ).toEqual({ type: "output", data: expect.any(String) });
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "一覧を読めず検索できる worktree を開き、既知のファイルを読める",
    async () => {
      chmodSync(worktree, 0o100);
      try {
        expect(() => accessSync(worktree, constants.R_OK)).toThrow();
        expect(() => accessSync(worktree, constants.X_OK)).not.toThrow();
        const client = connect(await openId());
        await client.connected;
        await client.wait(({ type }) => type === "snapshot");
        let output = "";
        client.send({ type: "input", data: "printf '\\n'; cat README; printf '\\n'\r" });
        expect(
          await client.wait(
            (frame) => frame.type === "output" && /\r?\nfixture\r?\n/.test((output += frame.data)),
          ),
        ).toEqual({ type: "output", data: expect.any(String) });
      } finally {
        chmodSync(worktree, 0o700);
      }
    },
  );

  it.skipIf(process.getuid?.() === 0)("検索できない worktree の端末を開かない", async () => {
    chmodSync(worktree, 0o000);
    try {
      expect(() => accessSync(worktree, constants.X_OK)).toThrow();
      const response = await open();
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 500,
        body: {
          error: {
            code: "internal",
            message: "シェルを開けませんでした。設定を確かめてください。",
          },
        },
      });
    } finally {
      chmodSync(worktree, 0o700);
    }
  });

  it("同じディレクトリを指す別のパスで開くと実行中のシェルを引き継ぐ", async () => {
    const id = await openId();
    const alias = join(root, "worktree-link");
    symlinkSync(worktree, alias, "dir");
    database.sqlite
      .prepare(
        "INSERT INTO conversations (id, project_id, kind, cwd) VALUES ('alias', 'p', 'chat', ?)",
      )
      .run(alias);
    const opened = await open({ worktreeId: null, conversationId: "alias" });
    expect({ status: opened.status, body: await opened.json() }).toEqual({
      status: 200,
      body: {
        id,
        cwd: worktree,
        label: "worktree: worktree-link",
        conversationId: "alias",
        reused: true,
      },
    });
  });

  it.each([
    { cols: 1, rows: 40 },
    { cols: 501, rows: 40 },
    { cols: 120, rows: 0 },
    { cols: 120, rows: 201 },
  ])("範囲外の大きさを拒否する $cols × $rows", async (size) => {
    const response = await open(size);
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 400,
      body: {
        error: {
          code: "invalid_input",
          message: "端末の大きさは 2〜500 列、1〜200 行で指定してください",
        },
      },
    });
  });

  it("既存の 20 個は使い続けられ、21 個目は競合を返す", async () => {
    const first = await openId();
    for (let n = 1; n <= 20; n++) {
      const directory = join(root, `repo-${n}`);
      mkdirSync(directory);
      database.sqlite
        .prepare(
          "INSERT INTO projects (id, name, path, default_branch) VALUES (?, 'sample', ?, 'main')",
        )
        .run(`p${n}`, directory);
      const response = await open({ projectId: `p${n}`, worktreeId: null });
      if (n < 20) {
        expect({ status: response.status, body: await response.json() }).toEqual({
          status: 201,
          body: {
            id: expect.any(String),
            cwd: directory,
            label: "プロジェクトのディレクトリ",
            conversationId: null,
            reused: false,
          },
        });
      } else {
        expect({ status: response.status, body: await response.json() }).toEqual({
          status: 409,
          body: {
            error: {
              code: "conflict",
              message: "ターミナルが 20 個動いています。使わないシェルを exit で終えてください",
            },
          },
        });
      }
    }
    const reused = await open();
    expect({ status: reused.status, body: await reused.json() }).toEqual({
      status: 200,
      body: {
        id: first,
        cwd: worktree,
        label: "worktree: try-2",
        conversationId: null,
        reused: true,
      },
    });
  });

  it("本人の判定をターミナルの有無より先に通す", async () => {
    const id = await openId();
    const denied = async (id: string) => {
      const { socket } = connect(id);
      return await new Promise<number | undefined>((resolve) =>
        socket.once("unexpected-response", (_request, response) => {
          response.resume();
          socket.terminate();
          resolve(response.statusCode);
        }),
      );
    };
    expect(await denied("missing")).toBe(404);
    allowTerminal = false;
    expect(await denied(id)).toBe(401);
    expect(await denied("missing")).toBe(401);
  });

  it("ターミナルはアプリを開いたオリジンから利用できる", async () => {
    const id = await openId();
    const origin = "http://example.invalid";
    const opening = await fetch(`${baseUrl}/api/terminals`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect({ status: opening.status, body: await opening.json() }).toEqual({
      status: 401,
      body: {
        error: { code: "unauthorized", message: "アプリを開いた画面から接続してください。" },
      },
    });
    const { socket } = connect(id, { origin });
    const [, denied] = await once(socket, "unexpected-response");
    denied.resume();
    socket.terminate();
    expect(denied.statusCode).toBe(401);
    const allowed = connect(id);
    await allowed.connected;
    expect(await allowed.wait(({ type }) => type === "snapshot")).toEqual({
      type: "snapshot",
      cols: 120,
      rows: 40,
      data: expect.any(String),
    });
  });

  it("削除中の worktree では開かず、排他が解けたら開ける", async () => {
    const activity = createWorktreeActivity(database.sqlite.name);
    const lock = activity.acquire(["w"])._unsafeUnwrap();
    try {
      const response = await open();
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 409,
        body: {
          error: {
            code: "conflict",
            message: "worktree を削除しています。完了してから、もう一度操作してください",
          },
        },
      });
    } finally {
      lock.release();
    }
    await openId();
  });

  it("64 KiB を超えるマルチバイト入力を拒否し、正しい resize を受け付ける", async () => {
    const id = await openId();
    const client = connect(id);
    await client.connected;
    await client.wait(({ type }) => type === "snapshot");
    client.send({ type: "input", data: "あ".repeat(21_846) });
    expect(await client.wait(({ type }) => type === "error")).toEqual({
      type: "error",
      message: "入力は 64 KiB までです。分けて送ってください。",
    });
    client.send({ type: "resize", cols: 94, rows: 27 });
    let output = "";
    client.send({ type: "input", data: "printf '\\n'; stty size\r" });
    await client.wait(
      (frame) => frame.type === "output" && /\r?\n27 94\r?\n/.test((output += frame.data)),
    );
    const next = connect(id);
    await next.connected;
    expect(await next.wait(({ type }) => type === "snapshot")).toEqual({
      type: "snapshot",
      cols: 94,
      rows: 27,
      data: expect.stringMatching(/27 94/),
    });
  });

  it("worktree の削除でシェルを終了し、接続中と再接続の両方へ終了を知らせる", async () => {
    const id = await openId();
    const client = connect(id);
    await client.connected;
    await client.wait(({ type }) => type === "snapshot");
    const deleted = await request("/api/worktrees/w", "DELETE");
    expect({ status: deleted.status, body: await deleted.json() }).toEqual({
      status: 200,
      body: { removedBranch: false, movedConversationIds: [] },
    });
    const exit = await client.wait(({ type }) => type === "exit");
    expect(exit).toEqual({ type: "exit", code: expect.any(Number), signal: 9 });
    const after = connect(id);
    await after.connected;
    expect(await after.wait(({ type }) => type === "exit")).toEqual(exit);
    expect(after.history.map(({ type }) => type)).toEqual(["snapshot", "exit"]);
    expect((await open()).status).toBe(404);
  });

  it("外部で消えた worktree の記録を片付けると最後のシェルも終了する", async () => {
    const client = connect(await openId());
    await client.connected;
    await client.wait(({ type }) => type === "snapshot");
    git(project, "worktree", "remove", worktree);
    const deleted = await request("/api/worktrees/w", "DELETE");
    expect({ status: deleted.status, body: await deleted.json() }).toEqual({
      status: 200,
      body: { removedBranch: false, movedConversationIds: [] },
    });
    expect(await client.wait(({ type }) => type === "exit")).toEqual({
      type: "exit",
      code: expect.any(Number),
      signal: 9,
    });
  });

  it.each([
    {
      mode: "前景",
      command: `/bin/sh -c 'printf "\\n%s%d\\n" job-pid: "$$"; exec /bin/sleep 20'`,
    },
    {
      mode: "バックグラウンド",
      command: `/bin/sleep 20 & printf "\\n%s%d\\n" job-pid: $!`,
    },
  ])("worktree を削除すると $mode ジョブも停止する", async ({ command }) => {
    const client = connect(await openId());
    await client.connected;
    await client.wait(({ type }) => type === "snapshot");
    client.send({ type: "input", data: command + "\r" });
    let output = "";
    let marker: RegExpMatchArray | null = null;
    await client.wait((frame) => {
      if (frame.type !== "output") return false;
      marker = (output += frame.data).match(/\r?\njob-pid:(\d+)\r?\n/);
      return marker !== null;
    });
    const pid = Number(marker![1]);
    const identity = activeFixtureJob(pid);
    expect(identity).toEqual(expect.any(String));
    try {
      const removed = await request("/api/worktrees/w", "DELETE");
      expect({ status: removed.status, body: await removed.json() }).toEqual({
        status: 200,
        body: { removedBranch: false, movedConversationIds: [] },
      });
      expect(await client.wait(({ type }) => type === "exit")).toEqual({
        type: "exit",
        code: expect.any(Number),
        signal: 9,
      });
      expect(activeFixtureJob(pid)).toBeNull();
    } finally {
      if (identity !== null && activeFixtureJob(pid) === identity) process.kill(pid, "SIGKILL");
    }
  });

  it("終了したシェルを開き直して新しい id を受け取る", async () => {
    const id = await openId();
    const exited = connect(id);
    await exited.connected;
    await exited.wait(({ type }) => type === "snapshot");
    exited.send({ type: "input", data: "exit 7\r" });
    expect(await exited.wait(({ type }) => type === "exit")).toEqual({
      type: "exit",
      code: 7,
      signal: null,
    });
    const reopened = await openId();
    expect(reopened).not.toBe(id);
    const current = connect(reopened);
    await current.connected;
    expect(await current.wait(({ type }) => type === "snapshot")).toEqual({
      type: "snapshot",
      cols: 120,
      rows: 40,
      data: expect.any(String),
    });
  });

  it.each(["削除", "終了", "開き直し"])(
    "通常 exit 後の%sで対象のジョブを残さない",
    async (action) => {
      const foreground = connect(await openId());
      const otherResponse = await open({ worktreeId: null });
      expect(otherResponse.status).toBe(201);
      const other = connect(terminalOpenedSchema.parse(await otherResponse.json()).id);
      const startJob = async (client: ReturnType<typeof connect>) => {
        await client.connected;
        await client.wait(({ type }) => type === "snapshot");
        client.send({
          type: "input",
          data: `/bin/sleep 20 & printf "\\n%s%d\\n" job-pid: $!\r`,
        });
        let output = "";
        let marker: RegExpMatchArray | null = null;
        await client.wait((frame) => {
          if (frame.type !== "output") return false;
          marker = (output += frame.data).match(/\r?\njob-pid:(\d+)\r?\n/);
          return marker !== null;
        });
        return Number(marker![1]);
      };
      const [job, otherJob] = await Promise.all([startJob(foreground), startJob(other)]);
      const jobIdentity = activeFixtureJob(job);
      const otherIdentity = activeFixtureJob(otherJob);
      expect([jobIdentity, otherIdentity]).toEqual([expect.any(String), expect.any(String)]);
      try {
        foreground.send({ type: "input", data: "exit 7\r" });
        expect(await foreground.wait(({ type }) => type === "exit")).toEqual({
          type: "exit",
          code: 7,
          signal: null,
        });
        if (action === "削除") {
          const removed = await request("/api/worktrees/w", "DELETE");
          expect({ status: removed.status, body: await removed.json() }).toEqual({
            status: 200,
            body: { removedBranch: false, movedConversationIds: [] },
          });
        } else if (action === "開き直し") {
          const reopened = connect(await openId());
          await reopened.connected;
          expect(await reopened.wait(({ type }) => type === "snapshot")).toEqual({
            type: "snapshot",
            cols: 120,
            rows: 40,
            data: expect.any(String),
          });
        }
        expect(activeFixtureJob(otherJob)).toBe(otherIdentity);
        if (action !== "削除") await sessions.close();
        expect(activeFixtureJob(job)).toBeNull();
        expect(activeFixtureJob(otherJob)).toBe(action === "削除" ? otherIdentity : null);
      } finally {
        if (jobIdentity && activeFixtureJob(job) === jobIdentity) process.kill(job, "SIGKILL");
      }
    },
  );
});
