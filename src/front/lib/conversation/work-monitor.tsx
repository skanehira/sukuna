import { useMemo, useSyncExternalStore } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部システムとの同期: 右に表示する会話の配信を、表示を閉じるまで購読する
import { useEffect } from "react";
import { TaskDetailPane, taskDetailLines } from "../../components/task-detail-pane";
import {
  TimelinePane,
  nextTree,
  selectedTree,
  timelineLines,
} from "../../components/timeline-pane";
import { WorkingLine, liveActivity } from "../../components/working-line";
import { progressResponseSchema, type ProgressResponse } from "../../../shared/progress/schema";
import type { ServerMessage } from "../../../shared/ws";
import type { ActionContext } from "../../buffer/keymap/registry";
import { isTimelineView } from "../../buffer/right-window";
import { timelineNote } from "../timeline-lines";
import type { TabStorage } from "../recap/read-tracking";
import { timelineActions } from "../work-actions";
import type { ConversationSession } from "./session";

export type ProgressTarget = { kind: "conversation" | "issue"; id: string };
export type ProgressApi = (target: ProgressTarget) => Promise<ProgressResponse>;
export function createProgressApi(fetcher: typeof fetch): ProgressApi {
  return async ({ kind, id }) => {
    const response = await fetcher(
      `/api/${kind === "issue" ? "issues" : "conversations"}/${encodeURIComponent(id)}/progress`,
    );
    const value: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = value as { error?: { message?: string } } | undefined;
      throw new Error(
        error?.error?.message ?? "作業の状況を取得できませんでした。もう一度開いてください。",
      );
    }
    return progressResponseSchema.parse(value);
  };
}

type TimelineView = "timeline" | "timeline-task";
type TimelineSnapshot = { data: ProgressResponse | null; error: string | null; version: number };

export type WorkMonitorOptions = {
  api: ProgressApi;
  storage: TabStorage;
  now: () => number;
  schedule: (fn: () => void, milliseconds: number) => () => void;
};

export class WorkMonitor {
  private state: TimelineSnapshot = { data: null, error: null, version: 0 };
  private taskId: string | null;
  private treeId: string | null;
  private request = 0;
  private users = 0;
  private stop: (() => void) | undefined;
  private listeners = new Set<() => void>();
  private cancelTimer: (() => void) | undefined;
  private readonly url: string;
  readonly target: ProgressTarget;
  private readonly conversation: ConversationSession;
  private readonly options: WorkMonitorOptions;

  constructor(
    conversation: ConversationSession,
    options: WorkMonitorOptions,
    target: ProgressTarget = { kind: "conversation", id: conversation.id },
  ) {
    this.conversation = conversation;
    this.options = options;
    this.target = target;
    this.url = `/${target.kind === "issue" ? "issues" : "conversations"}/${encodeURIComponent(target.id)}`;
    this.treeId = this.options.storage.getItem(`sukuna:timeline:tree:${this.url}`);
    this.taskId = this.options.storage.getItem(`sukuna:timeline:task:${this.url}`);
  }

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  now = () => this.options.now();
  get conversationId(): string {
    return this.conversation.id;
  }

  connect(): () => void {
    if (this.users++ === 0) this.stop = this.start();
    return () => {
      if (--this.users !== 0) return;
      this.stop?.();
      this.stop = undefined;
    };
  }

  private start(): () => void {
    const { controller } = this.conversation;
    const register = (
      name: string,
      label: string,
      view: TimelineView,
      run: (context: ActionContext) => void | Promise<void>,
    ) =>
      controller.actions.register({
        name,
        label,
        where: view === "timeline" ? "タイムライン" : "タスクの詳細",
        group: "そのほか",
        views: [view],
        run,
      });
    const removers = [
      this.conversation.registerStop(),
      register(timelineActions.next.name, timelineActions.next.label, "timeline", () =>
        this.shift(1),
      ),
      register(timelineActions.prev.name, timelineActions.prev.label, "timeline", () =>
        this.shift(-1),
      ),
      register("timeline.task", "タスクの詳細を開く", "timeline", ({ window }) => {
        const taskId = controller.currentLine(window)?.id;
        if (
          taskId === undefined ||
          !this.state.data?.timeline?.tasks.some((task) => task.id === taskId)
        )
          return;
        this.taskId = taskId;
        this.options.storage.setItem(`sukuna:timeline:task:${this.url}`, taskId);
        controller.openRight({ view: "timeline-task", target: this.target.id });
      }),
      register("timeline.continue", "続きを依頼する", "timeline", async () => {
        const tree = selectedTree(this.state.data?.timeline ?? null, this.treeId);
        if (tree) await this.conversation.continueTimeline(tree.title);
      }),
      register("timeline.consult", "このタスクについて相談する", "timeline-task", async () => {
        const task = this.state.data?.timeline?.tasks.find(({ id }) => id === this.taskId);
        if (!task) return;
        const opening = controller.right.openingRevision();
        const promptId = controller.snapshot().promptId;
        await this.conversation.consultTimeline(
          task,
          () =>
            controller.right.openingRevision() === opening &&
            controller.snapshot().promptId === promptId,
        );
      }),
    ];
    controller.setHints("timeline", [
      ["timeline.next", "次の木"],
      ["timeline.prev", "前の木"],
      ["agent.stop", "止める"],
      ["right.close", "閉じる"],
    ]);
    controller.setHints("timeline-task", [
      ["view.prev", "タイムラインへ"],
      ["agent.stop", "止める"],
      ["right.close", "閉じる"],
    ]);
    let opening = controller.right.openingRevision();
    let screen = controller.screenOpening();
    const unsubscribeRight = controller.subscribe(() => {
      const next = controller.right.openingRevision();
      if (next === opening) return;
      const nextScreen = controller.screenOpening();
      const navigating = nextScreen !== screen;
      opening = next;
      screen = nextScreen;
      if (!navigating && this.visible()) void this.refresh();
    });
    const request = this.request;
    queueMicrotask(() => {
      if (request === this.request) this.loaded();
    });
    this.scheduleTick();
    return () => {
      unsubscribeRight();
      removers.forEach((remove) => remove());
      this.cancelTimer?.();
      this.cancelTimer = undefined;
      this.request++;
    };
  }

