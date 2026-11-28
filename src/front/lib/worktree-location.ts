import type { ConversationApi } from "./conversation/types";
import type { Route } from "./routes";
import type { WorktreeApi } from "./worktree-api";

export type WorktreeLocation = {
  projectId: string;
  projectName: string;
  source: "project" | "conversation" | "issue";
  conversationId: string | null;
  worktreeId: string | null;
};

export function worktreeSelection(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">) {
  const key = (projectId: string) => `sukuna:worktree:${projectId}`;
  return {
    read: (projectId: string) => storage.getItem(key(projectId)),
    write: (projectId: string, id: string | null) =>
      id === null ? storage.removeItem(key(projectId)) : storage.setItem(key(projectId), id),
  };
}
export type WorktreeSelection = ReturnType<typeof worktreeSelection>;

export function createWorktreeLocation({
  conversation,
  projects,
  issue,
  selection,
}: {
  conversation: ConversationApi["get"];
  projects: ConversationApi["projects"];
  issue: WorktreeApi["issue"];
  selection: WorktreeSelection;
}) {
  async function projectName(projectId: string): Promise<string> {
    const project = (await projects()).find(({ id }) => id === projectId);
    if (!project) throw new Error("プロジェクトが見つかりません");
    return project.name;
  }

  return async function location(
    route: Route,
    purpose: "worktree" | "terminal",
  ): Promise<WorktreeLocation | null> {
    if (!route.id) return null;
    if (route.kind === "project")
      return {
        projectId: route.id,
        projectName: await projectName(route.id),
        source: "project",
        conversationId: null,
        worktreeId: selection.read(route.id),
      };
    if (route.kind === "conversation") {
      const { conversation: item } = await conversation(route.id);
      return {
        projectId: item.projectId,
        projectName: item.projectName,
        source: "conversation",
        conversationId: item.id,
        worktreeId: item.worktree?.id ?? null,
      };
    }
    if (route.kind !== "issue") return null;
    const details = await issue(route.id);
    const find = (kind: string) => details.conversations.find((item) => item.kind === kind);
    const phase = details.state === "stopped" ? details.stoppedFrom : details.state;
    const phaseKind =
      phase === "triage"
        ? "triage"
        : phase === "design" || phase === "design_review"
          ? "design"
          : "impl";
    const current =
      (purpose === "worktree" ? find(phaseKind) : undefined) ?? find("impl") ?? find("design");
    const item = current ? (await conversation(current.id)).conversation : undefined;
    return {
      projectId: details.projectId,
      projectName: item?.projectName ?? (await projectName(details.projectId)),
      source: "issue",
      conversationId: item?.id ?? null,
      worktreeId: item?.worktree?.id ?? null,
    };
  };
}
export type FindWorktreeLocation = ReturnType<typeof createWorktreeLocation>;
