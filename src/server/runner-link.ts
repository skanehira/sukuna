import { request, type ClientRequest } from "node:http";
import { err, ok, type Result } from "neverthrow";
import {
  RUNNER_IPC_DEADLINE_HEADER,
  RUNNER_IPC_TIMEOUT_MS,
  TERMINAL_CLEANUP_HEADER,
  type TerminalCleanupRequest,
  runnerNoticeSchema,
  unavailableRunnerError,
  type RunnerNotice,
} from "../shared/ipc";
import type { Logger } from "../shared/log";
type Clock = { setTimeout(callback: () => void, ms: number): () => void };
type CallOptions = { missingRouteMessage: string };

export type RunnerUnavailable = { code: "runner_unavailable"; message: string };
export const runnerUnavailable: RunnerUnavailable = unavailableRunnerError;
export type IpcResponse = { status: number; body: unknown };
type Options = {
  socket: string;
  log: Logger;
  notice: (notice: RunnerNotice) => void;
  connection: (connected: boolean) => void;
  terminalCleanup?: (request: TerminalCleanupRequest) => (() => Promise<void>) | undefined;
  clock?: Clock;
  now?: () => number;
};
export class RunnerLink {
  private stopped = true;
  private stream: ClientRequest | undefined;
  private retry: (() => void) | undefined;
  private connected = false;
  private clock: Clock;
  private now: () => number;
  private options: Options;
  constructor(options: Options) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.clock = options.clock ?? {
      setTimeout: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref();
        return () => clearTimeout(timer);
      },
    };
  }
  async call(
    method: string,
    path: string,
    input?: unknown,
    options?: CallOptions,
  ): Promise<Result<IpcResponse, RunnerUnavailable>> {
    const deadline = this.now() + RUNNER_IPC_TIMEOUT_MS;
    return new Promise((resolve) => {
      let cancelTimeout = () => {};
      const finish = (result: Result<IpcResponse, RunnerUnavailable>) => {
        cancelTimeout();
        resolve(result);
      };
      const req = request(
        {
          socketPath: this.options.socket,
          path,
          method,
          headers: {
            [RUNNER_IPC_DEADLINE_HEADER]: String(deadline),
            ...(input === undefined ? {} : { "content-type": "application/json" }),
          },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (part: string) => {
            body += part;
          });
          res.on("end", () => {
            if (options && res.statusCode === 404 && body === "404 Not Found") {
              finish(err({ code: "runner_unavailable", message: options.missingRouteMessage }));
              return;
            }
            try {
              finish(ok({ status: res.statusCode ?? 500, body: body ? JSON.parse(body) : null }));
            } catch {
              finish(err(runnerUnavailable));
            }
          });
          res.on("error", () => finish(err(runnerUnavailable)));
        },
      );
      req.on("error", () => finish(err(runnerUnavailable)));
      cancelTimeout = this.clock.setTimeout(() => {
        req.destroy(new Error("runner timeout"));
        finish(err(runnerUnavailable));
      }, RUNNER_IPC_TIMEOUT_MS);
      req.end(input === undefined ? undefined : JSON.stringify(input));
    });
  }
  async forward(
    method: string,
    path: string,
    input?: unknown,
    options?: CallOptions,
  ): Promise<Response> {
    if (!this.connected) return Response.json({ error: runnerUnavailable }, { status: 503 });
    const result = await this.call(method, path, input, options);
    return result.isErr()
      ? Response.json({ error: result.error }, { status: 503 })
      : Response.json(result.value.body, { status: result.value.status });
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }
  stop(): void {
    this.stopped = true;
    this.status(false);
    this.retry?.();
    this.stream?.destroy();
    this.stream = undefined;
  }
  private status(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.options.log({
      level: "warn",
      component: "server.runner-link",
      message: connected ? "ランナーにつながりました。" : "ランナーとの接続が切れました。",
    });
    this.options.connection(connected);
  }
  private async closeTerminal(request: TerminalCleanupRequest) {
    if (this.stopped || this.now() >= request.expires_at) return;
    const end = this.options.terminalCleanup?.(request);
    const keys = {
      request_id: request.request_id,
      worktree_id: request.worktree_id,
      directory_key: request.directory_key,
    };
    const claimed = await this.call("POST", "/flow/terminal-cleanup", { ...keys, step: "claim" });
    if (
      claimed.isErr() ||
      claimed.value.status !== 200 ||
      this.stopped ||
      this.now() >= request.expires_at
    )
      return;
    let closed = false;
    if (end) {
      try {
        await end();
        closed = true;
      } catch {
        closed = false;
      }
    }
    await this.call("POST", "/flow/terminal-cleanup", {
      ...keys,
      step: closed ? "closed" : "defer",
    });
  }

  private connect(): void {
    if (this.stopped) return;
    let finished = false;
    const reconnect = () => {
      if (finished) return;
      finished = true;
      this.status(false);
      if (!this.stopped) this.retry = this.clock.setTimeout(() => this.connect(), 1000);
    };
    const req = request(
      {
        socketPath: this.options.socket,
        path: "/changes",
        method: "GET",
        headers: this.options.terminalCleanup ? { [TERMINAL_CLEANUP_HEADER]: "1" } : undefined,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reconnect();
          return;
        }
        this.status(true);
        let pending = "";
        res.setEncoding("utf8");
        res.on("data", (part: string) => {
          pending += part;
          let end: number;
          while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            try {
              const parsed = runnerNoticeSchema.safeParse(JSON.parse(line));
              if (!parsed.success) continue;
              if (parsed.data.kind === "worktree_terminal_close")
                void this.closeTerminal(parsed.data).catch(() => {});
              else this.options.notice(parsed.data);
            } catch {
              this.options.log({
                level: "error",
                component: "server.runner-link",
                message: "ランナーの知らせを読み取れませんでした。",
              });
            }
          }
        });
        res.on("end", reconnect);
        res.on("close", reconnect);
        res.on("error", reconnect);
      },
    );
    this.stream = req;
    req.on("error", reconnect);
    req.end();
  }
}
