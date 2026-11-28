import { consultationBodySeparator, consultationMarker } from "../../shared/progress/draft";
import type { ActionInfo } from "../buffer/keymap/registry";
import type { MessageResult } from "./conversation/types";

export const timelineActions = {
  open: { name: "timeline.open", label: "タイムラインを開く", where: "共通", group: "そのほか" },
  next: {
    name: "timeline.next",
    label: "次のタスクの木を出す",
    where: "タイムライン",
    group: "そのほか",
    views: ["timeline"],
  },
  prev: {
    name: "timeline.prev",
    label: "前のタスクの木を出す",
    where: "タイムライン",
    group: "そのほか",
    views: ["timeline"],
  },
} satisfies Record<string, ActionInfo>;

export function consultationPrefix(id: string, title: string): string {
  return `${consultationMarker}${id}「${title}${consultationBodySeparator}`.replace(/\r\n?/g, "\n");
}

export async function continueWork(
  title: string,
  send: (text: string) => Promise<MessageResult>,
  notify: (message: string) => void,
): Promise<void> {
  const result = await send(`タイムラインのタスクツリー「${title}」の作業を続けてください。`);
  notify(result.result === "queued" ? "続きの依頼を預けました" : "続きを依頼しました");
}
