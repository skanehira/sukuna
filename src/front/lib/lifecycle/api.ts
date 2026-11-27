import type { RunState } from "../../../shared/events";
import type { IssueState } from "../../../shared/issue/state";
import { createConversationRequest } from "../conversation/api";
import type { Project } from "../conversation/types";

export type ListedConversation = {
  id: string;
  title: string;
  runState: RunState;
  closedAt: number | null;
  lastActivityAt: number;
};

export type ProjectConversations = {
  conversations: (ListedConversation & { threads: ListedConversation[] })[];
  issueThreads: {
    issue: { id: string; number: number; title: string };
    threads: ListedConversation[];
  }[];
};

export type SearchResult =
  | {
      type: "issue";
      projectId: string;
      id: string;
      title: string;
      number: number;
      state: IssueState;
      lastActivityAt: number;
    }
  | ({ type: "conversation"; projectId: string } & ListedConversation &
      ({ kind: "chat" } | { kind: "thread"; parentId: string }));

type Available<T> = ({ ok: true } & T) | { ok: false; error: string };
type Items<T> = Available<{ items: T[]; more?: number }>;

export type ClosingIssue = { id: string; number: number; title: string; state: IssueState };
export type ClosingSummary = {
  working: boolean;
  outputs: {
    issues: Items<ClosingIssue>;
    files: Items<string>;
    commits?: Items<{ hash: string; subject: string }>;
    prs?: Items<{ number: number; title: string; url: string; state: string }>;
  };
  remaining: {
    uncommitted?: Items<string>;
    unpushed?: Available<{ count: number; upstream: boolean }>;
    stock: { questions: number; instructions: number };
    runningThreads: { id: string; title: string; runState: RunState }[];
  };
  git: boolean;
};

export type LifecycleApi = ReturnType<typeof createLifecycleApi>;

export function createLifecycleApi(fetcher: typeof fetch) {
  const request = createConversationRequest(fetcher);
  const conversation = (id: string) => "/conversations/" + encodeURIComponent(id);
  return {
    closingSummary: (id: string) => request<ClosingSummary>(conversation(id) + "/closing-summary"),
    close: (id: string, stopIfWorking: boolean) =>
      request<{ closedAt: number }>(conversation(id) + "/close", "POST", { stopIfWorking }),
    remove: (id: string) => request<{ deleted: string[] }>(conversation(id), "DELETE"),
    projectConversations: (id: string) =>
      request<ProjectConversations>("/projects/" + encodeURIComponent(id) + "/conversations"),
    search: (query: string) =>
      request<{ results: SearchResult[]; truncated: boolean }>(
        "/search?" + new URLSearchParams({ q: query }),
      ),
  };
}

export type ProjectList = { project: Project; listing: ProjectConversations };
