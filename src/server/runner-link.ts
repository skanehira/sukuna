import { request, type ClientRequest } from "node:http";
import { err, ok, type Result } from "neverthrow";
import { runnerNoticeSchema, type RunnerNotice } from "../shared/ipc";
import type { Logger } from "../shared/log";
type Clock = { setTimeout(callback: () => void, ms: number): () => void };

export type RunnerUnavailable = { code: "runner_unavailable"; message: string };
export const runnerUnavailable: RunnerUnavailable = {
  code: "runner_unavailable",
  message: "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
};
export type IpcResponse = { status: number; body: unknown };
type Options = {
  socket: string;
  log: Logger;
  notice: (notice: RunnerNotice) => void;
  connection: (connected: boolean) => void;
  clock?: Clock;
};
export class RunnerLink {
  private stopped = true;
  private stream: ClientRequest | undefined;
  private retry: (() => void) | undefined;
  private connected = false;
  private clock: Clock;
  private options: Options;
  constructor(options: Options) {
    this.options = options;
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
  ): Promise<Result<IpcResponse, RunnerUnavailable>> {
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
          headers: input === undefined ? {} : { "content-type": "application/json" },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (part: string) => {
            body += part;
          });
          res.on("end", () => {
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
      }, 10000);
      req.end(input === undefined ? undefined : JSON.stringify(input));
    });
  }
  async forward(method: string, path: string, input?: unknown): Promise<Response> {
    if (!this.connected) return Response.json({ error: runnerUnavailable }, { status: 503 });
    const result = await this.call(method, path, input);
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
      { socketPath: this.options.socket, path: "/changes", method: "GET" },
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
              if (parsed.success) this.options.notice(parsed.data);
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
