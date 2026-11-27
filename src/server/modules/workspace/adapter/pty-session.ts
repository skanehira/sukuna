/// <reference types="vite/client" />

import { err, ok, type Result } from "neverthrow";
import { realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn, type IPty } from "node-pty";
import { ulid } from "ulid";
import type { TerminalOutputFrame } from "../../../../shared/api/terminal";
import type { TerminalError, TerminalSessionsPort } from "../domain/terminal-ports";
import { stopTerminalJobs, terminalDirectoryKey } from "./terminal-jobs";
import supervisorCode from "./terminal-jobs.ts?raw";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");
const { SerializeAddon } =
  require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");

const TERM = "xterm-256color";
const MAX_RUNNING = 20;
const SCROLLBACK = 10_000;
const PAUSE_OUTPUT_AT = 1024 * 1024;
const RESUME_OUTPUT_AT = 128 * 1024;

type SendFrame = (frame: TerminalOutputFrame) => void;
export type TerminalConnection = {
  subscribe(send: SendFrame): () => void;
  input(data: string): void;
  resize(cols: number, rows: number): void;
};

export type PtySessions = TerminalSessionsPort & {
  find(id: string): TerminalConnection | undefined;
  close(): Promise<void>;
};

function openSession(pty: IPty, cols: number, rows: number) {
  const terminal = new Terminal({
    cols,
    rows,
    scrollback: SCROLLBACK,
    logLevel: "off",
    allowProposedApi: true,
  });
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);
  const clients = new Set<SendFrame>();
  let markExited: () => void;
  const exit = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  let running = true;
  let exitFrame: Extract<TerminalOutputFrame, { type: "exit" }> | undefined;
  let queuedOutput = 0;
  let paused = false;
  let ending: Promise<void> | undefined;

  pty.onData((data) => {
    queuedOutput += data.length;
    if (!paused && queuedOutput >= PAUSE_OUTPUT_AT) {
      paused = true;
      pty.pause();
    }
    terminal.write(data, () => {
      queuedOutput -= data.length;
      for (const send of clients) send({ type: "output", data });
      if (paused && running && queuedOutput <= RESUME_OUTPUT_AT) {
        paused = false;
        pty.resume();
      }
    });
  });
  pty.onExit(({ exitCode, signal }) => {
    running = false;
    terminal.write("", () => {
      exitFrame = { type: "exit", code: exitCode, signal: signal || null };
      for (const send of clients) send(exitFrame);
      clients.clear();
      markExited();
    });
  });

  const connection: TerminalConnection = {
    subscribe(send) {
      let subscribed = true;
      terminal.write("", () => {
        if (!subscribed) return;
        send({
          type: "snapshot",
          data: serializer.serialize(),
          cols: terminal.cols,
          rows: terminal.rows,
        });
        if (exitFrame) send(exitFrame);
        else clients.add(send);
      });
      return () => {
        subscribed = false;
        clients.delete(send);
      };
    },
    input(data) {
      if (running && !ending) pty.write(data);
    },
    resize(cols, rows) {
      if (!running || ending) return;
      pty.resize(cols, rows);
      terminal.write("", () => terminal.resize(cols, rows));
    },
  };

  return {
    connection,
    get running() {
      return running;
    },
    end() {
      ending ??= (async () => {
        if (running) await stopTerminalJobs(pty, () => running);
        const controller = new AbortController();
        try {
          await Promise.race([
            exit,
            sleep(2000, undefined, { signal: controller.signal }).then(() => {
              throw new Error("端末の終了を確認できませんでした。");
            }),
          ]);
        } finally {
          controller.abort();
        }
      })().catch((error: unknown) => {
        ending = undefined;
        throw error;
      });
      return ending;
    },
    async dispose() {
      await exit;
      terminal.write("", () => terminal.dispose());
    },
  };
}

type Session = ReturnType<typeof openSession> & {
  id: string;
  paths: Set<string>;
  destinations: Map<string, string>;
};

