import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { KeymapConfig } from "../../shared/settings/keymap-schema";
import { Layout } from "../buffer/Layout";
import { BufferController } from "../buffer/controller";
import { helpLines } from "../buffer/help-lines";
import { registerSettingsCommands } from "../lib/settings-workspace";
import { HelpPage } from "./help";

const defaultConfig: KeymapConfig = { version: 1, entries: [] };

function mountHelp(beforeSave?: () => Promise<void>) {
  let config = defaultConfig;
  let changed = () => {};
  const put = vi.fn(async (entries: KeymapConfig["entries"]) => {
    await beforeSave?.();
    config = { version: 1, entries };
    return config;
  });
  const navigate = vi.fn();
  const controller = new BufferController({
    navigate,
    keymap: {
      load: async () => config,
      subscribe: (listener) => {
        changed = listener;
        return () => {};
      },
      replace: put,
    },
  });
  controller.actions.register({
    name: "timeline.open",
    label: "タイムライン",
    group: "そのほか",
    where: "会話",
    run: () => {},
  });
  controller.actions.register({
    name: "stock.send.all",
    label: "全部送る",
    group: "質問と指示",
    where: "会話",
    run: () => {},
  });
  const unregister = registerSettingsCommands(controller);
  const view = render(
    <Layout controller={controller} main={<HelpPage controller={controller} />} />,
  );
  return {
    ...view,
    controller,
    put,
    navigate,
    unregister,
    remote(entries: KeymapConfig["entries"]) {
      config = { version: 1, entries };
      changed();
    },
  };
}

function focusAction(name: string) {
  const editor = screen.getByRole("textbox", { name: "バッファ" });
  const lines = [...editor.querySelectorAll(".cm-line")];
  const line = lines.findIndex((node) => node.textContent?.includes(name));
  expect(line).toBeGreaterThanOrEqual(0);
  return line + 1;
}

function answer(controller: BufferController, key: "y" | "n") {
  expect(controller.answer(new KeyboardEvent("keydown", { key }))).toBe(true);
}

afterEach(() => vi.restoreAllMocks());

