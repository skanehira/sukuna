import { useCallback, useContext, useRef, useState, useSyncExternalStore } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部システムとの同期: 配信と画面のキー操作を登録し、離れると解除する
import { useEffect } from "react";
import useSWR from "swr";
import type { IssueView } from "../../../shared/issue/schema";
import { type BufferController, ScreenOpeningContext } from "../../buffer/controller";
import { isTimelineView } from "../../buffer/right-window";
import { conversationCommands, timelineStopAction } from "../../lib/conversation/keymap";
import { Frame } from "../../buffer/Frame";
import type { LineInfo } from "../../buffer/line";
import type { LifecycleFeed } from "../../components/lifecycle/use-lifecycle";
import { ListingBuffer } from "../../components/listing-buffer";
import { ConversationApiError } from "../../lib/conversation/api";
import type { ConversationSession } from "../../lib/conversation/session";
import { routeUrl } from "../../lib/routes";
import { WorkingActivity, type WorkMonitor } from "../../lib/conversation/work-monitor";
import { ConversationPage } from "../conversation/ConversationPage";
import type { IssueApi } from "./issue-api";
import { DesignView, type IssueDesign } from "./design-view";
import { designViewName } from "./design-lines";
import { PrView, type PrReviewServices } from "./pr-view";
import { prView } from "./pr-lines";
import { issueDataKey, issueFormUrl } from "./issue-form";
import { issueFormColumns, isClosedIssue } from "./issue-form-lines";
import {
  assignedIssueConversation,
  displayLabels,
  firstIssueConversation,
  firstIssueDisplay,
  issueConversations,
  issueDisplays,
  issueFooterLines,
  issueHeadLines,
  stageLabels,
  type IssueDisplay,
} from "./issue-head-lines";

type LoadConversation = (id: string, current?: () => boolean) => Promise<ConversationSession>;
type SubscribeConversation = (session: ConversationSession, monitor?: WorkMonitor) => () => void;
type MonitorConversation = (
  session: ConversationSession,
  issueId: string,
) => WorkMonitor | undefined;

function IssueTabs({ display }: { display: IssueDisplay }) {
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-line px-4 pb-2 text-[13px]"
      aria-label="issue の表示"
    >
      {issueDisplays.map((view, index) => (
        <span key={view} className="flex items-center gap-2">
          {index === 0 ? null : (
            <span className="text-muted" aria-hidden="true">
              ·
            </span>
          )}
          <span
            aria-current={display === view ? "true" : undefined}
            className={display === view ? "font-semibold text-accent" : "text-muted"}
          >
            {displayLabels[view]}
          </span>
        </span>
      ))}
    </div>
  );
}

function IssueConversation({
  issue,
  selected,
  title,
  head,
  positionKey,
  openAtTail,
  load,
  monitorConversation,
  subscribe,
  subscribeIssue,
}: {
  issue: IssueView;
  selected: IssueView["conversations"][number] | undefined;
  title: string;
  head: LineInfo[];
  positionKey: string;
  openAtTail: boolean;
  load: LoadConversation;
  monitorConversation?: MonitorConversation;
  subscribe: SubscribeConversation;
  subscribeIssue: LifecycleFeed;
}) {
  const {
    data: conversation,
    error,
    mutate,
    isValidating,
  } = useSWR(
    selected ? ["issue-conversation", load, issue.id, selected.id] : null,
    selected
      ? async () => {
          const session = await load(selected.id);
          return { session, monitor: monitorConversation?.(session, issue.id) };
        }
      : null,
    {
      dedupingInterval: 0,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
    },
  );
  const retryable =
    Boolean(selected && error && !conversation) &&
    (!(error instanceof ConversationApiError) ||
      error.status >= 500 ||
      error.status === 408 ||
      error.status === 429);
  const pendingRetry = useRef(false);
  const retry = useCallback(async () => {
    if (pendingRetry.current || isValidating) return;
    pendingRetry.current = true;
    try {
      await mutate();
    } catch {
      return;
    } finally {
      pendingRetry.current = false;
    }
  }, [isValidating, mutate]);
  useEffect(() => {
    if (!retryable) return;
    return subscribeIssue(`issue:${issue.id}`, () => {
      void retry();
    });
  }, [issue.id, retry, retryable, subscribeIssue]);

  if (conversation && selected)
    return (
      <IssueTranscript
        issue={issue}
        session={conversation.session}
        monitor={conversation.monitor}
        title={title}
        head={head}
        positionKey={positionKey}
        openAtTail={openAtTail}
        subscribe={subscribe}
      />
    );
  const description = error
    ? error instanceof Error
      ? error.message
      : "会話を取得できませんでした"
    : selected
      ? "会話を読み込んでいます"
      : "まだ AI の会話はありません";
  return (
    <Frame title={title} side="main">
      <IssueTabs display="conversation" />
      <ListingBuffer
        lines={[
          ...head,
          { kind: "note", text: description },
          ...(retryable
            ? [{ kind: "menu" as const, text: "会話を再読み込みする", open: retry }]
            : []),
          ...issueFooterLines(issue),
        ]}
        columns={issueFormColumns}
        side="main"
        viewName="issue"
        posKey={positionKey}
      />
    </Frame>
  );
}