function directoryAt(path: string): Result<{ cwd: string; key: string }, TerminalError> {
  const missing = {
    code: "not_found",
    message: "ターミナルの作業ディレクトリがありません。",
  } as const;
  try {
    const cwd = realpathSync(path);
    const stat = statSync(cwd, { bigint: true });
    return stat.isDirectory() ? ok({ cwd, key: terminalDirectoryKey(stat) }) : err(missing);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return err(missing);
    return err({ code: "internal", message: "ターミナルの作業ディレクトリを開けませんでした。" });
  }
}

export function createPtySessions(
  options: {
    env?: NodeJS.ProcessEnv;
    spawn?: typeof spawn;
  } = {},
): PtySessions {
  const paths = new Map<string, Session>();
  const directories = new Map<string, Session>();
  const ids = new Map<string, Session>();
  let closed = false;

  function byPath(path: string, includeMissing = false): Session | undefined {
    const current = directoryAt(path);
    if (current.isOk()) return directories.get(current.value.key);
    if (includeMissing && current.error.code === "not_found") return paths.get(path);
    return undefined;
  }

  return {
    open(location, size) {
      if (closed) return err({ code: "conflict", message: "端末を終了しています。" });
      const found = directoryAt(location.path);
      if (found.isErr()) return err(found.error);
      const { cwd, key } = found.value;
      let session = directories.get(key);
      const reused = session?.running ?? false;
      if (!session || !session.running) {
        if ([...ids.values()].filter((old) => old.running).length >= MAX_RUNNING)
          return err({
            code: "conflict",
            message: "ターミナルが 20 個動いています。使わないシェルを exit で終えてください",
          });

        const env = options.env ?? process.env;
        const shellEnv = Object.fromEntries(
          Object.entries(env).filter(([key]) => !key.startsWith("SUKUNA_")),
        );
        const id = ulid();
        let pty: IPty | undefined;
        try {
          pty = (options.spawn ?? spawn)(
            process.execPath,
            [
              "--input-type=module-typescript",
              "--eval",
              `${supervisorCode}\nawait superviseTerminal(...process.argv.slice(1));`,
              "--",
              env.SHELL || "/bin/zsh",
              cwd,
              key,
            ],
            {
              cwd: "/",
              cols: size.cols,
              rows: size.rows,
              env: { ...shellEnv, TERM },
              name: TERM,
            },
          );
          const next = Object.assign(openSession(pty, size.cols, size.rows), {
            id,
            paths: new Set([cwd]),
            destinations: session?.destinations ?? new Map<string, string>(),
          });
          if (session) {
            ids.delete(session.id);
            for (const alias of session.paths)
              if (paths.get(alias) === session) paths.delete(alias);
            void session.dispose();
          }
          directories.set(key, next);
          ids.set(next.id, next);
          session = next;
        } catch {
          pty?.kill("SIGKILL");
          return err({
            code: "internal",
            message: "シェルを開けませんでした。設定を確かめてください。",
          });
        }
      }

      session.paths.add(location.path);
      session.paths.add(cwd);
      paths.set(location.path, session);
      paths.set(cwd, session);
      if (size.conversationId !== null)
        session.destinations.set(location.projectId, size.conversationId);
      return ok({
        id: session.id,
        cwd,
        label: location.label,
        conversationId: session.destinations.get(location.projectId) ?? null,
        reused,
      });
    },
    runningId(path) {
      const session = byPath(path);
      return session?.running ? session.id : null;
    },
    async endAt(path) {
      await byPath(path, true)?.end();
    },
    find(id) {
      return ids.get(id)?.connection;
    },
    async close() {
      closed = true;
      const sessions = [...ids.values()];
      ids.clear();
      paths.clear();
      directories.clear();
      await Promise.all(
        sessions.map(async (session) => {
          await session.end();
          await session.dispose();
        }),
      );
    },
  };
}
