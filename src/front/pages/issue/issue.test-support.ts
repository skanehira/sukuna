import { issueViewSchema, type IssueView } from "../../../shared/issue/schema";
import type { IssueApi } from "./issue-api";

export const issueView = (changes: Partial<IssueView> = {}): IssueView =>
  issueViewSchema.parse({
    id: "i",
    projectId: "p",
    number: 12,
    title: "予約を確保する",
    body: "在庫がある場合に確保する",
    state: "triage",
    kind: null,
    stopReason: null,
    stopDetail: null,
    priority: "medium",
    confirmBeforeMerge: true,
    designed: false,
    prUrl: null,
    createdConversationId: null,
    createdConversation: null,
    githubNumber: null,
    parent: null,
    children: [],
    dependsOn: [],
    dependents: [],
    conversations: [],
    comments: [],
    createdAt: 12,
    updatedAt: 12,
    closedAt: null,
    ...changes,
  });

export function issueApi(issue: IssueView): IssueApi {
  return {
    project: async () => ({
      id: "p",
      name: "reservation-api",
      path: "/reservation-api",
      usesGithub: false,
      defaultBranch: "main",
      model: null,
      permissionMode: "default",
      autoStages: ["triage"],
      implConcurrency: 5,
      designMergeMode: "direct",
      confirmBeforeMergeDefault: true,
      flowPaused: false,
      globalFlowPaused: false,
      stopTargetCount: 0,
    }),
    get: async () => issue,
    create: async () => issue,
    update: async () => issue,
    confirm: async () => issue,
    reopen: async () => issue,
  };
}

export function tabStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}