function IssueTranscript({
  issue,
  session,
  monitor,
  title,
  head,
  positionKey,
  openAtTail,
  subscribe,
}: {
  issue: IssueView;
  session: ConversationSession;
  monitor?: WorkMonitor;
  title: string;
  head: LineInfo[];
  positionKey: string;
  openAtTail: boolean;
  subscribe: SubscribeConversation;
}) {
  const hasQuestion = useSyncExternalStore(session.subscribe, session.hasQuestion);
  const conversationStopped = useSyncExternalStore(session.subscribe, () => {
    const runState = session.snapshot().data?.conversation.runState;
    return runState === "stopped" || runState === "failed" || runState === "usage_limited";
  });
  return (
    <ConversationPage
      title={title}
      tabs={<IssueTabs display="conversation" />}
      positionKey={positionKey}
      session={session}
      monitor={monitor}
      activity={monitor ? <WorkingActivity monitor={monitor} session={session} /> : undefined}
      subscribe={subscribe}
      openAtTail={openAtTail}
      head={head}
      footer={issueFooterLines(issue, { hasQuestion, conversationStopped })}
      columns={issueFormColumns}
    />
  );
}

export function IssuePage({
  initial,
  initialDisplay,
  design,
  projectName,
  project,
  prReview,
  api,
  controller,
  subscribe,
  subscribeDesign,
  subscribeConversation,
  loadConversation,
  monitorConversation,
  stopConversation,
  positionKey,
  openAtTail,
  refreshListings,
}: {
  initial: IssueView;
  initialDisplay?: IssueDisplay;
  design?: IssueDesign;
  projectName: string;
  project?: { path: string; usesGithub: boolean };
  prReview?: PrReviewServices;
  api: IssueApi;
  controller: BufferController;
  subscribe: LifecycleFeed;
  subscribeDesign?: LifecycleFeed;
  subscribeConversation: SubscribeConversation;
  loadConversation: LoadConversation;
  monitorConversation?: MonitorConversation;
  stopConversation: (id: string) => Promise<unknown>;
  positionKey: string;
  openAtTail: boolean;
  refreshListings: (projectId: string) => void;
}) {
  const opening = useContext(ScreenOpeningContext) ?? controller.screenOpening();
  const { data, mutate } = useSWR(issueDataKey(api, initial.id), () => api.get(initial.id), {
    fallbackData: initial,
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  const issue = data ?? initial;
  const [display, setDisplay] = useState(() => initialDisplay ?? firstIssueDisplay(initial));
  const displayRef = useRef(display);
  const issueId = initial.id;
  const [conversationId, setConversationId] = useState<string>();
  const selectDisplay = useCallback(
    (next: IssueDisplay) => {
      if (opening !== controller.screenOpening() || displayRef.current === next) return;
      displayRef.current = next;
      controller.replaceViewUrl(routeUrl({ kind: "issue", id: issueId, view: next }));
      setDisplay(next);
    },
    [controller, issueId, opening],
  );
  const showConversation = useCallback(
    (id?: string) => {
      if (opening !== controller.screenOpening()) return;
      setConversationId(id);
      selectDisplay("conversation");
    },
    [controller, opening, selectDisplay],
  );
  const selected =
    issue.conversations.find((item) => item.id === conversationId) ?? firstIssueConversation(issue);
  const title = `${projectName} / #${issue.number} ${issue.title} / ${displayLabels[display]}`;

  const stopping = useRef(false);
  const selectedId = selected?.id;
  useEffect(() => {
    const current = () => opening === controller.screenOpening();
    const removeStop = controller.registerActionInterceptor(timelineStopAction.name, {
      views: ["issue", designViewName, prView, ...timelineStopAction.views],
      async run({ window }) {
        if (!current()) return false;
        if (window !== "main") {
          const right = controller.right.current;
          if (window !== "right" || right?.target !== issueId || !isTimelineView(right.view))
            return true;
        }
        if (stopping.current) return true;
        stopping.current = true;
        try {
          const latest = await api.get(issueId);
          if (!current()) return true;
          const assigned = assignedIssueConversation(latest);
          if (!assigned) throw new Error("止める AI がありません");
          await stopConversation(assigned.id);
          if (current()) {
            controller.notify(
              `#${latest.number} ${latest.title} の AI を止めました。作業は保存され、指示待ちになります`,
            );
          }
        } catch (error) {
          if (current()) throw error;
        } finally {
          stopping.current = false;
        }
        return true;
      },
    });
    const removeCommand = controller.commands.register({
      ...conversationCommands.stop,
      where: "issue",
      run: () => controller.run(timelineStopAction.name),
    });
    return () => {
      removeCommand();
      removeStop();
    };
  }, [api, controller, display, issueId, opening, selectedId, stopConversation]);

  useEffect(
    () =>
      subscribe(`issue:${issue.id}`, (message) => {
        if (!message || message.type === "changed") void mutate().catch(() => {});
      }),
    [issue.id, mutate, subscribe],
  );

  useEffect(() => {
    const current = () => opening === controller.screenOpening();
    const switchDisplay = (direction: number) => {
      if (!current()) return false;
      const index = issueDisplays.indexOf(displayRef.current);
      selectDisplay(
        issueDisplays[(index + direction + issueDisplays.length) % issueDisplays.length],
      );
      return true;
    };
    controller.options.switchMainView = switchDisplay;
    const views = ["issue", "conversation", designViewName, prView];
    const action = (name: string, label: string, run: () => void | Promise<void>) =>
      controller.actions.register({ name, label, run, views, where: "issue", group: "そのほか" });

    const removers = [
      action("view.next", "次の表示", () => {
        if (controller.snapshot().active === "main") switchDisplay(1);
      }),
      action("issue.edit", "編集の画面を開く", () => {
        if (current()) return controller.navigate(issueFormUrl(issue.id));
      }),
      action("issue.diff", "差分の表示を開く", () => selectDisplay("diff")),
      action("issue.reopen", "この issue を再開する", async () => {
        if (!current() || !isClosedIssue(issue)) return;
        await mutate(api.reopen(issue.id), { revalidate: false });
        refreshListings(issue.projectId);
        if (current()) {
          setConversationId(undefined);
          controller.notify("issue を再開しました");
        }
      }),
      ...issueConversations(issue).map(({ kind, id }) =>
        action(`issue.conversation.${kind}`, `${stageLabels[kind]}の会話`, () => {
          if (current()) setConversationId(id);
        }),
      ),
    ];
    controller.setHints("issue", [
      ["view.prev", "前の表示"],
      ["view.next", "次の表示"],
      ["back", "戻る"],
    ]);
    return () => {
      if (controller.options.switchMainView === switchDisplay)
        controller.options.switchMainView = undefined;
      removers.forEach((remove) => remove());
      controller.setHints("issue", []);
    };
  }, [api, controller, issue, mutate, opening, refreshListings, selectDisplay]);

  if (display === "conversation")
    return (
      <IssueConversation
        key={selected?.id ?? "none"}
        issue={issue}
        selected={selected}
        title={title}
        head={issueHeadLines(issue, selected?.id)}
        positionKey={`${positionKey}:conversation:${selected?.id ?? ""}`}
        openAtTail={openAtTail}
        subscribe={subscribeConversation}
        subscribeIssue={subscribe}
        load={loadConversation}
        monitorConversation={monitorConversation}
      />
    );

  if (display === "diff" && prReview && project)
    return (
      <PrView
        issue={issue}
        project={project}
        controller={controller}
        services={prReview}
        subscribe={subscribe}
        loadConversation={loadConversation}
        title={title}
        tabs={<IssueTabs display={display} />}
        positionKey={`${positionKey}:${display}`}
      />
    );

  return (
    <Frame title={title} side="main">
      <IssueTabs display={display} />
      {display === "design" && design ? (
        <DesignView
          id={issue.id}
          title={`#${issue.number} ${issue.title}`}
          positionKey={`${positionKey}:design`}
          controller={controller}
          design={design}
          stopDetail={issue.stopDetail}
          subscribe={subscribeDesign ?? subscribe}
          loadConversation={loadConversation}
          showConversation={showConversation}
        />
      ) : (
        <ListingBuffer
          lines={[{ kind: "note", text: `${displayLabels[display]}の内容はまだ表示できません` }]}
          side="main"
          viewName="issue"
          posKey={`${positionKey}:${display}`}
        />
      )}
    </Frame>
  );
}
