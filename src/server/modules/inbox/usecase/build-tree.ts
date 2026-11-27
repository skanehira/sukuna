import type { ProjectsResponse } from "../../../../shared/inbox/schema";
import type { InboxSnapshot } from "../domain/ports";
export function buildTree(snapshot: InboxSnapshot): ProjectsResponse {
  return {
    projects: snapshot.projects.map((p) => ({
      id: p.id,
      name: p.name,
      flowPaused: p.flowPaused,
      conversations: p.conversations
        .filter((c) => c.kind === "chat" && c.closedAt === null)
        .map((c) => ({ id: c.id, title: c.title ?? "" })),
      issues: p.issues
        .filter((i) => i.state !== "done" && i.state !== "withdrawn")
        .sort((a, b) => a.number - b.number)
        .map((i) => ({ id: i.id, number: i.number, title: i.title, state: i.state })),
    })),
  };
}
