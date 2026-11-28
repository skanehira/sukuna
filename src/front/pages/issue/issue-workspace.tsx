import type { ScreenContent } from "../../App";
import type { BufferController } from "../../buffer/controller";
import type { LifecycleFeed } from "../../components/lifecycle/use-lifecycle";
import type { ConversationSession } from "../../lib/conversation/session";
import type { WorkMonitor } from "../../lib/conversation/work-monitor";
import { parseRoute, screenKey, type Route } from "../../lib/routes";
import { IssueApiError, type IssueApi } from "./issue-api";
import { createIssueDraft, type IssueDraft, type IssueTabStorage } from "./issue-draft";
import { IssueForm, issueFormUrl } from "./issue-form";
import { issueFormTitle } from "./issue-form-lines";
import { issueDisplays } from "./issue-head-lines";
import { IssuePage } from "./issue-page";

const lastProjectKey = "sukuna:issue:last-project";
const newIssueView = "issue-new";

export function createIssueWorkspace({
  controller,
  api,
  storage,
  id,
  subscribe,
  schedule,
  subscribeConversation,
  loadConversation,
  monitorConversation,
  stopConversation,
  projectForConversation,
  refreshListings,
}: {
  controller: BufferController;
  api: IssueApi;
  storage: IssueTabStorage;
  id: () => string;
  subscribe: LifecycleFeed;
  schedule: (run: () => void, ms: number) => () => void;
  subscribeConversation: (session: ConversationSession, monitor?: WorkMonitor) => () => void;
  loadConversation: (id: string) => Promise<ConversationSession>;
  stopConversation: (id: string) => Promise<unknown>;
  monitorConversation?: (session: ConversationSession, issueId: string) => WorkMonitor | undefined;
  projectForConversation: (id: string) => string | undefined;
  refreshListings: (projectId: string) => void;
}) {
  const drafts = new Map<string, IssueDraft>();
  const draftFor = (projectId: string, positionKey: string): IssueDraft => {
    const key = JSON.stringify([projectId, positionKey]);
    const found = drafts.get(key);
    if (found) return found;
    const draft = createIssueDraft(storage, projectId, positionKey, (input) =>
      api.create(projectId, input),
    );
    drafts.set(key, draft);
    return draft;
  };

  const rememberProject = (projectId: string) => storage.setItem(lastProjectKey, projectId);
  const subscribeIssue: LifecycleFeed = (topic, receive) => {
    let cancel: (() => void) | undefined;
    const unsubscribe = subscribe(topic, (message) => {
      if (message && message.type !== "event" && message.type !== "changed") return;
      if (cancel) return;
      cancel = schedule(() => {
        cancel = undefined;
        receive();
      }, 16);
    });
    return () => {
      cancel?.();
      unsubscribe();
    };
  };

  const loadScreen = async (route: Route): Promise<ScreenContent | null> => {
    const creating = route.kind === "project" && route.view === newIssueView;
    if ((!creating && route.kind !== "issue") || !route.id) return null;

    const positionKey = route.entry ? `issue-form:${route.entry}` : `${screenKey(route)}:main`;
    const draft = creating ? draftFor(route.id, positionKey) : undefined;
    try {
      const issueId = draft ? draft.snapshot().id : route.id;
      const issue = issueId ? await api.get(issueId) : null;
      const project = await api.project(issue?.projectId ?? route.id);
      if (!creating && issue && issue.state !== "draft" && route.view !== "edit") {
        const display = issueDisplays.find((value) => value === route.view);
        if (route.view && !display) return null;
        return {
          kind: "ready",
          title: `#${issue.number} ${issue.title}`,
          fullWindow: true,
          content: (
            <IssuePage
              key={screenKey(route)}
              initial={issue}
              initialDisplay={display}
              projectName={project.name}
              api={api}
              controller={controller}
              subscribe={subscribeIssue}
              subscribeConversation={subscribeConversation}
              loadConversation={loadConversation}
              monitorConversation={monitorConversation}
              stopConversation={stopConversation}
              positionKey={`/issues/${encodeURIComponent(issue.id)}`}
              openAtTail={new URLSearchParams(route.query).get("tail") === "1"}
              refreshListings={refreshListings}
            />
          ),
        };
      }
      return {
        kind: "ready",
        title: issueFormTitle,
        fullWindow: true,
        content: (
          <IssueForm
            key={positionKey}
            controller={controller}
            api={api}
            project={project}
            initial={issue}
            positionKey={positionKey}
            storage={storage}
            subscribe={subscribeIssue}
            refreshListings={refreshListings}
            draft={draft}
            nextVersion={id}
          />
        ),
      };
    } catch (error) {
      return {
        kind: "error",
        error: {
          code: error instanceof IssueApiError ? error.code : "network_error",
          message: error instanceof Error ? error.message : "issue を取得できませんでした",
        },
      };
    }
  };

  const start = () => {
    const unregisterCreate = controller.actions.register({
      name: "issue.new",
      label: "issue を作る",
      group: "そのほか",
      where: "どこでも",
      run: async () => {
        const route = parseRoute(controller.options.url ?? "/");
        const opening = controller.screenOpening();
        const activeProject =
          route.kind === "project"
            ? route.id
            : route.kind === "issue" && route.id
              ? (await api.get(route.id)).projectId
              : route.kind === "conversation" && route.id
                ? (projectForConversation(route.id) ?? storage.getItem(lastProjectKey))
                : storage.getItem(lastProjectKey);
        if (opening !== controller.screenOpening()) return;
        if (!activeProject) {
          controller.notify("プロジェクトを開いてから作ります");
          return;
        }
        await controller.navigate(
          `/projects/${encodeURIComponent(activeProject)}/${newIssueView}`,
          id(),
        );
      },
    });
    const unregisterEdit = controller.commands.register({
      name: "issue",
      label: "開いている issue の編集の画面を開く",
      where: "issue",
      run: (args) => {
        const route = parseRoute(controller.options.url ?? "/");
        if (args.length !== 1 || args[0] !== "edit" || route.kind !== "issue" || !route.id) return;
        if (route.view !== "edit") return controller.navigate(issueFormUrl(route.id));
      },
    });
    return () => {
      unregisterCreate();
      unregisterEdit();
    };
  };

  return { loadScreen, start, rememberProject };
}
