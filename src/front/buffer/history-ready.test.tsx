import { StrictMode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { expect, it } from "vite-plus/test";
import { SWRConfig, useSWRConfig } from "swr";
import type { ConversationApi } from "../lib/conversation/types";
import { App } from "../App";
import { Buffer } from "./Buffer";
import { Layout } from "./Layout";
import { Frame } from "./Frame";
import { BufferController } from "./controller";
import { Tree } from "../components/tree";
import {
  ConversationSwitch,
  registerConversationSwitch,
} from "../components/conversation/ConversationSwitch";
import { createConversationApi } from "../lib/conversation/api";
import { createBrowserController } from "../lib/browser";
import { inboxFixture } from "../lib/inbox.test-support";
import { parseRoute } from "../lib/routes";
import { createNavigation } from "../shell/navigation";
import type { ProjectsResponse } from "../../shared/inbox/schema";

const projects: ProjectsResponse = {
  projects: [
    {
      id: "p",
      name: "shop-api",
      flowPaused: false,
      conversations: [
        { id: "c1", title: "最初の会話" },
        { id: "c2", title: "別の会話" },
      ],
      issues: [],
    },
    { id: "q", name: "docs-site", flowPaused: false, conversations: [], issues: [] },
  ],
};
const editor = (region: HTMLElement) =>
  EditorView.findFromDOM(region.querySelector(".cm-editor")!)!;
const text = (view: EditorView) => view.state.doc.lineAt(view.state.selection.main.head).text;
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function press(view: EditorView, key: string, ctrlKey = false) {
  await act(async () => {
    fireEvent.keyDown(view.contentDOM, { key, ctrlKey });
  });
}

function ReloadProjects({ api, reload }: { api: ConversationApi; reload: () => Promise<void> }) {
  const { mutate } = useSWRConfig();
  return (
    <button
      onClick={() => {
        void reload();
        void mutate(["conversation-projects", api]);
      }}
    >
      再取得
    </button>
  );
}
it.each([
  { side: "tree", empty: false, newer: "none" },
  { side: "right", empty: false, newer: "none" },
  { side: "tree", empty: true, newer: "none" },
  { side: "right", empty: true, newer: "none" },
  { side: "tree", empty: false, newer: "prompt" },
  { side: "right", empty: false, newer: "prompt" },
  { side: "tree", empty: false, newer: "main" },
  { side: "right", empty: false, newer: "main" },
  { side: "tree", empty: false, newer: "command" },
  { side: "right", empty: false, newer: "command" },
  { side: "tree", empty: false, newer: "default" },
  { side: "right", empty: false, newer: "default" },
  { side: "right", empty: false, newer: "search" },
] as const)(
  "再読み込み中の $side で Ctrl+oを押すと、取得後に復元して再取得では位置を保つ (空=$empty, 後続=$newer)",
  async ({ side, empty, newer }) => {
    const origin = side === "tree" ? "/" : "/conversations/c1";
    const destination = side === "tree" ? "/projects/q" : "/conversations/c2";
    const target = side === "tree" ? "docs-site" : "会話: 別の会話";
    window.history.replaceState(null, "", origin);
    window.sessionStorage.clear();
    async function setup(readProjects: () => Promise<ProjectsResponse>) {
      const navigation = createNavigation(parseRoute(window.location.pathname), () => {});
      const { controller, dispose } = createBrowserController(window, navigation.open);
      controller.options.prompt = () => ({
        label: "指示",
        target: "会話",
        verb: "送る",
        submit: () => {},
        close: () => {},
      });
      const { store, api: inbox } = inboxFixture();
      inbox.projects.mockImplementation(readProjects);
      const api = createConversationApi(async () => Response.json(await readProjects()));
      const unregister = registerConversationSwitch(controller);
      const mounted = render(
        <StrictMode>
          <SWRConfig value={{ provider: () => new Map() }}>
            <ReloadProjects api={api} reload={() => store.reload()} />
            <App
              controller={controller}
              navigation={navigation}
              renderTree={(route) => <Tree store={store} route={route} />}
              renderRight={(view) =>
                view.view === "conversation-switch" ? (
                  <ConversationSwitch api={api} controller={controller} />
                ) : null
              }
              loadScreen={async (route) => ({
                kind: "ready",
                title: "テスト本文",
                content: (
                  <Buffer
                    side="main"
                    lines={[{ kind: "text", text: route.id ?? "一覧" }]}
                    onReady={() => {}}
                  />
                ),
              })}
            />
          </SWRConfig>
        </StrictMode>,
      );
      await act(async () => {});
      return {
        controller,
        cleanup: () => {
          mounted.unmount();
          unregister();
          dispose();
          store.dispose();
        },
      };
    }
    const region = () =>
      screen.getByRole("region", { name: side === "tree" ? "sukuna" : "会話を始める・切り替える" });
    const mainRegion = () => screen.getByRole("region", { name: "テスト本文" });
    const destinationText = side === "tree" ? "q" : "c2";
    const originText = side === "tree" ? "一覧" : "c1";
    let release = () => {};
    let current = await setup(async () => projects);
    try {
      const main = editor(mainRegion());
      if (side === "right") {
        act(() => main.focus());
        await press(main, " ");
        await press(main, "n");
      }
      const item = await within(region()).findByText(target, { exact: true });
      const before = editor(region());
      act(() => {
        before.focus();
        before.dispatch({ selection: { anchor: before.posAtDOM(item) } });
      });
      await press(before, "Enter");
      expect(window.location.pathname).toBe(destination);
      expect(editor(mainRegion()).state.doc.toString()).toBe(destinationText);
      await act(async () => current.cleanup());
      let incoming = empty ? { projects: [] } : projects;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let requested = false;
      current = await setup(async () => {
        requested = true;
        await gate;
        return incoming;
      });
      expect(requested).toBe(true);
      expect(
        within(region()).getByText(side === "tree" ? "設定" : "読み込み中", { exact: true }),
      ).toBeVisible();
      const reopened = editor(region());
      expect(reopened.state.doc.toString()).toBe(
        side === "tree" ? "一覧\nアプリ\n設定\nヘルプ" : "読み込み中",
      );
      const initiator =
        newer === "main" || newer === "default" || newer === "search"
          ? editor(mainRegion())
          : reopened;
      await act(async () => {
        initiator.focus();
        fireEvent.keyDown(initiator.contentDOM, { key: "o", ctrlKey: true });
      });
      expect(window.location.pathname).toBe(origin);
      const currentMain = editor(mainRegion());
      expect(currentMain.state.doc.toString()).toBe(originText);
      let prompt: EditorView | undefined;
      let search: HTMLInputElement | undefined;
      if (newer === "search") {
        await press(currentMain, "/");
        const input = currentMain.dom.querySelector<HTMLInputElement>(".cm-vim-panel input")!;
        await act(async () => {
          fireEvent.input(input, { target: { value: "a" } });
        });
        search = input;
        expect(search).toHaveFocus();
      } else if (newer !== "none" && newer !== "default") {
        act(() => {
          fireEvent.pointerDown(currentMain.contentDOM);
          currentMain.focus();
          fireEvent.pointerUp(currentMain.contentDOM);
        });
        if (newer === "prompt") {
          await press(currentMain, "i");
          prompt = EditorView.findFromDOM(screen.getByRole("textbox", { name: "指示" }))!;
          act(() => prompt!.dispatch({ changes: { from: 0, insert: "a" } }));
          expect(prompt.hasFocus).toBe(true);
        } else if (newer === "command") {
          await press(currentMain, ":");
          fireEvent.change(screen.getByRole("textbox", { name: "コマンド" }), {
            target: { value: "h" },
          });
        }
      }
      await act(async () => release());
      if (!empty) await within(region()).findByText(target, { exact: true });
      await act(nextFrame);
      expect(text(reopened)).toBe(empty ? (side === "tree" ? "ヘルプ" : "") : target);
      if (newer === "prompt") {
        expect(prompt!.state.doc.toString()).toBe("a");
        expect(prompt!.hasFocus).toBe(true);
        expect(current.controller.snapshot().mode).toBe("INSERT");
      } else if (newer === "command") {
        expect(screen.getByRole("textbox", { name: "コマンド" })).toHaveFocus();
        expect(screen.getByRole("textbox", { name: "コマンド" })).toHaveValue("h");
        expect(current.controller.snapshot().mode).toBe("COMMAND");
      } else if (newer === "search") {
        expect(search).toHaveFocus();
        expect(search).toHaveValue("a");
      } else if (newer === "main") expect(currentMain.hasFocus).toBe(true);
      else expect(reopened.hasFocus).toBe(true);
      if (newer !== "none") return;
      const after = side === "tree" ? "一覧" : "会話: 最初の会話";
      if (!empty || side === "tree") {
        const item = within(region()).getByText(after, { exact: true });
        act(() => reopened.dispatch({ selection: { anchor: reopened.posAtDOM(item) } }));
      }
      incoming = projects;
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "再取得" }));
      });
      await within(region()).findByText(target, { exact: true });
      await act(nextFrame);
      expect(text(reopened)).toBe(after);
    } finally {
      await act(async () => {
        release();
        current.cleanup();
      });
    }
  },
  15000,
);

it("右を閉じた時点で主が未登録でも、本文の登録後に末尾の主へフォーカスを戻す", async () => {
  const controller = new BufferController();
  const mounted = render(
    <Layout
      controller={controller}
      main={<p>切替中</p>}
      right={
        <Frame title="右" side="right">
          <Buffer side="right" lines={[{ kind: "text", text: "切り替え" }]} onReady={() => {}} />
        </Frame>
      }
    />,
  );
  const right = editor(screen.getByRole("region", { name: "右" }));
  act(() => right.focus());
  await press(right, "q");
  mounted.rerender(
    <Layout
      controller={controller}
      main={
        <Frame title="会話" side="main">
          <Buffer
            side="main"
            lines={[
              { kind: "text", text: "先頭" },
              { kind: "text", text: "作業末尾" },
            ]}
            onReady={(handle) => handle.jumpTo(1, { remember: false })}
          />
        </Frame>
      }
    />,
  );
  const main = editor(screen.getByRole("region", { name: "会話" }));
  expect(text(main)).toBe("作業末尾");
  expect(main.hasFocus).toBe(true);
});
