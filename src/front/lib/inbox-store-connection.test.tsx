import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { App } from "../App";
import { BufferController } from "../buffer/controller";
import { createConversationApi } from "./conversation/api";
import { createConversationWorkspace } from "./conversation/workspace";
import { inboxFixture, response, row } from "./inbox.test-support";
import { InboxPage } from "../pages/inbox";
import type { RealtimeSocket } from "./realtime";
import type { InboxResponse } from "../../shared/inbox/schema";

afterEach(() => vi.useRealTimers());
it.each([false, true])(
  "先行GETが残る=%sでも配信が3秒途切れると表示し、再接続で新しい一覧を取得する",
  async (pending) => {
    vi.useFakeTimers();
    const { store, api } = inboxFixture();
    const controller = new BufferController();
    const sockets: RealtimeSocket[] = [];
    const workspace = createConversationWorkspace(
      createConversationApi(async () => Response.json({})),
      controller,
      {
        clientId: "tab",
        id: () => "id",
        now: () => Date.now(),
        schedule: (fn, ms) => {
          const id = setTimeout(fn, ms);
          return () => clearTimeout(id);
        },
      },
      () => {
        const socket: RealtimeSocket = {
          onopen: null,
          onclose: null,
          onerror: null,
          onmessage: null,
          send: () => {},
          close() {
            this.onclose?.();
          },
        };
        sockets.push(socket);
        return socket;
      },
      { inbox: store },
    );
    const stop = workspace.start();
    render(
      <App
        controller={controller}
        connection={workspace.connection}
        main={<InboxPage store={store} controller={controller} />}
      />,
    );
    await act(async () => {
      sockets[0].onopen?.();
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.getByText("会話: 予約 API の壁打ち", { exact: true })).toBeInTheDocument();
    const resolvers: ((value: InboxResponse) => void)[] = [];
    if (pending) {
      api.inbox.mockImplementationOnce(() => new Promise((resolve) => resolvers.push(resolve)));
      act(() => {
        void store.reload();
      });
    }
    const requests = api.inbox.mock.calls.length;
    act(() => sockets[0].onclose?.());
    await act(() => vi.advanceTimersByTimeAsync(2999));
    expect(screen.queryByText("つながりません", { exact: true })).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText("つながりません", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("会話: 予約 API の壁打ち", { exact: true })).toBeInTheDocument();
    api.inbox.mockResolvedValue(response(row({ title: "会話: 再接続後" })));
    await act(async () => {
      sockets.at(-1)!.onopen?.();
      if (pending) resolvers[0](response(row()));
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.queryByText("つながりません", { exact: true })).toBeNull();
    expect(screen.getByText("会話: 再接続後", { exact: true })).toBeInTheDocument();
    expect(api.inbox.mock.calls.length).toBe(requests + 1);
    stop();
  },
);