  private scheduleTick(): void {
    this.cancelTimer = this.options.schedule(() => {
      if (this.visible() || this.conversation.snapshot().data?.conversation.runState === "working")
        this.paint();
      this.scheduleTick();
    }, 30_000);
  }

  private visible(): boolean {
    const right = this.conversation.controller.right.current;
    return right?.target === this.target.id && isTimelineView(right.view);
  }

  loaded(): void {
    if (this.users === 0) return;
    if (this.visible() || this.conversation.snapshot().data?.conversation.runState === "working")
      void this.refresh();
  }

  receive(message: ServerMessage): void {
    if (
      (message.type === "changed" &&
        message.payload.parts?.includes("timeline") &&
        this.visible()) ||
      (message.type === "state" &&
        message.payload.run_state === "working" &&
        this.conversation.snapshot().data?.conversation.runState !== "working")
    )
      void this.refresh();
  }

  open(): void {
    this.conversation.controller.openRight({ view: "timeline", target: this.target.id });
  }

  private async refresh(): Promise<void> {
    const request = ++this.request;
    try {
      const conversation = this.conversation.snapshot().data?.conversation;
      const issueId =
        this.target.kind === "issue"
          ? this.target.id
          : conversation && ["triage", "design", "impl"].includes(conversation.kind)
            ? conversation.issueId
            : undefined;
      const issueProgress = issueId
        ? await this.options.api({ kind: "issue", id: issueId }).catch(() => null)
        : null;
      const result =
        issueProgress?.conversationId === this.conversation.id
          ? issueProgress
          : await this.options.api({ kind: "conversation", id: this.conversation.id });
      if (request !== this.request) return;
      const previous = this.state.data;
      const data =
        result.readError && !result.timeline && previous?.conversationId === result.conversationId
          ? { ...result, timeline: previous.timeline }
          : result;
      this.state = { ...this.state, data, error: null };
      if (
        data.timeline &&
        this.treeId !== null &&
        !data.timeline.trees.some(({ id }) => id === this.treeId)
      ) {
        this.treeId = null;
        this.options.storage.removeItem(`sukuna:timeline:tree:${this.url}`);
      }
      const tree =
        this.visible() && this.treeId === null ? selectedTree(data.timeline, null) : null;
      if (tree) this.rememberTree(tree.id);
    } catch (error) {
      if (request !== this.request) return;
      this.state = {
        ...this.state,
        error: error instanceof Error ? error.message : "作業の状況を取得できませんでした",
      };
    }
    this.paint();
  }

  private shift(direction: -1 | 1): void {
    const data = this.state.data?.timeline;
    if (!data) return;
    const id = nextTree(data, this.treeId, direction);
    if (id === null || id === this.treeId) return;

    this.rememberTree(id);
    this.paint();
  }

  private rememberTree(id: string): void {
    this.treeId = id;
    this.options.storage.setItem(`sukuna:timeline:tree:${this.url}`, id);
  }

  private paint(): void {
    this.state = { ...this.state, version: this.state.version + 1 };
    this.listeners.forEach((listener) => listener());
  }

  lines(view: TimelineView, { data, error }: TimelineSnapshot) {
    if (!data) return error ? [timelineNote(error)] : null;
    const now = new Date(this.now());
    const rows =
      view === "timeline"
        ? timelineLines(data.timeline, this.treeId, data.readError !== null, now)
        : taskDetailLines(data.timeline, this.taskId, data.readError !== null, now);
    return error ? [timelineNote(error), ...rows] : rows;
  }

  positionKey(view: string): string {
    return `${this.url}:${view}${view === "timeline-task" ? `:${encodeURIComponent(this.taskId ?? "")}` : ""}`;
  }
}

export function MonitorPane({
  monitor,
  view,
  subscribe,
}: {
  monitor: WorkMonitor;
  view: TimelineView;
  subscribe?: (monitor: WorkMonitor) => () => void;
}) {
  useEffect(() => subscribe?.(monitor), [monitor, subscribe]);
  const snapshot = useSyncExternalStore(monitor.subscribe, monitor.snapshot);
  const lines = useMemo(() => monitor.lines(view, snapshot), [monitor, view, snapshot]);
  const posKey = monitor.positionKey(view);
  return view === "timeline" ? (
    <TimelinePane posKey={posKey} lines={lines} />
  ) : (
    <TaskDetailPane key={posKey} posKey={posKey} lines={lines} />
  );
}

export function WorkingActivity({
  monitor,
  session,
}: {
  monitor: WorkMonitor;
  session: ConversationSession;
}) {
  const { data: progress } = useSyncExternalStore(monitor.subscribe, monitor.snapshot);
  const { data } = useSyncExternalStore(session.subscribe, session.snapshot);
  const conversation = data?.conversation;
  const activity = conversation
    ? liveActivity(
        progress?.activity ?? null,
        session.eventRecords(),
        conversation.cwd,
        conversation.runState,
      )
    : null;
  return <WorkingLine activity={activity} now={monitor.now} />;
}
