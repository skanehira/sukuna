import { act, cleanup, render, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { SWRConfig } from "swr";
import type { WorktreeItem } from "../../shared/api/worktree";
import { BufferController } from "../buffer/controller";
import { Layout } from "../buffer/Layout";
import { worktreeSelection, type WorktreeLocation } from "../lib/worktree-location";
import { WorktreeWindow } from "./worktree-window";

const main: WorktreeItem = {
  id: null,
  name: "main",
  path: "/sand/main",
  branch: "main",
  origin: "main",
  issue: null,
  conversations: [],
  uncommittedCount: 0,
  uncommittedSample: [],
  unpushedCount: 0,
  locked: null,
  missing: false,
  terminalId: null,
};
const next: WorktreeItem = {
  ...main,
  id: "w",
  name: "try-2",
  branch: "try-2",
  path: "/sand/main/.claude/worktrees/try-2",
  origin: "user",
  conversations: [{ id: "other", title: "別の会話", runState: "idle" }],
  uncommittedCount: 3,
  uncommittedSample: ["a.ts"],
  unpushedCount: 2,
};

beforeEach(() => window.sessionStorage.clear());
async function mount(source: WorktreeLocation["source"], initial = [main, next]) {
  let items = initial;
  const controller = new BufferController();
  const selection = worktreeSelection(window.sessionStorage);
  const api = {
    list: vi.fn(async () => items),
    create: vi.fn(async (_project: string, name: string) => {
      const item = { ...next, name };
      items = [...items, item];
      return { ...item, notice: null };
    }),
    remove: vi.fn(
      async (_id: string): Promise<{ removedBranch: false; movedConversationIds: string[] }> => {
        throw new Error("変更があるため消していません");
      },
    ),
    switch: vi.fn(async (_conversation: string, worktree: string | null) => {
      items = items.map((item) =>
        item.id === worktree
          ? {
              ...item,
              conversations: [
                ...item.conversations,
                { id: "c", title: "会話", runState: "idle" as const },
              ],
            }
          : item,
      );
    }),
  };
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <Layout
        controller={controller}
        main={null}
        right={
          <WorktreeWindow
            api={api}
            controller={controller}
            location={{
              source,
              projectId: "p",
              projectName: "project",
              conversationId: source === "project" ? null : "c",
              worktreeId: null,
            }}
            selection={selection}
            opening={1}
          />
        }
      />
    </SWRConfig>,
  );
  await waitFor(() =>
    expect(controller.windowLines("right").find((line) => line.id === "main")).toBeDefined(),
  );
  const select = async (id: string) => {
    await waitFor(() =>
      expect(controller.windowLines("right").some((line) => line.id === id)).toBe(true),
    );
    act(() => {
      controller.focus("right");
      controller.place(
        "right",
        controller.windowLines("right").findIndex((line) => line.id === id),
        0,
      );
    });
  };
  return { controller, api, selection, select };
}

it("一覧に使用中と変更の件数を出し、確認後に消せなければ理由を表示する", async () => {
  const { controller, api, select } = await mount("project");
  await select("w");
  expect(controller.currentLine("right")?.cols).toEqual([
    "try-2",
    "try-2",
    "会話 1 件 未コミット 3 未 push 2",
  ]);
  await act(() => controller.run("item.delete"));
  expect(controller.snapshot().confirmation?.text).toContain("この worktree を消しますか?");
  expect(api.remove).not.toHaveBeenCalled();
  act(() => {
    controller.answer(new KeyboardEvent("keydown", { key: "y" }));
  });
  await waitFor(() => expect(api.remove).toHaveBeenCalledExactlyOnceWith("w"));
  await waitFor(() =>
    expect(controller.snapshot().notice).toEqual({
      message: "変更があるため消していません",
      kind: "error",
    }),
  );
});

it("会話の一覧から作業場所を切り替えると印を移し、失敗時はその印を保つ", async () => {
  const { controller, api, select } = await mount("conversation");
  await select("w");
  await act(async () => controller.open());
  await waitFor(() =>
    expect(controller.windowLines("right").find((line) => line.mark === "●")?.id).toBe("w"),
  );
  expect(api.switch).toHaveBeenCalledExactlyOnceWith("c", "w");
  expect(controller.snapshot().notice?.message).toBe("worktree try-2 に切り替えました");

  api.switch.mockRejectedValueOnce(new Error("AI が動いているあいだは切り替えられません"));
  await select("main");
  await act(async () => controller.open());
  await waitFor(() =>
    expect(controller.snapshot().notice).toEqual({
      kind: "error",
      message: "AI が動いているあいだは切り替えられません",
    }),
  );
  expect(controller.windowLines("right").find((line) => line.mark === "●")?.id).toBe("w");
});

it("issue の一覧の Enter は切り替えず案内し、プロジェクトの Enter はタブだけを変更する", async () => {
  const issue = await mount("issue");
  await issue.select("w");
  await act(async () => issue.controller.open());
  await waitFor(() =>
    expect(issue.controller.snapshot().notice?.message).toBe(
      "issue の作業場所は自動フローが決めます",
    ),
  );
  expect(issue.api.switch).not.toHaveBeenCalled();
  cleanup();
  const project = await mount("project");
  await project.select("w");
  await act(async () => project.controller.open());
  await waitFor(() => expect(project.selection.read("p")).toBe("w"));
  expect(project.api.switch).not.toHaveBeenCalled();
});

it("作成で失敗した名前を保ち、成功時は追加した行を選択する", async () => {
  const { controller, api, select } = await mount("project", [main]);
  await select("main");
  act(() => {
    controller.update({ number: "1" });
    controller.open();
  });
  await waitFor(() => expect(controller.snapshot().prompt?.label).toBe("worktree の名前"));
  act(() => controller.replacePromptText("try-2"));
  api.create.mockRejectedValueOnce(new Error("同じ名前があります"));
  await act(() => controller.submitPrompt("try-2"));
  expect(controller.snapshot().notice?.message).toBe("同じ名前があります");
  expect(controller.promptText()).toBe("try-2");
  await act(() => controller.submitPrompt("try-2"));
  await waitFor(() => expect(controller.currentLine("right")?.id).toBe("w"));
  expect(controller.snapshot().notice?.message).toBe("worktree try-2 を作りました");
});

it("一覧の更新に失敗しても、確定した切り替え先に印を移す", async () => {
  const current: WorktreeItem["conversations"] = [{ id: "c", title: "会話", runState: "idle" }];
  const { api, controller, select } = await mount("conversation", [
    { ...main, conversations: current },
    next,
  ]);
  api.list.mockRejectedValueOnce(new Error("一覧を一時的に取得できません"));
  await select("w");
  await act(async () => controller.open());
  await waitFor(() =>
    expect(controller.windowLines("right")).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "一覧を一時的に取得できません" })]),
    ),
  );
  expect(controller.windowLines("right").find((line) => line.mark === "●")?.id).toBe("w");
});