describe("ヘルプとキーの設定", () => {
  it(":help と :h を同じ画面へ開き、解除後はどちらも利用できない", async () => {
    const f = mountHelp();
    await act(async () => {
      await f.controller.command(":help");
      await f.controller.command(":h");
    });
    expect(f.navigate.mock.calls).toEqual([["/help"], ["/help"]]);
    act(() => f.unregister());
    await act(async () => {
      await f.controller.command(":help");
      await f.controller.command(":h");
    });
    expect(f.navigate).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert").textContent).toContain("コマンド :h はありません");
  });

  it("Vim のキー列への割り当てを今のヘルプへ出し、外したら消す", async () => {
    const f = mountHelp();
    await act(async () => f.controller.command(":map <Space>T j"));
    await waitFor(() => {
      const line = screen.getByText("Vim: j").closest(".cm-line");
      expect(line?.textContent).toContain("Space T");
      expect(line?.textContent).toContain("Normal");
    });
    await act(async () => f.controller.command(":unmap <Space>T"));
    await waitFor(() => expect(screen.queryByText("Vim: j")).toBeNull());
    act(() => f.unregister());
  });

  it("上書きした組み込みキーを以前の Vim 動作として案内しない", async () => {
    const f = mountHelp();
    const nativeKeys = () =>
      helpLines(f.controller.entries(), f.controller.actions, f.controller.commands)
        .at(-1)
        ?.text.split("、");
    expect(nativeKeys()).toContain("j");
    await act(async () => f.controller.command(":map j timeline.open"));
    await act(async () => answer(f.controller, "y"));
    expect(nativeKeys()).not.toContain("j");
    expect(nativeKeys()).toContain("k");
    await act(async () => f.controller.command(":unmap j"));
    expect(nativeKeys()).toContain("j");
    act(() => f.unregister());
  });

  it("別タブの更新で増えた重なりは、承認を取り直したあと一括で外す", async () => {
    const f = mountHelp();
    const first = { keys: "<Space>Pp", context: "normal", to: { action: "open" } } as const;
    const newConflict = {
      keys: "<Space>Pq",
      context: "normal",
      to: { action: "tree.focus" },
    } as const;
    const unrelated = { keys: "<Space>U", context: "normal", to: { action: "open" } } as const;
    await act(async () => f.remote([first]));
    await act(async () => f.controller.command(":map <Space>P timeline.open"));
    expect(screen.getByLabelText("操作の確認").textContent).toContain("Space P p");
    await act(async () => f.remote([first, newConflict, unrelated]));
    await act(async () => answer(f.controller, "y"));
    expect(screen.getByLabelText("操作の確認").textContent).toContain("Space P q");
    expect(f.put).not.toHaveBeenCalled();
    await act(async () => answer(f.controller, "y"));
    expect(f.put).toHaveBeenCalledExactlyOnceWith([
      first,
      newConflict,
      unrelated,
      { keys: first.keys, context: "normal", to: null },
      { keys: newConflict.keys, context: "normal", to: null },
      { keys: "<Space>P", context: "normal", to: { action: "timeline.open" } },
    ]);
    expect(f.controller.entries()).toContainEqual(unrelated);
    act(() => f.unregister());
  });

  it("保存待ちのあとに同じキーを変更する場合は、今の割り当てを示してから保存する", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = mountHelp(() => blocked);
    await act(async () => {
      void f.controller.command(":map <Space>T tree.focus");
    });
    expect(f.put).toHaveBeenCalledTimes(1);
    await act(async () => {
      void f.controller.command(":map <Space>T timeline.open");
      release();
    });
    expect(f.put).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("操作の確認").textContent).toContain("Space T は「ツリー」");
    await act(async () => answer(f.controller, "n"));
    expect(f.controller.entries()).toContainEqual({
      keys: "<Space>T",
      context: "normal",
      to: { action: "tree.focus" },
    });
    act(() => f.unregister());
  });

  it("ウィンドウ内の移動を先に、閉じる動作を最後に表示する", async () => {
    const f = mountHelp();
    const editor = screen.getByRole("textbox", { name: "バッファ" });
    await act(async () => {});
    const windowLabels = [...editor.querySelectorAll(".cm-line")]
      .map((line) => line.textContent)
      .filter((line) => /  (左へ|右へ|入力欄へ|会話へ|右を閉じる)  /.test(line ?? ""));
    expect(windowLabels.map((line) => line?.split("  ")[1])).toEqual([
      "左へ",
      "右へ",
      "入力欄へ",
      "会話へ",
      "右を閉じる",
    ]);
    act(() => f.unregister());
  });

  it(":h を実行し、新しいキーとカーソルの動作の名前を表示する", async () => {
    const f = mountHelp();
    const help = within(screen.getByRole("region", { name: "ヘルプ" }));
    await act(async () => f.controller.command(":h"));
    expect(f.navigate).toHaveBeenCalledWith("/help");
    await act(async () => f.controller.command(":map <Space>T timeline.open"));
    expect(f.put).toHaveBeenCalledWith([
      { keys: "<Space>T", context: "normal", to: { action: "timeline.open" } },
    ]);
    await waitFor(() => expect(help.getByText(/Space t、Space T/)).toBeTruthy());
    await act(async () => f.controller.command(String(focusAction("タイムライン"))));
    expect(screen.getByRole("status").textContent).toContain("名前: timeline.open");
    expect(screen.getByRole("status").textContent).toContain(
      ":map <キー> timeline.open で割り当てる",
    );
    act(() => f.unregister());
  });

  it.each([
    ["<Space>sa", "Space s a"],
    ["<Space>s", "Space s a"],
  ])("%s の同一・先頭一致を表示し、n では見送り y では 1 回で保存する", async (keys, readable) => {
    const f = mountHelp();
    await act(async () => f.controller.command(`:map ${keys} timeline.open`));
    expect(screen.getByLabelText("操作の確認").textContent).toContain(
      `${readable} は「全部送る」に使われています`,
    );
    expect(f.put).not.toHaveBeenCalled();
    await act(async () => answer(f.controller, "n"));
    expect(f.put).not.toHaveBeenCalled();
    await act(async () => f.controller.command(`:map ${keys} timeline.open`));
    await act(async () => answer(f.controller, "y"));
    expect(f.put).toHaveBeenCalledTimes(1);
    const argument = f.put.mock.calls[0][0];
    expect(argument).toContainEqual({ keys: "<Space>sa", context: "normal", to: null });
    if (keys === "<Space>s") {
      expect(argument.slice(0, -1).map((entry) => entry.keys)).toEqual([
        "<Space>sa",
        "<Space>sq",
        "<Space>sc",
        "<Space>sg",
      ]);
      expect(screen.queryByLabelText("操作の確認")).toBeNull();
    }
    expect(argument.at(-1)).toEqual({ keys, context: "normal", to: { action: "timeline.open" } });
    expect(
      f.controller.entries().find((x) => x.keys === keys && x.context === "normal")?.to,
    ).toEqual({ action: "timeline.open" });
    act(() => f.unregister());
  });

  it("別端末の割り当てを反映し、カーソルの動作の名前を保つ", async () => {
    const f = mountHelp();
    await act(async () => f.controller.command(String(focusAction("タイムライン"))));
    await act(async () =>
      f.remote([
        { keys: "<Space>t", context: "normal", to: null },
        { keys: "<Space>T", context: "normal", to: { action: "timeline.open" } },
      ]),
    );
    await waitFor(() => expect(screen.getByText("Space T")).toBeTruthy());
    expect(screen.getByRole("status").textContent).toContain("名前: timeline.open");
    act(() => f.unregister());
  });
});
