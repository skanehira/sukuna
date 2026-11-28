import type { InboxResponse } from "../../shared/inbox/schema";
import type { ServerMessage } from "../../shared/ws";

export function createBrowserNotifications(deps: {
  notify(message: string, level: "info" | "error"): void;
  title(value: string): void;
}) {
  return {
    updateTitle: (snapshot: InboxResponse) => {
      const count = snapshot.sections
        .filter(({ name }) => name === "decision" || name === "instruction")
        .reduce((total, { rows }) => total + rows.filter(({ unread }) => unread).length, 0);
      deps.title(count === 0 ? "sukuna" : "(" + count + ") sukuna");
    },
    receive(message: ServerMessage) {
      if (
        message.topic === "app" &&
        message.type === "notice" &&
        (message.payload.notification ||
          (message.payload.issue_id && message.payload.level === "error"))
      )
        deps.notify(message.payload.message, message.payload.level);
    },
  };
}
