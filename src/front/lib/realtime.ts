import { serverMessageSchema, type ClientMessage, type ServerMessage } from "../../shared/ws";

export type RealtimeSocket = {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  send(data: string): void;
  close(): void;
};
type Options = {
  connect: () => RealtimeSocket;
  setTimeout: (callback: () => void, ms: number) => () => void;
  unavailable: (value: boolean) => void;
  reload: (topic: string) => void;
  gap: (topic: string) => void;
  message: (message: ServerMessage) => void;
};
export class Realtime {
  private topics = new Map<string, { after: number; count: number }>();
  private shownTopics: string[] = [];
  private visible = true;
  private socket: RealtimeSocket | undefined;
  private opened = false;
  private stopped = true;
  private delay = 500;
  private retry: (() => void) | undefined;
  private offline: (() => void) | undefined;
  private watchdog: (() => void) | undefined;
  private options: Options;
  constructor(options: Options) {
    this.options = options;
  }
  subscribe(topic: string, after = 0): () => void {
    const existing = this.topics.get(topic);
    if (existing) {
      existing.count++;
      existing.after = Math.max(after, existing.after);
    } else {
      this.topics.set(topic, { after, count: 1 });
      this.send({ op: "subscribe", topic, ...(this.persistent(topic) ? { after } : {}) });
    }
    return () => this.unsubscribe(topic);
  }
  unsubscribe(topic: string): void {
    const subscription = this.topics.get(topic);
    if (!subscription) return;
    if (--subscription.count > 0) return;
    this.topics.delete(topic);
    this.send({ op: "unsubscribe", topic });
  }
  shown(topics: string[]): void {
    this.shownTopics = [...topics];
    this.send({ op: "shown", topics });
  }
  visibility(visible: boolean): void {
    this.visible = visible;
    this.send({ op: "visibility", visible });
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }
  stop(): void {
    this.stopped = true;
    this.retry?.();
    this.offline?.();
    this.offline = undefined;
    this.watchdog?.();
    this.socket?.close();
    this.socket = undefined;
    this.opened = false;
  }
  private persistent(topic: string): boolean {
    return topic.startsWith("conversation:") || topic.startsWith("issue:");
  }
  private send(message: ClientMessage): void {
    if (this.opened) this.socket?.send(JSON.stringify(message));
  }
  private touch(): void {
    this.watchdog?.();
    this.watchdog = this.options.setTimeout(() => this.socket?.close(), 45000);
  }
  private connect(): void {
    if (this.stopped) return;
    const socket = this.options.connect();
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) return;
      this.opened = true;
      this.delay = 500;
      this.offline?.();
      this.offline = undefined;
      this.options.unavailable(false);
      this.touch();
      for (const [topic, subscription] of this.topics) {
        this.send({
          op: "subscribe",
          topic,
          ...(this.persistent(topic) ? { after: subscription.after } : {}),
        });
        this.options.reload(topic);
      }
      this.send({ op: "visibility", visible: this.visible });
      this.send({ op: "shown", topics: this.shownTopics });
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || this.stopped) return;
      this.touch();
      let value: unknown;
      try {
        value = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = serverMessageSchema.safeParse(value);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === "ping") return;
      const subscription = this.topics.get(message.topic);
      if (!subscription) return;
      if (message.type === "event") {
        if (message.seq <= subscription.after) return;
        if (message.seq !== subscription.after + 1) this.options.gap(message.topic);
        subscription.after = message.seq;
      }
      if (message.type === "resync") {
        subscription.after = message.payload.last_seq;
        this.options.reload(message.topic);
      }
      this.options.message(message);
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.socket !== socket || this.stopped) return;
      this.socket = undefined;
      this.opened = false;
      this.watchdog?.();
      if (!this.offline)
        this.offline = this.options.setTimeout(() => this.options.unavailable(true), 3000);
      this.retry = this.options.setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 8000);
    };
  }
}
