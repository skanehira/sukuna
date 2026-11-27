import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { SWRConfig } from "swr";
import { expect, it, vi } from "vite-plus/test";
import { BufferController } from "../../buffer/controller";
import { Buffer } from "../../buffer/Buffer";
import { Layout } from "../../buffer/Layout";
import { createConversationApi } from "../../lib/conversation/api";
import { ConversationSwitch, registerConversationSwitch } from "./ConversationSwitch";

it.each([false, true])(
  "Space n でプロジェクト別メニューを開き、worktree作成 %s で会話を始める",
  async (worktree) => {
    const requests: { path: string; body: unknown }[] = [];
    const api = createConversationApi(async (url, init) => {
      requests.push({
        path: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return Response.json(
        (typeof url === "string" ? url : url instanceof URL ? url.href : url.url) ===
          "/api/projects"
          ? {
              projects: [
                {
                  id: "p1",
                  name: "one",
                  conversations: [{ id: "c1", title: "相談" }],
                  issues: ["draft", "done", "withdrawn", "ready"].map((state, i) => ({
                    id: `i${i}`,
                    number: i + 1,
                    title: state,
                    state,
                  })),
                },
                { id: "p2", name: "two", conversations: [], issues: [] },
              ],
            }
          : { conversation: { id: "c2", worktree: worktree ? { name: "new-branch" } : null } },
      );
    });
    const navigate = vi.fn();
    const controller = new BufferController({ navigate });
    const unregister = registerConversationSwitch(controller);
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <Layout
          controller={controller}
          main={<Buffer side="main" lines={[{ kind: "text", text: "会話" }]} onReady={() => {}} />}
          renderRight={() => (
            <ConversationSwitch api={api} controller={controller} currentProject="p1" />
          )}
        />
      </SWRConfig>,
    );
    const main = document.querySelector(".cm-content")!;
    act(() => {
      fireEvent.keyDown(main, { key: " " });
      fireEvent.keyDown(main, { key: "n" });
    });
    await screen.findByRole("region", { name: "会話を始める・切り替える" });
    const region = screen.getByRole("region", { name: "会話を始める・切り替える" });
    await waitFor(() =>
      expect(region.querySelector(".cm-content")?.textContent).toBe(
        "one会話: 相談#4 ready1  one で会話を始める  2  worktree を作って会話を始める  two3  two で会話を始める  ",
      ),
    );
    const view = EditorView.findFromDOM(region.querySelector(".cm-editor")!)!;
    act(() => {
      fireEvent.keyDown(view.contentDOM, { key: worktree ? "2" : "1" });
      fireEvent.keyDown(view.contentDOM, { key: "Enter" });
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/conversations/c2"));
    expect(requests).toEqual([
      { path: "/api/projects", body: null },
      {
        path: "/api/conversations",
        body: { projectId: "p1", workspace: { kind: worktree ? "new_worktree" : "project" } },
      },
    ]);
    expect(controller.right.current).toBeNull();
    expect(controller.snapshot().notice).toEqual({
      message: worktree
        ? "worktree new-branch を作り、その中で会話を始めました"
        : "one で会話を始めました (プロジェクトのディレクトリ)",
      kind: "info",
    });
    unregister();
  },
);
