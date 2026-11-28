import { StrictMode } from "react";
import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import { BufferController } from "../../buffer/controller";
import { Layout } from "../../buffer/Layout";
import { createConversationApi } from "../../lib/conversation/api";
import type { Event, Snapshot } from "../../lib/conversation/types";
import { createConversationWorkspace } from "../../lib/conversation/workspace";
import { createRecapApi } from "../../lib/recap/api";
import { ConversationPage } from "../conversation/ConversationPage";
import { tabStorage } from "./issue.test-support";

function workingConversation(): Snapshot {
  return {
    conversation: {
      id: "triage",
      projectId: "p",
      projectName: "予約",
      title: "担当の精査",
      kind: "triage",
      issueId: "i",
      parentConversationId: null,
      cwd: "/reservation-api",
      worktree: null,
      runState: "working",
      stopReason: null,
      resetsAt: null,
      lastSeq: 2,
      lastReadSeq: 2,
      lastPosition: null,
      closedAt: null,
    },
    draft: null,
    queue: [],
    pendingAnswers: null,
    pendingPermission: null,
    commands: [],
  };
}

it("issue に同じ会話を表示したまま StrictMode が購読を張り直しても、カーソル位置を送る", async () => {
  const controller = new BufferController({ url: "/issues/i?tail=1" });
  const timers = new Set<{ run: () => void; ms: number }>();
  const events: Event[] = [1, 2].map((seq) => ({
    seq,
    createdAt: seq,
    type: "assistant_text",
    payload: { text: `精査の発言 ${seq}`, parent_tool_use_id: null },
  }));
  const api = createConversationApi(async (url) => {
    const path = typeof url === "string" ? url : url instanceof URL ? url.pathname : url.url;
    return Response.json(
      path.includes("/events") ? { events, lastSeq: 2, hasMore: false } : workingConversation(),
    );
  });
  const read = vi.fn(async () => {});
  const storage = tabStorage();
  const workspace = createConversationWorkspace(
    api,
    controller,
    {
      clientId: "tab",
      id: () => "test-id",
      now: () => 0,
      schedule(run, ms) {
        const timer = { run, ms };
        timers.add(timer);
        return () => {
          timers.delete(timer);
        };
      },
    },
    () => {
      throw new Error("WebSocket は起動しません");
    },
    {
      recap: {
        api: {
          ...createRecapApi(async () => {
            throw new Error("読み取り位置以外の API は不要です");
          }),
          read,
        },
        storage,
      },
    },
  );
  const session = await workspace.loadConversation("triage");
  const mounted = render(
    <StrictMode>
      <Layout
        controller={controller}
        main={
          <ConversationPage
            session={session}
            subscribe={workspace.subscribeIssueConversation}
            openAtTail
          />
        }
      />
    </StrictMode>,
  );
  await screen.findByText("精査の発言 2", { exact: true });
  await act(async () => {});
  expect(storage.getItem("sukuna:recap:triage")).not.toBeNull();
  const line = session.bodyLines().findIndex((entry) => entry.seq === 1);
  act(() => controller.place("main", line, 0));
  act(() => {
    [...timers]
      .filter(({ ms }) => ms === 2000)
      .forEach((timer) => {
        timers.delete(timer);
        timer.run();
      });
  });
  expect(read.mock.calls).toContainEqual(["triage", { position: 1 }, false]);
  await act(async () => {
    mounted.unmount();
  });
  expect(storage.getItem("sukuna:recap:triage")).toBeNull();
});
