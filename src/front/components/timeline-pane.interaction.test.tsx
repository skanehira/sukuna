import { act, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import { EditorView } from "@codemirror/view";
import { BufferController, BufferControllerContext } from "../buffer/controller";
import { ConversationSession } from "../lib/conversation/session";
import { MonitorPane, WorkMonitor } from "../lib/conversation/work-monitor";
import type { ConversationApi, Snapshot } from "../lib/conversation/types";
import type { ProgressResponse, Timeline } from "../../shared/progress/schema";

const state: Snapshot = {
  conversation: {
    id: "chat",
    projectId: "p",
    projectName: "shop",
    title: "会話",
    kind: "chat",
    issueId: null,
    parentConversationId: null,
    cwd: "/work",
    worktree: null,
    runState: "idle",
    stopReason: null,
    resetsAt: null,
    lastSeq: 0,
    lastReadSeq: 0,
    lastPosition: null,
    closedAt: null,
  },
  draft: null,
  queue: [],
  pendingAnswers: null,
  pendingPermission: null,
  commands: [],
};
const root = (id: string, title: string): Timeline["trees"][number] => ({
  id,
  title,
  status: "pending",
  completed: 0,
  startedAt: null,
  parts: { pending: 1, in_progress: 0, blocked: 0, completed: 0 },
  leaves: { pending: 1, in_progress: 0, blocked: 0, completed: 0, total: 1 },
});
const task = (id: string, parent: string | null, title: string): Timeline["tasks"][number] => ({
  id,
  parent,
  title,
  status: "pending",
  completed: 0,
  weight: 1,
  units: "0 / 1",
});
it("次と前の木に移り、配信で行が増えても同じタスクを選び続ける", async () => {
  const controller = new BufferController({ url: "/conversations/chat" });
  const session = new ConversationSession(
    "chat",
    {
      get: async () => state,
      events: async () => ({ events: [], lastSeq: 0, hasMore: false }),
    } as Partial<ConversationApi> as ConversationApi,
    controller,
    {
      clientId: "one",
      id: () => "one",
      now: () => 1000,
      schedule: () => () => {},
    },
  );
  await session.load();
  const values = new Map<string, string>();
  let online: ProgressResponse = {
    conversationId: "chat",
    activity: null,
    readError: null,
    timeline: {
      defaultTreeId: "A",
      trees: [root("A", "木 A"), root("B", "木 B")],
      tasks: [task("A", null, "木 A"), task("a", "A", "維持する行"), task("B", null, "木 B")],
      history: [],
      reports: [],
      comments: [],
      unresolvedComments: [],
    },
  };
  const api = vi.fn(async () => online);
  const monitor = new WorkMonitor(session, {
    api,
    now: () => 1000,
    schedule: () => () => {},
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  });
  const disconnect = monitor.connect();
  try {
    monitor.open();
    const { unmount } = render(
      <BufferControllerContext value={controller}>
        <MonitorPane monitor={monitor} view="timeline" />
      </BufferControllerContext>,
    );
    const frame = screen.getByRole("region", { name: "タイムライン" });
    const editor = await within(frame).findByRole("textbox");
    const view = EditorView.findFromDOM(editor)!;
    await vi.waitFor(() => expect(view.state.doc.toString()).toContain("維持する行"));
    await act(() =>
      controller.run("timeline.next", { window: "right", view: "timeline", line: 0 }),
    );
    await vi.waitFor(() => expect(view.state.doc.toString()).toContain("2 / 2  木 B"));
    await act(() =>
      controller.run("timeline.prev", { window: "right", view: "timeline", line: 0 }),
    );
    await vi.waitFor(() => expect(view.state.doc.toString()).toContain("維持する行"));
    const previous = view.state.doc.lineAt(view.state.doc.toString().indexOf("維持する行"));
    act(() => view.dispatch({ selection: { anchor: previous.from } }));
    online = {
      ...online,
      timeline: {
        ...online.timeline!,
        defaultTreeId: "B",
        tasks: [
          task("A", null, "木 A"),
          task("new", "A", "追加の行"),
          task("a", "A", "維持する行"),
          task("B", null, "木 B"),
        ],
      },
    };
    await act(async () =>
      monitor.receive({
        type: "changed",
        topic: "conversation:chat",
        seq: 1,
        payload: { parts: ["timeline"] },
      }),
    );
    await vi.waitFor(() => {
      expect(view.state.doc.toString()).toContain("追加の行");
      expect(view.state.doc.lineAt(view.state.selection.main.head).text).toContain("維持する行");
    });
    online = { ...online, timeline: null, readError: "読めません" };
    await act(async () =>
      monitor.receive({
        type: "changed",
        topic: "conversation:chat",
        seq: 1,
        payload: { parts: ["timeline"] },
      }),
    );
    await vi.waitFor(() => {
      expect(view.state.doc.toString()).toContain("前に読めた内容を出しています");
      expect(view.state.doc.toString()).toContain("維持する行");
    });
    const beforeRestore = api.mock.calls.length;
    act(() => controller.openRight({ view: "toc", target: "chat" }));
    online = {
      ...online,
      readError: null,
      timeline: {
        defaultTreeId: "A",
        trees: [root("A", "木 A")],
        tasks: [task("A", null, "隠れている間に変わったタスク")],
        history: [],
        reports: [],
        comments: [],
        unresolvedComments: [],
      },
    };
    act(() =>
      monitor.receive({
        type: "changed",
        topic: "conversation:chat",
        seq: 2,
        payload: { parts: ["timeline"] },
      }),
    );
    expect(api).toHaveBeenCalledTimes(beforeRestore);
    await act(() => controller.run("view.prev"));
    await vi.waitFor(() =>
      expect(view.state.doc.toString()).toContain("隠れている間に変わったタスク"),
    );
    expect(api).toHaveBeenCalledTimes(beforeRestore + 1);
    unmount();
  } finally {
    disconnect();
  }
});
