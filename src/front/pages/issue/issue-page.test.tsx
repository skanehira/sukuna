import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { expect, it, vi } from "vite-plus/test";
import type { IssueView } from "../../../shared/issue/schema";
import { BufferController } from "../../buffer/controller";
import { Layout } from "../../buffer/Layout";
import type { LifecycleFeed } from "../../components/lifecycle/use-lifecycle";
import { ConversationApiError } from "../../lib/conversation/api";
import type { ConversationSession } from "../../lib/conversation/session";
import { IssuePage } from "./issue-page";
import { issueApi, issueView } from "./issue.test-support";

const noFeed = () => () => {};

function mount(
  issue: IssueView,
  reopen = vi.fn(async () => issue),
  extra: {
    subscribe?: LifecycleFeed;
    loadConversation?: (id: string) => Promise<ConversationSession>;
  } = {},
) {
  const navigate = vi.fn();
  const notify = vi.fn();
  const controller = new BufferController({ url: "/issues/i", navigate, notify });
  const api = { ...issueApi(issue), reopen };
  const view = render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <Layout
        controller={controller}
        main={
          <IssuePage
            initial={issue}
            projectName="reservation-api"
            api={api}
            controller={controller}
            subscribe={extra.subscribe ?? noFeed}
            subscribeConversation={noFeed}
            loadConversation={
              extra.loadConversation ??
              (async () => {
                throw new Error("会話は用意していません");
              })
            }
            positionKey="/issues/i"
            openAtTail={false}
            refreshListings={() => {}}
          />
        }
      />
    </SWRConfig>,
  );
  const editor = () =>
    EditorView.findFromDOM(view.container.querySelector<HTMLElement>(".cm-editor")!)!;
  return { controller, navigate, notify, editor };
}

it.each([
  { state: { state: "design_review" } as const, display: "設計" },
  { state: { state: "stopped", stopReason: "merge_confirm" } as const, display: "差分" },
  { state: { state: "triage" } as const, display: "会話" },
])("$state.state の最初の表示を $display にする", ({ state, display }) => {
  mount(issueView(state));
  expect(
    screen.getByRole("heading", { name: `reservation-api / #12 予約を確保する / ${display}` }),
  ).toBeVisible();
});

it("Ctrl+l と Ctrl+h で履歴を増やさず表示を切り替える", async () => {
  const { editor, navigate } = mount(issueView());
  act(() => editor().focus());
  await act(() => fireEvent.keyDown(editor().contentDOM, { key: "l", ctrlKey: true }));
  expect(await screen.findByRole("heading", { name: /\/ 設計$/ })).toBeVisible();
  await act(() => fireEvent.keyDown(editor().contentDOM, { key: "h", ctrlKey: true }));
  expect(await screen.findByRole("heading", { name: /\/ 会話$/ })).toBeVisible();
  expect(navigate).not.toHaveBeenCalled();
});

it("閉じた issue の再開メニューから確認なしで API に送り、精査待ちに切り替える", async () => {
  const issue = issueView({ state: "withdrawn", closedAt: 10 });
  const reopen = vi.fn(async () => issueView({ state: "triage" }));
  const { controller, editor, notify } = mount(issue, reopen);
  await screen.findByText("この issue を再開する", { exact: true });
  const view = editor();
  await act(async () => {
    const index = view.state.doc
      .toString()
      .split("\n")
      .findIndex((line) => line.includes("この issue を再開する"));
    controller.place("main", index, 0);
    fireEvent.keyDown(view.contentDOM, { key: "Enter" });
  });
  expect(reopen).toHaveBeenCalledExactlyOnceWith("i");
  expect(controller.snapshot().confirmation).toBeNull();
  expect(await screen.findByText("精査待ち", { exact: true })).toBeVisible();
  expect(notify).toHaveBeenCalledExactlyOnceWith("issue を再開しました", "info");
});

it("担当会話の一時取得失敗を再接続で再取得し、見つからない会話には以降送らない", async () => {
  const issue = issueView({ conversations: [{ id: "triage", kind: "triage", runState: "idle" }] });
  const load = vi
    .fn(async (_id: string) => {
      throw new ConversationApiError(404, "not_found", "会話が見つかりません");
    })
    .mockRejectedValueOnce(new ConversationApiError(503, "network_error", "一時取得に失敗"));
  const callbacks = new Set<Parameters<LifecycleFeed>[1]>();
  mount(issue, undefined, {
    subscribe: (_topic, receive) => {
      callbacks.add(receive);
      return () => {
        callbacks.delete(receive);
      };
    },
    loadConversation: load,
  });
  await screen.findByText("一時取得に失敗", { exact: true });
  act(() => {
    [...callbacks].forEach((receive) => receive());
  });
  expect(await screen.findByText("会話が見つかりません", { exact: true })).toBeVisible();
  act(() => {
    [...callbacks].forEach((receive) => receive());
  });
  expect(load.mock.calls).toEqual([["triage"], ["triage"]]);
});
