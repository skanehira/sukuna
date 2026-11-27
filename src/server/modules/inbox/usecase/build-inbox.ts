import { compareInboxRows } from "../../../../shared/inbox/order";
import { sectionNames, type InboxResponse, type InboxRow } from "../../../../shared/inbox/schema";
import type { InboxDependencies, InboxSnapshot } from "../domain/ports";
import { refreshRow } from "./refresh-row";
export function buildInbox(snapshot: InboxSnapshot, deps: InboxDependencies): InboxResponse {
  const rows: InboxRow[] = [];
  for (const project of snapshot.projects) {
    for (const target of [
      ...project.conversations.filter((c) => c.kind === "chat"),
      ...project.issues,
    ]) {
      const row = refreshRow(project, target, deps, snapshot.flowPaused);
      if (row !== null) rows.push(row);
    }
  }
  return {
    sections: sectionNames.map((name) => ({
      name,
      rows: rows.filter((row) => row.section === name).sort(compareInboxRows),
    })),
  };
}
