import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { SWRConfig } from "swr";
import { afterEach, describe, it, expect, vi } from "vite-plus/test";
import type { Settings } from "../../shared/settings/settings-schema";
import type { KeymapEntry } from "../../shared/settings/keymap-schema";
import type { Snapshot } from "../lib/conversation/types";
import { App } from "../App";
import { BufferController } from "../buffer/controller";
import { createConversationApi } from "../lib/conversation/api";
import { createConversationWorkspace } from "../lib/conversation/workspace";
import { createLifecycleApi } from "../lib/lifecycle/api";
import { createRecapApi } from "../lib/recap/api";
import { createSettingsApi, createSettingsStore } from "../lib/settings-store";
import { loadSettingsScreen, registerSettingsCommands } from "../lib/settings-workspace";
import { createNavigation } from "../shell/navigation";

const emptySettings: Settings = {
  keymap: { version: 1, entries: [] },
  backup: { schedule: "03:00", items: [], lastAt: null, lastError: null },
  flowPaused: false,
  runningAiCount: 1,
  lastRestore: null,
  push: { vapidPublicKey: null },
};
const conversation: Snapshot = {
  conversation: {
    id: "keymap-conversation",
    projectId: "p1",
    projectName: "project",
    title: "予約 API",
    kind: "chat",
    issueId: null,
    parentConversationId: null,
    cwd: "/project",
    worktree: null,
    runState: "working",
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
const stops: (() => void)[] = [];
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
});

function textInBuffer(region: HTMLElement): string {
  return EditorView.findFromDOM(region.querySelector(".cm-editor")!)!.state.doc.toString();
}

async function start(
  options: {
    entries?: KeymapEntry[];
    screen?: "conversation" | "help";
    concurrentSave?: KeymapEntry[];
    withRecap?: boolean;
    withLifecycle?: boolean;
  } = {},
) {
  const { entries = [], screen: initialScreen = "conversation" } = options;
  let concurrentSave = options.concurrentSave;
  let revision = 1;
  const revisionHeader = () => `"${revision}"`;
  let settings: Settings = { ...emptySettings, keymap: { version: 1, entries } };
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    if (typeof input !== "string") throw new Error("Expected a relative API path");
    const path = input;
    calls.push(`${options?.method ?? "GET"} ${path}`);
    if (path === "/api/settings")
      return Response.json(settings, { headers: { "X-Keymap-Revision": revisionHeader() } });
    if (path === "/api/settings/keymap" && options?.method === "PUT") {
      if (concurrentSave) {
        settings = { ...settings, keymap: { version: 1, entries: concurrentSave } };
        revision++;
        concurrentSave = undefined;
      }
      const expected = new Headers(options.headers).get("If-Match");
      if (expected !== null && expected !== revisionHeader())
        return Response.json({ error: { code: "keymap_changed" } }, { status: 412 });
      if (typeof options.body !== "string") throw new Error("Expected a JSON body");
      const { entries } = JSON.parse(options.body) as { entries: KeymapEntry[] };
      settings = { ...settings, keymap: { version: 1, entries } };
      revision++;
      return Response.json(settings.keymap);
    }
    if (path === "/api/conversations/keymap-conversation") return Response.json(conversation);
    if (path.startsWith("/api/conversations/keymap-conversation/events?")) {
      return Response.json({ events: [], lastSeq: 0, hasMore: false });
    }
    if (path === "/api/conversations/keymap-conversation/stop") return Response.json({});
    throw new Error(`Unexpected request ${path}`);
  };
  const navigation = createNavigation(
    initialScreen === "help"
      ? { kind: "help" }
      : { kind: "conversation", id: "keymap-conversation" },
    () => {},
  );
  const settingsStore = createSettingsStore(createSettingsApi(fetcher));
  const controller = new BufferController({
    keymap: settingsStore.keymap,
    navigate: navigation.navigate,
  });
  stops.push(registerSettingsCommands(controller));
  const workspace = createConversationWorkspace(
    createConversationApi(fetcher),
    controller,
    {
      clientId: "tab",
      id: () => "id",
      now: () => 1000,
      schedule: () => () => {},
    },
    () => ({
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      send: vi.fn(),
      close: vi.fn(),
    }),
    {
      recap: options.withRecap
        ? {
            api: createRecapApi(fetcher),
            storage: { getItem: () => null, setItem() {}, removeItem() {} },
          }
        : undefined,
      lifecycle: options.withLifecycle
        ? { api: createLifecycleApi(fetcher), openExternal: () => {} }
        : undefined,
    },
  );
  stops.push(workspace.start());
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <App
        controller={controller}
        navigation={navigation}
        loadScreen={(route) =>
          loadSettingsScreen(route, controller, settingsStore, () => "11/26 03:00") ??
          workspace.loadScreen(route)
        }
      />
    </SWRConfig>,
  );
  const main = await screen.findByRole("region", {
    name: initialScreen === "help" ? "ヘルプ" : "会話: 予約 API",
  });
  return {
    controller,
    main,
    calls,
    entries: () => settings.keymap.entries,
    command: async (command: string) => {
      await act(() => controller.command(command));
    },
  };
}

