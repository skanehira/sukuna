import { z } from "zod";
import { errorResponseSchema } from "../../shared/api";
import {
  inboxResponseSchema,
  projectsResponseSchema,
  overviewResponseSchema,
  type InboxResponse,
  type ProjectsResponse,
  type OverviewResponse,
} from "../../shared/inbox/schema";
import type { ServerMessage } from "../../shared/ws";

export type InboxApi = {
  inbox: () => Promise<InboxResponse>;
  projects: () => Promise<ProjectsResponse>;
  overview: (id: string, closed: boolean) => Promise<OverviewResponse>;
};
type Failure = { code: string; message: string };
type QueuedRefresh = { after: Promise<void>; promise: Promise<void> };
export class InboxApiError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export function createInboxApi(
  fetcher: typeof fetch,
): InboxApi & { withdraw: (id: string) => Promise<{ stoppedDependents: number[] }> } {
  async function request<T>(path: string, schema: z.ZodType<T>, method = "GET"): Promise<T> {
    const response = await fetcher(path, { method });
    if (!response.ok) {
      const failure = errorResponseSchema.safeParse(await response.json().catch(() => null));
      throw new InboxApiError(
        failure.success ? failure.data.error.code : "network_error",
        failure.success
          ? failure.data.error.message
          : "一覧を取得できませんでした。再読み込みしてください。",
        response.status,
      );
    }
    return schema.parse(await response.json());
  }
  return {
    inbox: () => request("/api/inbox", inboxResponseSchema),
    projects: () => request("/api/projects", projectsResponseSchema),
    overview: (id, closed) =>
      request(
        `/api/projects/${encodeURIComponent(id)}/overview${closed ? "?closed=all" : ""}`,
        overviewResponseSchema,
      ),
    withdraw: (id) =>
      request(
        `/api/issues/${encodeURIComponent(id)}/withdraw`,
        z.object({ stoppedDependents: z.array(z.number()) }),
        "POST",
      ),
  };
}
export type InboxEnvironment = {
  now(): number;
  schedule(callback: () => void, ms: number): () => void;
  storage: Pick<Storage, "getItem" | "setItem">;
};
export type ListingSnapshot<T> = {
  data: T | null;
  error: Failure | null;
  loading: boolean;
  now: number;
};
export class ListingResource<T> {
  private state: ListingSnapshot<T>;
  private listeners = new Set<() => void>();
  private pending: Promise<void> | null = null;
  private queuedRefresh: QueuedRefresh | null = null;
  private changed = false;
  private changedWaiting: Promise<void> | null = null;
  private cancelChange?: () => void;
  private lastStartedAt = -Infinity;
  private cancelClock?: () => void;
  private fetchData: () => Promise<T>;
  private env: InboxEnvironment;
  private onData?: (data: T) => void;
  private retries = 0;
  private disposed = false;
  constructor(fetchData: () => Promise<T>, env: InboxEnvironment, onData?: (data: T) => void) {
    this.fetchData = fetchData;
    this.env = env;
    this.onData = onData;
    this.state = { data: null, error: null, loading: true, now: env.now() };
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    const first = this.listeners.size === 0;
    this.listeners.add(listener);
    if (first) {
      void this.refresh();
      this.tick();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.cancelClock?.();
      if (!this.active()) {
        this.cancelChange?.();
        this.cancelChange = undefined;
        this.changed = false;
      }
    };
  };
  active() {
    return !this.disposed && (this.listeners.size > 0 || this.onData !== undefined);
  }
  private publish(patch: Partial<ListingSnapshot<T>>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private tick() {
    this.cancelClock = this.env.schedule(() => {
      this.publish({ now: this.env.now() });
      if (this.listeners.size > 0) this.tick();
    }, 30000);
  }
  invalidate() {
    if (!this.active()) return;
    this.retries = 2;
    this.changed = true;
    this.scheduleChange(1000);
  }
  private scheduleChange(delay: number) {
    if (!this.changed || this.cancelChange || this.changedWaiting) return;
    this.cancelChange = this.env.schedule(
      () => {
        this.cancelChange = undefined;
        if (!this.changed || !this.active()) return;
        if (this.pending) {
          const waiting = this.pending;
          this.changedWaiting = waiting;
          void waiting.then(() => {
            if (this.changedWaiting === waiting) this.changedWaiting = null;
            this.scheduleChange(0);
          });
        } else if (this.env.now() < this.lastStartedAt + 1000) {
          this.scheduleChange(this.lastStartedAt + 1000 - this.env.now());
        } else void this.request();
      },
      Math.max(delay, this.lastStartedAt + 1000 - this.env.now()),
    );
  }
  refresh(): Promise<void> {
    if (!this.active()) return Promise.resolve();
    this.retries = 2;
    if (!this.pending) return this.request();
    if (this.queuedRefresh?.after === this.pending) return this.queuedRefresh.promise;
    const queued: QueuedRefresh = {
      after: this.pending,
      promise: this.pending
        .then(async () => {
          if (this.active()) await this.request();
        })
        .finally(() => {
          if (this.queuedRefresh === queued) this.queuedRefresh = null;
        }),
    };
    this.queuedRefresh = queued;
    return queued.promise;
  }
  load = (): Promise<void> => this.queuedRefresh?.promise ?? this.request();
  private request(): Promise<void> {
    if (this.pending) return this.pending;
    this.lastStartedAt = this.env.now();
    this.changed = false;
    this.cancelChange?.();
    this.cancelChange = undefined;
    this.publish({ loading: this.state.data === null });
    this.pending = this.fetchData()
      .then(
        (data) => {
          if (this.disposed) return;
          this.publish({ data, error: null, loading: false, now: this.env.now() });
          this.onData?.(data);
        },
        (error: unknown) => {
          if (this.disposed) return;
          this.publish({
            error: {
              code: error instanceof InboxApiError ? error.code : "network_error",
              message:
                error instanceof Error
                  ? error.message
                  : "一覧を取得できませんでした。再読み込みしてください。",
            },
            loading: false,
          });
          if (
            this.onData &&
            !this.changed &&
            this.queuedRefresh?.after !== this.pending &&
            this.retries > 0 &&
            (error instanceof TypeError ||
              (error instanceof InboxApiError && (error.status ?? 0) >= 500))
          ) {
            this.retries--;
            this.changed = true;
            this.scheduleChange(0);
          }
        },
      )
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
  dispose() {
    this.disposed = true;
    this.cancelClock?.();
    this.cancelChange?.();
    this.changed = false;
    this.listeners.clear();
  }
}

export class InboxStore {
  readonly inbox: ListingResource<InboxResponse>;
  readonly projects: ListingResource<ProjectsResponse>;
  private overviews = new Map<string, ListingResource<OverviewResponse>>();
  private expanded = new Map<string, Set<string>>();
  private api: InboxApi;
  private env: InboxEnvironment;
  constructor(api: InboxApi, env: InboxEnvironment, onInboxData?: (data: InboxResponse) => void) {
    this.api = api;
    this.env = env;
    this.inbox = new ListingResource(api.inbox, env, onInboxData);
    this.projects = new ListingResource(api.projects, env);
  }
  overview(id: string) {
    let resource = this.overviews.get(id);
    if (!resource) {
      resource = new ListingResource(
        () => this.api.overview(id, this.expandedStates(id).size > 0),
        this.env,
      );
      this.overviews.set(id, resource);
    }
    return resource;
  }
  private expandedStates(id: string): Set<string> {
    let states = this.expanded.get(id);
    if (!states) {
      let value: unknown;
      try {
        value = JSON.parse(this.env.storage.getItem(`sukuna:overview:${id}:expanded`) ?? "[]");
      } catch {
        value = [];
      }
      states = new Set(
        Array.isArray(value)
          ? value.filter((state) => state === "done" || state === "withdrawn")
          : [],
      );
      this.expanded.set(id, states);
    }
    return states;
  }
  isExpanded(id: string, state: string) {
    return this.expandedStates(id).has(state);
  }
  async expandClosed(id: string, state = "done") {
    const states = this.expandedStates(id);
    states.add(state);
    try {
      this.env.storage.setItem(`sukuna:overview:${id}:expanded`, JSON.stringify([...states]));
    } catch {}
    await this.overview(id).refresh();
  }
  receive = (message: ServerMessage) => {
    if (message.topic !== "inbox" || message.type !== "changed") return;
    this.inbox.invalidate();
    this.projects.invalidate();
    for (const id of message.payload.project_ids ?? []) this.overviews.get(id)?.invalidate();
  };
  reload = async () => {
    await Promise.all(
      [this.inbox, this.projects, ...this.overviews.values()]
        .filter((resource) => resource.active())
        .map((resource) => resource.refresh()),
    );
  };
  dispose() {
    for (const resource of [this.inbox, this.projects, ...this.overviews.values()])
      resource.dispose();
  }
}
