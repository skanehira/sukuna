import { diffSchema } from "../../../shared/events";
import type { ServerMessage } from "../../../shared/ws";
import type { Conversation, EventsPage } from "../conversation/types";
import type { Realtime } from "../realtime";
import type { FilesApi } from "./api";
import type { FileRecovery, FileScope } from "./context";

export function fileDiff(message: ServerMessage) {
  if (message.type !== "event" || message.payload.type !== "diff") return undefined;
  return diffSchema.safeParse(message.payload.payload).data;
}

type Listener = (message: ServerMessage) => void;
type EventMessage = Extract<ServerMessage, { type: "event" }>;
type Stream = {
  after: number;
  pending: Set<number>;
  recovering: boolean;
  retry: boolean;
  stop: () => void;
};
type Watch = {
  listeners: Set<Listener>;
  recoveryListeners: Set<{ thread(id: string): void; reconnected(): void }>;
  topics: Map<string, Stream>;
  previousThreads: Map<string, number>;
  threads?: Set<string>;
  request?: AbortController;
};

function topicFor(id: string): string {
  return `conversation:${id}`;
}

function conversationId(topic: string): string {
  return topic.slice("conversation:".length);
}

export function createFileRealtime(
  realtime: Realtime,
  api: FilesApi,
  getConversation: (id: string) => Promise<Conversation>,
  events: (id: string, after: number) => Promise<EventsPage>,
  unavailable: (message: string) => void,
  seen: (id: string) => number | undefined,
) {
  const watches = new Map<string, Watch>();
  const threadsUnavailable = () => unavailable("スレッドのファイル変更を購読できませんでした");

  function add(watch: Watch, id: string, after: number) {
    const topic = topicFor(id);
    if (watch.topics.has(topic)) return;
    watch.topics.set(topic, {
      after,
      pending: new Set(),
      recovering: false,
      retry: false,
      stop: realtime.subscribe(topic, Math.min(after, seen(id) ?? after)),
    });
  }

  async function baselines(ids: string[], signal: AbortSignal) {
    const results = await Promise.allSettled(ids.map(getConversation));
    if (signal.aborted) return undefined;
    return new Map(
      ids.map((id, index) => {
        const result = results[index];
        return [id, result.status === "fulfilled" ? result.value.lastSeq : null];
      }),
    );
  }

  async function discover(id: string, watch: Watch) {
    watch.request?.abort();
    const request = new AbortController();
    watch.request = request;
    try {
      const expected = new Set((await api.threads(id, request.signal)).map((thread) => thread.id));
      if (request.signal.aborted) return;
      expected.delete(id);
      const needsBaseline = [...expected].filter(
        (thread) =>
          !watch.topics.has(topicFor(thread)) &&
          !watch.previousThreads.has(thread) &&
          (watch.threads === undefined || watch.threads.has(thread)),
      );
      const known = await baselines(needsBaseline, request.signal);
      if (!known) return;
      for (const [topic, stream] of watch.topics) {
        const thread = conversationId(topic);
        if (thread === id || expected.has(thread)) continue;
        watch.previousThreads.set(thread, stream.after);
        stream.stop();
        watch.topics.delete(topic);
      }
      for (const thread of expected) {
        if (watch.topics.has(topicFor(thread))) continue;
        const after = known.get(thread);
        if (after === null) threadsUnavailable();
        else {
          add(watch, thread, watch.previousThreads.get(thread) ?? after ?? 0);
          watch.recoveryListeners.forEach((listener) => listener.thread(thread));
        }
      }
      watch.threads = expected;
    } catch {
      if (!request.signal.aborted) threadsUnavailable();
    } finally {
      if (watch.request === request) watch.request = undefined;
    }
  }

  function readStart(scope: FileScope): FileScope {
    const watch = watches.get(scope.id);
    const after = new Map(scope.threads?.after);
    const observedThrough = new Map<string, number>();
    const position = (id: string, metadata: number | null) => {
      const stream = watch?.topics.get(topicFor(id));
      const checkpoint = Math.max(
        metadata ?? -1,
        stream?.after ?? watch?.previousThreads.get(id) ?? -1,
        seen(id) ?? -1,
      );
      let observed = checkpoint;
      for (const seq of stream?.pending ?? []) observed = Math.max(observed, seq);
      if (observed > checkpoint) observedThrough.set(id, observed);
      return checkpoint < 0 ? null : checkpoint;
    };

    const lastSeq = position(scope.id, scope.lastSeq) ?? scope.lastSeq;
    const threads = new Set([...after.keys(), ...(watch?.threads ?? [])]);
    for (const topic of watch?.topics.keys() ?? []) threads.add(conversationId(topic));
    threads.delete(scope.id);
    for (const id of threads) after.set(id, position(id, after.get(id) ?? null));
    return {
      ...scope,
      lastSeq,
      threads: { complete: scope.threads?.complete ?? false, after },
      observedThrough,
    };
  }

  function receiveEvent(watch: Watch, stream: Stream, message: EventMessage) {
    if (message.seq <= stream.after || stream.pending.has(message.seq)) return;
    stream.pending.add(message.seq);
    while (stream.pending.delete(stream.after + 1)) stream.after++;
    watch.listeners.forEach((listener) => listener(message));
  }

  async function replay(
    topic: string,
    after: number,
    active: () => boolean,
    deliver: (message: EventMessage) => void,
    through = Infinity,
  ) {
    const id = conversationId(topic);
    try {
      while (after < through && active()) {
        const page = await events(id, after);
        if (!active()) return;
        for (const event of page.events) {
          if (event.seq <= after || event.seq > through) continue;
          deliver({
            topic,
            type: "event",
            seq: event.seq,
            payload: {
              ...event,
              conversation_id: id,
              created_at: event.createdAt,
              sdk_uuid: event.sdkUuid ?? null,
            },
          });
        }
        const next = page.events.at(-1)?.seq ?? after;
        if (!page.hasMore || next <= after) return;
        after = next;
      }
    } catch {
      if (active()) unavailable("ファイルの変更を読み直せませんでした");
    }
  }

  async function recover(watch: Watch, topic: string, stream: Stream) {
    if (stream.recovering) {
      stream.retry = true;
      return;
    }
    stream.recovering = true;
    const active = () => watch.topics.get(topic) === stream;
    try {
      await replay(topic, stream.after, active, (message) => receiveEvent(watch, stream, message));
    } finally {
      stream.recovering = false;
      if (stream.retry && active()) {
        stream.retry = false;
        void recover(watch, topic, stream);
      }
    }
  }

  return {
    readStart,
    async prepare(scope: FileScope, signal = new AbortController().signal): Promise<FileScope> {
      try {
        const threads = await api.threads(scope.id, signal);
        if (signal.aborted) return scope;
        const after = await baselines(
          threads.map((thread) => thread.id).filter((id) => id !== scope.id),
          signal,
        );
        return after ? { ...scope, threads: { complete: true, after } } : scope;
      } catch {
        if (!signal.aborted) threadsUnavailable();
        return scope;
      }
    },
    subscribe(scope: FileScope, listener: Listener, recovery?: FileRecovery): () => void {
      let watch = watches.get(scope.id);
      if (!watch) {
        watch = {
          listeners: new Set(),
          recoveryListeners: new Set(),
          topics: new Map(),
          previousThreads: new Map(),
          threads: scope.threads?.complete ? new Set(scope.threads.after.keys()) : undefined,
        };
        watches.set(scope.id, watch);
        add(watch, scope.id, scope.lastSeq);
      }
      const group = watch;
      for (const [id, after] of scope.threads?.after ?? []) {
        group.threads?.add(id);
        if (after !== null) add(group, id, after);
      }
      const atOpen = (id: string) => {
        const observed = scope.observedThrough?.get(id);
        if (observed !== undefined) return observed;
        if (id === scope.id) return scope.lastSeq;
        const after = scope.threads?.after.get(id);
        return after === undefined ? (recovery && !scope.threads?.complete ? null : 0) : after;
      };
      const receive: Listener = (message) => {
        if (message.type !== "event") return;
        const after = atOpen(conversationId(message.topic));
        if (after === null || message.seq > after) listener(message);
      };
      const recovered = {
        thread(id: string) {
          if (atOpen(id) === null) recovery?.recheck();
        },
        reconnected() {
          recovery?.reconnected();
        },
      };
      group.listeners.add(receive);
      if (recovery) {
        group.recoveryListeners.add(recovered);
        for (const [topic, stream] of group.topics) {
          const id = conversationId(topic);
          const after = atOpen(id);
          if (after === null) {
            recovered.thread(id);
            continue;
          }
          const contiguous = stream.after;
          const pending = new Set(stream.pending);
          let through = contiguous;
          for (const seq of pending) through = Math.max(through, seq);
          if (after >= through) continue;
          const active = () =>
            !recovery.replaySignal.aborted &&
            group.listeners.has(receive) &&
            group.topics.get(topic) === stream;
          void replay(
            topic,
            after,
            active,
            (message) => {
              if (message.seq <= contiguous || pending.has(message.seq)) receive(message);
            },
            through,
          );
        }
      }
      if (!group.request) void discover(scope.id, group);
      return () => {
        group.listeners.delete(receive);
        group.recoveryListeners.delete(recovered);
        if (group.listeners.size !== 0) return;
        watches.delete(scope.id);
        group.request?.abort();
        for (const { stop } of group.topics.values()) stop();
        group.topics.clear();
      };
    },
    receive(message: ServerMessage) {
      for (const [id, watch] of watches) {
        const stream = watch.topics.get(message.topic);
        if (!stream) continue;
        if (message.type === "event") {
          receiveEvent(watch, stream, message);
          if (stream.pending.size > 0) void recover(watch, message.topic, stream);
        } else if (
          message.type === "changed" &&
          message.topic === topicFor(id) &&
          message.payload.parts?.includes("threads")
        ) {
          void discover(id, watch);
        }
      }
    },
    reload(topic: string) {
      for (const watch of watches.values()) {
        const stream = watch.topics.get(topic);
        if (stream) void recover(watch, topic, stream);
      }
    },
    connected() {
      for (const [id, watch] of watches) {
        watch.recoveryListeners.forEach((listener) => listener.reconnected());
        void discover(id, watch);
      }
    },
  };
}
