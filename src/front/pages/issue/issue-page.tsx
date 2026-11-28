import { useCallback, useContext, useRef, useState, useSyncExternalStore } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部システムとの同期: 配信と画面のキー操作を登録し、離れると解除する
import { useEffect } from "react";
import useSWR from "swr";
import type { IssueView } from "../../../shared/issue/schema";
import { type BufferController, ScreenOpeningContext } from "../../buffer/controller";
import { Frame } from "../../buffer/Frame";
import type { LineInfo } from "../../buffer/line";
import type { LifecycleFeed } from "../../components/lifecycle/use-lifecycle";
import { ListingBuffer } from "../../components/listing-buffer";
import { ConversationApiError } from "../../lib/conversation/api";
import type { ConversationSession } from "../../lib/conversation/session";
import { WorkingActivity, type WorkMonitor } from "../../lib/conversation/work-monitor";
import { ConversationPage } from "../conversation/ConversationPage";
import type { IssueApi } from "./issue-api";
import { issueDataKey, issueFormUrl } from "./issue-form";
import { issueFormColumns, isClosedIssue } from "./issue-form-lines";
import {
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

type LoadConversation = (id: string) => Promise<ConversationSession>;
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
  projectName,
  api,
  controller,
  subscribe,
  subscribeConversation,
  loadConversation,
  monitorConversation,
  positionKey,
  openAtTail,
  refreshListings,
}: {
  initial: IssueView;
  initialDisplay?: IssueDisplay;
  projectName: string;
  api: IssueApi;
  controller: BufferController;
  subscribe: LifecycleFeed;
  subscribeConversation: SubscribeConversation;
  loadConversation: LoadConversation;
  monitorConversation?: MonitorConversation;
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
  const [conversationId, setConversationId] = useState<string>();
  const selected =
    issue.conversations.find((item) => item.id === conversationId) ?? firstIssueConversation(issue);
  const title = `${projectName} / #${issue.number} ${issue.title} / ${displayLabels[display]}`;

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
      setDisplay((selected) => {
        const index = issueDisplays.indexOf(selected);
        return issueDisplays[(index + direction + issueDisplays.length) % issueDisplays.length];
      });
      return true;
    };
    controller.options.switchMainView = switchDisplay;
    const views = ["issue", "conversation"];
    const action = (name: string, label: string, run: () => void | Promise<void>) =>
      controller.actions.register({ name, label, run, views, where: "issue", group: "そのほか" });

    const removers = [
      action("view.next", "次の表示", () => {
        if (controller.snapshot().active === "main") switchDisplay(1);
      }),
      action("issue.edit", "編集の画面を開く", () => {
        if (current()) return controller.navigate(issueFormUrl(issue.id));
      }),
      action("issue.diff", "差分の表示を開く", () => {
        if (current()) setDisplay("diff");
      }),
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
  }, [api, controller, issue, mutate, opening, refreshListings]);

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

  return (
    <Frame title={title} side="main">
      <IssueTabs display={display} />
      <ListingBuffer
        lines={[{ kind: "note", text: `${displayLabels[display]}の内容はまだ表示できません` }]}
        side="main"
        viewName="issue"
        posKey={`${positionKey}:${display}`}
      />
    </Frame>
  );
}