describe("設定の通常操作", () => {
  it.each(["Q", "QQ"])(
    "会話と設定の表示が重ならない割り当てを共存させる (%s)",
    async (secondKeys) => {
      const f = await start();
      await f.command(":map Q agent.stop");
      await f.command(`:map ${secondKeys} settings.keymap-reset`);
      expect(f.entries()).toEqual([
        { keys: "Q", context: "normal", to: { action: "agent.stop" } },
        { keys: secondKeys, context: "normal", to: { action: "settings.keymap-reset" } },
      ]);
      await act(async () => {
        fireEvent.keyDown(within(f.main).getByRole("textbox"), { key: "Q", shiftKey: true });
      });
      const afterConversationKey = [...f.calls];
      await f.command(":set");
      const settings = await screen.findByRole("region", { name: "設定" });
      await act(async () => {
        for (const key of secondKeys)
          fireEvent.keyDown(within(settings).getByRole("textbox"), { key, shiftKey: true });
      });
      expect(screen.getByLabelText("操作の確認").textContent).toContain(
        "キーの割り当てを既定に戻しますか?",
      );
      expect(afterConversationKey).toContain("POST /api/conversations/keymap-conversation/stop");
    },
  );

  it("会話の先頭一致を外しても同じキーで設定に割り当てた動作は残る", async () => {
    const conversationKey = {
      keys: "Qq",
      context: "normal",
      to: { action: "agent.stop" },
    } as const;
    const settingsKey = {
      keys: "Qq",
      context: "normal",
      to: { action: "settings.keymap-reset" },
    } as const;
    const f = await start({ entries: [conversationKey, settingsKey] });
    await f.command(":map Q agent.stop");
    const confirmation = screen.getByLabelText("操作の確認");
    expect(confirmation.textContent).toContain("Q q は「AI を止める」");
    expect(confirmation.textContent).not.toContain("キーの割り当てを既定に戻す");
    await act(async () => {
      expect(f.controller.answer(new KeyboardEvent("keydown", { key: "y" }))).toBe(true);
    });
    expect(f.entries()).toEqual([
      conversationKey,
      settingsKey,
      { keys: "Qq", context: "normal", to: null },
      settingsKey,
      { keys: "Q", context: "normal", to: { action: "agent.stop" } },
    ]);
    await act(async () => {
      fireEvent.keyDown(within(f.main).getByRole("textbox"), { key: "Q", shiftKey: true });
    });
    expect(f.calls).toContain("POST /api/conversations/keymap-conversation/stop");
    await f.command(":set");
    const settings = await screen.findByRole("region", { name: "設定" });
    await act(async () => {
      const editor = within(settings).getByRole("textbox");
      fireEvent.keyDown(editor, { key: "Q", shiftKey: true });
      fireEvent.keyDown(editor, { key: "q" });
    });
    expect(screen.getByLabelText("操作の確認").textContent).toContain(
      "キーの割り当てを既定に戻しますか?",
    );
    await act(async () => {
      f.controller.answer(new KeyboardEvent("keydown", { key: "n" }));
    });
    await f.command(":unmap Qq");
    expect(f.controller.entries()).not.toContainEqual(settingsKey);
    expect(f.controller.entries()).toContainEqual({
      keys: "Q",
      context: "normal",
      to: { action: "agent.stop" },
    });
  });

  it("会話からヘルプへ移動しても保存した会話の割り当てを調べられる", async () => {
    const f = await start();
    await f.command(":map Q agent.stop");
    await f.command(":h");
    const help = await screen.findByRole("region", { name: "ヘルプ" });
    expect(f.entries()).toEqual([{ keys: "Q", context: "normal", to: { action: "agent.stop" } }]);
    expect(f.controller.entries().find((value) => value.keys === "Q")?.to).toEqual({
      action: "agent.stop",
    });
    const documented = [
      "Space x、Q  AI を止める  会話",
      "z o  差分を開く  会話",
      "z c  差分を畳む  会話",
      "d d  預けた指示を取り消す  会話",
      "c c  預けた指示を直す  会話",
      "u  預けた指示を戻す  会話",
      ":stop  AI を止める  会話",
      ":images  画像を外す  会話",
    ];
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    const content = textInBuffer(help);
    expect(documented.filter((row) => !content.includes(row))).toEqual([]);
    expect(f.controller.actions.get("agent.stop")).toBeUndefined();
    await f.command(":stop");
    expect(f.calls).not.toContain("POST /api/conversations/keymap-conversation/stop");
  });

  it("別端末の会話用割り当てを、開いたヘルプからすぐに調べられる", async () => {
    const f = await start({
      screen: "help",
      entries: [{ keys: "Q", context: "normal", to: { action: "agent.stop" } }],
    });
    expect(f.controller.entries().find((value) => value.keys === "Q")?.to).toEqual({
      action: "agent.stop",
    });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(textInBuffer(f.main)).toContain("Space x、Q  AI を止める  会話");
  });

  it("会話を開いていないヘルプで、直近・目次・決まったこと・検索の割り当てを編集できる", async () => {
    const f = await start({
      screen: "help",
      withRecap: true,
      entries: [{ keys: "<Space>M", context: "normal", to: { action: "recap.toc" } }],
    });
    const recapLabels = new Set([
      "直近",
      "目次",
      "決まったこと",
      "目次と決まったことを検索する",
      "章の始まりを移す",
    ]);
    const recapRows = () =>
      textInBuffer(f.main)
        .split("\n")
        .filter((row) => recapLabels.has(row.split("  ")[1]));
    await waitFor(() =>
      expect(recapRows()).toEqual([
        "Space i  直近  会話",
        "Space m、Space M  目次  会話",
        "Space d  決まったこと  会話",
        "/  目次と決まったことを検索する  目次・決まったこと",
        ":toc  章の始まりを移す  会話",
      ]),
    );
    await f.command(":map <Space>I recap.recent");
    await f.command(":map <Space>T recap.toc");
    await f.command(":map <Space>D recap.decisions");
    await f.command(":map <Space>S recap.search");
    expect(f.entries()).toEqual([
      { keys: "<Space>M", context: "normal", to: { action: "recap.toc" } },
      { keys: "<Space>I", context: "normal", to: { action: "recap.recent" } },
      { keys: "<Space>T", context: "normal", to: { action: "recap.toc" } },
      { keys: "<Space>D", context: "normal", to: { action: "recap.decisions" } },
      { keys: "<Space>S", context: "normal", to: { action: "recap.search" } },
    ]);
    await waitFor(() =>
      expect(recapRows()).toEqual([
        "Space i、Space I  直近  会話",
        "Space m、Space M、Space T  目次  会話",
        "Space d、Space D  決まったこと  会話",
        "/、Space S  目次と決まったことを検索する  目次・決まったこと",
        ":toc  章の始まりを移す  会話",
      ]),
    );
  });

  it("会話の一覧・締めくくり・検索を別画面のヘルプで読んで割り当てる", async () => {
    const f = await start({ screen: "help", withLifecycle: true });
    const rows = () => textInBuffer(f.main).split("\n");
    expect(rows()).toEqual(
      expect.arrayContaining([
        "Space b  会話とスレッドの一覧  どこでも",
        "Space z  会話を締めくくる  会話",
        "Space f  issue と会話を検索  どこでも",
        ":convs  会話とスレッドの一覧  共通",
        ":close  会話を締めくくる  会話",
        ":find  issue と会話を検索  共通",
      ]),
    );
    await f.command(":map <Space>B conversation.list");
    await f.command(":map <Space>Z conversation.close");
    await f.command(":map <Space>F search.open");
    expect(f.entries()).toEqual([
      { keys: "<Space>B", context: "normal", to: { action: "conversation.list" } },
      { keys: "<Space>Z", context: "normal", to: { action: "conversation.close" } },
      { keys: "<Space>F", context: "normal", to: { action: "search.open" } },
    ]);
    await waitFor(() =>
      expect(rows()).toEqual(
        expect.arrayContaining([
          "Space b、Space B  会話とスレッドの一覧  どこでも",
          "Space z、Space Z  会話を締めくくる  会話",
          "Space f、Space F  issue と会話を検索  どこでも",
        ]),
      ),
    );
  });

  it.each([
    ["conversation.answers.send", "回答をまとめて送る"],
    ["conversation.answers.confirm", "回答を送る"],
    ["conversation.answered", "送った回答"],
  ])("会話の外のヘルプでも回答操作 %s のキーを読んで変えられる", async (action, label) => {
    const f = await start({
      screen: "help",
      entries: [{ keys: "Q", context: "normal", to: { action } }],
    });
    expect(textInBuffer(f.main).split("\n")).toContain(`Q  ${label}  会話`);
    await f.command(`:map W ${action}`);
    expect(f.entries()).toEqual([
      { keys: "Q", context: "normal", to: { action } },
      { keys: "W", context: "normal", to: { action } },
    ]);
    await waitFor(() => expect(textInBuffer(f.main).split("\n")).toContain(`Q、W  ${label}  会話`));
    expect(f.controller.actions.get(action)).toBeUndefined();
  });

  it("別画面に割り当てた j が設定で動く Vim のキーを覆わない", async () => {
    const conversationBinding = {
      keys: "j",
      context: "normal",
      to: { action: "agent.stop" },
    } as const;
    const f = await start({ entries: [conversationBinding] });
    await f.command(":set");
    const settings = await screen.findByRole("region", { name: "設定" });
    const input = within(settings).getByRole("textbox");
    await f.command(":map j settings.keymap-reset");
    expect(screen.getByLabelText("操作の確認").textContent).toContain("j は「Vim j」");
    await act(async () => {
      expect(f.controller.answer(new KeyboardEvent("keydown", { key: "n" }))).toBe(true);
    });
    expect(f.entries()).toEqual([conversationBinding]);
    await f.command(":map j settings.keymap-reset");
    await act(async () => {
      expect(f.controller.answer(new KeyboardEvent("keydown", { key: "y" }))).toBe(true);
    });
    expect(f.entries()).toEqual([
      conversationBinding,
      { ...conversationBinding, to: null },
      conversationBinding,
      { ...conversationBinding, to: { action: "settings.keymap-reset" } },
    ]);
    await act(async () => fireEvent.keyDown(input, { key: "j" }));
    expect(screen.getByLabelText("操作の確認").textContent).toBe(
      "キーの割り当てを既定に戻しますか? (y / n)",
    );
  });

  it("確認後の他端末の保存で版が変われば、新しい重なりを示してから保存する", async () => {
    const first = { keys: "<Space>Pp", context: "normal", to: { action: "win.right" } } as const;
    const overlapping = {
      keys: "<Space>Pq",
      context: "normal",
      to: { action: "tree.focus" },
    } as const;
    const unrelated = { keys: "<Space>U", context: "normal", to: { action: "open" } } as const;
    const remote = [first, overlapping, unrelated];
    const f = await start({ entries: [first], concurrentSave: remote });
    await f.command(":map <Space>P win.left");
    expect(screen.getByLabelText("操作の確認").textContent).toContain("Space P p");
    await act(async () => {
      expect(f.controller.answer(new KeyboardEvent("keydown", { key: "y" }))).toBe(true);
    });
    expect(screen.getByLabelText("操作の確認").textContent).toContain("Space P q");
    expect(f.entries()).toEqual(remote);
    await act(async () => {
      expect(f.controller.answer(new KeyboardEvent("keydown", { key: "y" }))).toBe(true);
    });
    expect(f.entries()).toEqual([
      ...remote,
      { ...first, to: null },
      { ...overlapping, to: null },
      { keys: "<Space>P", context: "normal", to: { action: "win.left" } },
    ]);
  });

  it("共通の割り当てはヘルプへ移動しても調べられる", async () => {
    const f = await start();
    await f.command(":map Q tree.focus");
    await f.command(":h");
    const help = await screen.findByRole("region", { name: "ヘルプ" });
    expect(help.textContent).toContain("Space p、Q  ツリー  共通");
  });

  it.each(["agent.stop", "tree.focus"])(
    "ヘルプに出る動作をその場で Q に割り当てる (%s)",
    async (action) => {
      const f = await start({ screen: "help" });
      await f.command(`:map Q ${action}`);
      expect(f.entries()).toEqual([{ keys: "Q", context: "normal", to: { action } }]);
    },
  );
});
