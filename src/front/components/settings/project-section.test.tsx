import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { projectPatchSchema, type ProjectSettings } from "../../../shared/api/project";
import type { ProjectsResponse } from "../../../shared/inbox/schema";
import type { Settings } from "../../../shared/settings/settings-schema";
import type { ServerMessage } from "../../../shared/ws";
import { Layout } from "../../buffer/Layout";
import { BufferController } from "../../buffer/controller";
import { InboxStore } from "../../lib/inbox-store";
import { createConversationApi } from "../../lib/conversation/api";
import { createConversationWorkspace } from "../../lib/conversation/workspace";
import type { RealtimeSocket } from "../../lib/realtime";
import { createProjectSettingsApi } from "../../lib/project-settings-api";
import { parseRoute } from "../../lib/routes";
import { createSettingsStore } from "../../lib/settings-store";
import { loadSettingsScreen, registerSettingsCommands } from "../../lib/settings-workspace";

const first: ProjectSettings = {
  id: "p1",
  name: "shop-api",
  path: "/tmp/shop-api",
  usesGithub: true,
  defaultBranch: "main",
  model: null,
  permissionMode: "bypassPermissions",
  autoStages: ["triage", "design", "impl"],
  implConcurrency: 5,
  confirmBeforeMergeDefault: false,
  designMergeMode: "direct",
  flowPaused: false,
  globalFlowPaused: false,
  stopTargetCount: 0,
};
const second: ProjectSettings = { ...first, id: "p2", name: "web", path: "/tmp/web" };
const settingsSeed: Settings = {
  flowPaused: false,
  keymap: { version: 1, entries: [] },
  runningAiCount: 0,
  backup: { schedule: "03:00", lastAt: null, lastError: null, items: [] },
  lastRestore: null,
  push: { vapidPublicKey: null },
};

const readBody = (init?: RequestInit) =>
  typeof init?.body === "string" ? JSON.parse(init.body) : undefined;

const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  disposals.splice(0).forEach((dispose) => dispose());
});

async function setup(seed = [first], url = "/settings", responseError?: string) {
  const details = new Map(seed.map((project) => [project.id, { ...project }]));
  let globalPaused = false;
  const load = vi.fn(async () => ({ ...settingsSeed, flowPaused: globalPaused }));
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    if (typeof input !== "string") throw new Error("文字列の URL を指定してください");
    const path = input;
    const method = init?.method ?? "GET";
    if (path === "/api/issues/closed-issue" && method === "GET") {
      return Response.json({ issue: { projectId: second.id } });
    }
    if (path === "/api/projects" && method === "POST") {
      return Response.json({ error: { message: "すでに登録されています" } }, { status: 409 });
    }
    if (path === "/api/settings/flow-paused" && method === "PUT") {
      globalPaused = readBody(init).paused;
      return Response.json({ paused: globalPaused });
    }
    const id = path.split("/").at(-1)!;
    const detail = details.get(id);
    if (detail && method === "GET") return Response.json(detail);
    if (detail && method === "PATCH") {
      if (responseError)
        return Response.json({ error: { message: responseError } }, { status: 400 });
      const updated = { ...detail, ...projectPatchSchema.parse(readBody(init)) };
      details.set(id, updated);
      return Response.json(updated);
    }
    if (detail && method === "DELETE") {
      details.delete(id);
      return Response.json({ stoppedConversationIds: [] });
    }
    if (path.startsWith("/api/projects/") && method === "GET")
      return Response.json({ error: { message: "プロジェクトが見つかりません" } }, { status: 404 });
    throw new Error(`${method} ${path}`);
  });
  const store = createSettingsStore({
    load,
    replace: async (entries) => ({ version: 1, entries }),
  });
  const projectIndex = async (): Promise<ProjectsResponse> => ({
    projects: [...details.values()].map(({ id, name, flowPaused }) => ({
      id,
      name,
      flowPaused,
      conversations: id === second.id ? [{ id: "c2", title: "web work" }] : [],
      issues: [],
    })),
  });
  const inbox = new InboxStore(
    { projects: projectIndex, inbox: async () => ({ sections: [] }), overview: vi.fn() },
    { now: Date.now, schedule: () => () => {}, storage: window.sessionStorage },
  );
  const navigate = vi.fn();
  const notify = vi.fn();
  const controller = new BufferController({ keymap: store.keymap, url, navigate, notify });
  const socket: RealtimeSocket = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send() {},
    close() {},
  };
  const conversation = createConversationWorkspace(
    createConversationApi(fetcher),
    controller,
    { id: () => "fixture-id", clientId: "fixture", now: Date.now, schedule: () => () => {} },
    () => socket,
    { inbox, settingsChanged: () => void store.refresh() },
  );
  const projects = {
    api: createProjectSettingsApi(fetcher),
    projects: inbox.projects,
    subscribeInbox: (receive: (message?: ServerMessage) => void) =>
      conversation.subscribeChanges("inbox", receive),
  };
  const stopCommands = registerSettingsCommands(controller, projects, store);
  const stopRealtime = conversation.start();
  socket.onopen?.();
  disposals.push(stopRealtime, stopCommands);
  const rendered = await loadSettingsScreen(parseRoute(url), controller, store, () => "", projects);
  if (rendered?.kind !== "ready") throw new Error("設定の画面を開けない");
  await act(async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <Layout controller={controller} main={rendered.content} />
      </SWRConfig>,
    );
  });
  const buffer = () => screen.getByRole("textbox", { name: "バッファ" });
  const rows = () => [...buffer().querySelectorAll(".cm-line")];
  const row = (name: string) => rows().findIndex((line) => line.textContent?.includes(name));
  const press = async (key: string) => {
    await act(async () => {
      fireEvent.keyDown(buffer(), { key });
      fireEvent.keyUp(buffer(), { key });
    });
  };
  const select = async (name: string) => {
    await waitFor(() => expect(row(name)).toBeGreaterThanOrEqual(0));
    await act(async () => controller.command(String(row(name) + 1)));
  };
  const writes = () =>
    fetcher.mock.calls.flatMap(([path, init]) =>
      typeof path === "string" && init?.method && init.method !== "GET"
        ? [
            {
              path,
              method: init.method,
              body: readBody(init),
            },
          ]
        : [],
    );
  const receive = (message: ServerMessage) => socket.onmessage?.({ data: JSON.stringify(message) });
  let inboxSeq = 0;
  const inboxChanged = (ids: string[]) =>
    receive({ topic: "inbox", seq: ++inboxSeq, type: "changed", payload: { project_ids: ids } });
  const externalFlowChange = (paused: boolean) => {
    globalPaused = paused;
    receive({ topic: "app", seq: 1, type: "settings_changed", payload: {} });
  };
  const typeAndSave = async (value: string) => {
    const editor = screen.getByRole("textbox", { name: controller.snapshot().prompt!.label });
    await act(async () => {
      controller.replacePromptText(value);
      if (controller.snapshot().mode === "INSERT") fireEvent.keyDown(editor, { key: "Escape" });
      fireEvent.keyDown(editor, { key: "Enter" });
    });
  };
  return {
    controller,
    navigate,
    notify,
    details,
    fetcher,
    refreshProjects: inbox.projects.refresh.bind(inbox.projects),
    inboxChanged,
    externalFlowChange,
    store,
    rows,
    buffer,
    press,
    select,
    typeAndSave,
    writes,
  };
}

it("値を Enter か i で開き、画面の入力を PATCH の値に直して保存する", async () => {
  const app = await setup();
  await app.select("許可の扱い");
  await app.press("Enter");
  const permissionPrompt = await screen.findByRole("textbox", { name: /許可の扱い/ });
  expect(permissionPrompt).toHaveTextContent("確認しない (bypassPermissions)");
  await app.typeAndSave("acceptEdits");
  expect(app.notify).toHaveBeenCalledWith("許可の扱いを書き換えました", "info");
  await waitFor(() => expect(app.buffer()).toHaveTextContent("編集だけ確認しない (acceptEdits)"));

  for (const [label, value, key] of [
    ["自動で処理する段階", "精査 / 設計", "i"],
    ["実装の同時実行", "8 件まで", "Enter"],
    ["merge", "確認する", "Enter"],
    ["モデル", "opus", "Enter"],
    ["モデル", "", "Enter"],
    ["実装の同時実行", "5 件まで", "Enter"],
  ]) {
    await app.select(label);
    await app.press(key);
    await app.typeAndSave(value);
  }
  expect(app.writes()).toEqual(
    [
      { permissionMode: "acceptEdits" },
      { autoStages: ["triage", "design"] },
      { implConcurrency: 8 },
      { confirmBeforeMergeDefault: true },
      { model: "opus" },
      { model: null },
      { implConcurrency: 5 },
    ].map((body) => ({ path: "/api/projects/p1", method: "PATCH", body })),
  );
});

it("変換できない値は送らず、API エラーでも入力を保持して再送できる", async () => {
  const app = await setup([first], "/settings", "同時実行数を変更できませんでした");
  await app.select("実装の同時実行");
  await app.press("i");
  const input = await screen.findByRole("textbox", { name: /実装の同時実行/ });
  expect(input).toHaveTextContent("5 件まで");
  await app.typeAndSave("21 件まで");
  expect(app.notify).toHaveBeenCalledWith(
    expect.stringMatching(/^実装の同時実行に書ける値:/),
    "error",
  );
  expect(input).toHaveTextContent("21 件まで");
  expect(app.writes()).toEqual([]);
  await app.typeAndSave("3 件まで");
  expect(app.writes()).toEqual([
    { method: "PATCH", path: "/api/projects/p1", body: { implConcurrency: 3 } },
  ]);
  expect(app.notify).toHaveBeenLastCalledWith("同時実行数を変更できませんでした", "error");
  expect(input).toHaveTextContent("3 件まで");
});

it("設計順に値と操作を並べ、パスとフローの状態行を編集しない", async () => {
  const app = await setup();
  await app.select("このプロジェクトの登録を解除する");
  const projectRows = app.rows().map((row) => row.textContent ?? "");
  const expected = [
    "プロジェクト shop-api",
    "モデル",
    "許可の扱い",
    "自動で処理する段階",
    "実装の同時実行",
    "merge",
    "設計書の反映のしかた",
    "このプロジェクトの自動フロー  動作中",
    "名前",
    "パス",
    "GitHub を使う",
    "既定ブランチ",
    "値の行で i を押すと、その値を書けます。",
    "このプロジェクトの自動フローを一時停止する",
    "GitHub の issue を下書きとして取り込む",
    "利用量を見る",
    "プロジェクトを登録する",
    "このプロジェクトの登録を解除する",
  ];
  const start = projectRows.findIndex((line) => line.includes(expected[0]));
  expect(projectRows.slice(start)).toEqual(expected.map((text) => expect.stringContaining(text)));

  for (const name of ["パス", "このプロジェクトの自動フロー  動作中"]) {
    await app.select(name);
    await app.press("Enter");
    await app.press("i");
    expect(app.controller.snapshot().prompt).toBeNull();
  }
  expect(app.writes()).toEqual([]);
});

it("最新の停止対象件数とファイルを消さないことを確認に示し、y で解除する", async () => {
  const app = await setup();
  await app.select("このプロジェクトの登録を解除する");
  app.details.set(first.id, { ...first, stopTargetCount: 2 });
  await app.press("Enter");
  const confirm = await screen.findByLabelText("操作の確認");
  expect(confirm).toHaveTextContent("AI を止める会話 2 件");
  expect(confirm).toHaveTextContent("ファイルは消しません");
  await act(async () => app.controller.answer(new KeyboardEvent("keydown", { key: "n" })));
  expect(app.writes()).toEqual([]);
  await app.press("Enter");
  await screen.findByLabelText("操作の確認");
  await act(async () => app.controller.answer(new KeyboardEvent("keydown", { key: "y" })));
  await waitFor(() =>
    expect(app.writes()).toEqual([{ method: "DELETE", path: "/api/projects/p1", body: undefined }]),
  );
});

it("登録がなければ空の案内と登録の操作を出す", async () => {
  const app = await setup([]);
  await app.select("プロジェクトはまだありません");
  await app.select("プロジェクトを登録する");
  await app.press("Enter");
  const input = await screen.findByRole("textbox", { name: "プロジェクトのパス" });
  await app.typeAndSave("/tmp/already-registered");
  expect(app.notify).toHaveBeenLastCalledWith("すでに登録されています", "error");
  expect(input).toHaveTextContent("/tmp/already-registered");
  expect(app.navigate).not.toHaveBeenCalled();
});

it("全体の一時停止と再開をコマンドで保存し、設定を読み直して表示する", async () => {
  const app = await setup();
  await act(async () => app.controller.command(":pause"));
  await app.select("自動フロー  停止中");
  expect(app.buffer()).toHaveTextContent("自動フローを再開する");
  expect(screen.getByRole("status")).toHaveTextContent("自動フロー停止中");
  expect(app.notify).toHaveBeenCalledWith("自動フローを一時停止しました", "info");
  await act(async () => app.controller.command(":resume"));
  await app.select("自動フロー  動作中");
  expect(app.buffer()).toHaveTextContent("自動フローを一時停止する");
  expect(screen.getByRole("status")).not.toHaveTextContent("自動フロー停止中");
  expect(app.notify).toHaveBeenCalledWith("自動フローを再開しました", "info");
  await act(async () => app.externalFlowChange(true));
  await app.select("自動フロー  停止中");
  expect(app.buffer()).toHaveTextContent("自動フローを再開する");
  expect(screen.getByRole("status")).toHaveTextContent("自動フロー停止中");
  expect(app.writes()).toEqual([
    { path: "/api/settings/flow-paused", method: "PUT", body: { paused: true } },
    { path: "/api/settings/flow-paused", method: "PUT", body: { paused: false } },
  ]);
});

it("プロジェクトの操作で一時停止し、そのプロジェクトの配信だけで設定を読み直す", async () => {
  const app = await setup();
  await app.select("このプロジェクトの自動フローを一時停止する");
  await app.press("Enter");
  await app.select("このプロジェクトの自動フローを再開する");
  expect(app.writes()).toEqual([
    { path: "/api/projects/p1", method: "PATCH", body: { flowPaused: true } },
  ]);
  app.details.set(first.id, { ...first, model: "sonnet", flowPaused: true });
  const reads = app.fetcher.mock.calls.length;
  await act(async () => app.inboxChanged(["unrelated"]));
  expect(app.fetcher.mock.calls.length).toBe(reads);
  await act(async () => app.inboxChanged([first.id]));
  await app.select("モデル  sonnet");
  await act(async () => app.externalFlowChange(true));
  expect(screen.getAllByText("自動フロー停止中", { exact: true })).toHaveLength(1);
});

it("名前の指定、現在の会話、ツリーに無い issue から設定を開き、取り込みと利用量へ移る", async () => {
  const app = await setup([first, second], "/settings?project=p2");
  await app.select("プロジェクト web");
  await act(async () => app.controller.command(":set shop-api"));
  expect(app.navigate).toHaveBeenLastCalledWith("/settings?project=p1");
  app.controller.options.url = "/conversations/c2";
  await act(async () => app.controller.command(":set"));
  expect(app.navigate).toHaveBeenLastCalledWith("/settings?project=p2");
  app.controller.options.url = "/issues/closed-issue";
  app.navigate.mockClear();
  await act(async () => app.controller.command(":set"));
  expect(app.navigate).toHaveBeenLastCalledWith("/settings?project=p2");
  await app.select("GitHub の issue を下書きとして取り込む");
  await app.press("Enter");
  expect(app.navigate).toHaveBeenLastCalledWith("/projects/p2/import");
  await app.select("利用量を見る");
  await app.press("Enter");
  expect(app.navigate).toHaveBeenLastCalledWith("/usage");
});

it("値の行に編集、戻る、番号で実行するヒントを示し、番号を受け付ける", async () => {
  const app = await setup();
  await app.select("許可の扱い");
  const status = screen.getByRole("status");
  expect(status).toHaveTextContent("i 許可の扱いを書く");
  expect(status).toHaveTextContent("- 戻る");
  expect(status).toHaveTextContent("番号 Enter 操作を実行");
  const registration = app
    .rows()
    .find((line) => line.textContent?.includes("プロジェクトを登録する"));
  const menuNumber = registration?.textContent?.match(/^\s*(\d+)/)?.[1];
  expect(menuNumber).toBeDefined();
  for (const digit of menuNumber ?? "") await app.press(digit);
  await app.press("Enter");
  expect(await screen.findByRole("textbox", { name: "プロジェクトのパス" })).toBeVisible();
});

it("ツリー先頭が変わると、対象を明記した解除確認を解除し、古い対象を削除しない", async () => {
  const app = await setup([second]);
  await app.select("このプロジェクトの登録を解除する");
  await app.press("Enter");
  expect(await screen.findByLabelText("操作の確認")).toHaveTextContent(`「${second.name}」`);

  await act(async () => {
    app.details.clear();
    app.details.set(first.id, first);
    app.details.set(second.id, second);
    await app.refreshProjects();
  });
  await app.select(`プロジェクト ${first.name}`);
  expect(screen.queryByLabelText("操作の確認")).not.toBeInTheDocument();
  await app.press("y");
  expect(app.writes()).toEqual([]);
});

it("解除の件数を待つ間に値を書き始めると、後から届いた確認は表示しない", async () => {
  const app = await setup();
  await app.select("このプロジェクトの登録を解除する");
  let release!: (response: Response) => void;
  app.fetcher.mockReturnValueOnce(
    new Promise<Response>((resolve) => {
      release = resolve;
    }),
  );
  await app.press("Enter");
  await app.select("名前");
  await app.press("i");
  const editor = await screen.findByRole("textbox", { name: "名前" });
  await act(async () => release(Response.json({ ...first, stopTargetCount: 2 })));

  expect(editor).toHaveFocus();
  expect(screen.queryByLabelText("操作の確認")).not.toBeInTheDocument();
  expect(app.writes()).toEqual([]);
});

it("旧プロジェクトの入力を保存しても、新しい先頭の値に書き込まない", async () => {
  const app = await setup([second]);
  await app.select("許可の扱い");
  await app.press("i");
  expect(await screen.findByRole("textbox", { name: "許可の扱い" })).toHaveFocus();

  await act(async () => {
    app.details.clear();
    app.details.set(first.id, first);
    app.details.set(second.id, second);
    await app.refreshProjects();
  });
  await waitFor(() => expect(app.buffer()).toHaveTextContent(`プロジェクト ${first.name}`));
  app.fetcher.mockClear();
  await app.typeAndSave("acceptEdits");

  expect(app.writes()).toEqual([
    {
      path: "/api/projects/p2",
      method: "PATCH",
      body: { permissionMode: "acceptEdits" },
    },
  ]);
  expect(app.fetcher.mock.calls.some(([path]) => path === "/api/projects/p1")).toBe(false);
  expect(app.buffer()).toHaveTextContent(`プロジェクト ${first.name}`);
  expect(app.buffer()).toHaveTextContent("確認しない (bypassPermissions)");
});

it("明示 URL の対象が解除されたら、別の対象を表示せずその編集欄を閉じる", async () => {
  const app = await setup([first, second], "/settings?project=p2");
  await app.select("許可の扱い");
  await app.press("i");
  expect(await screen.findByRole("textbox", { name: "許可の扱い" })).toHaveFocus();

  await act(async () => {
    app.details.delete(second.id);
    app.inboxChanged([second.id]);
    await app.refreshProjects();
  });

  expect(await screen.findByRole("alert")).toHaveTextContent("プロジェクトが見つかりません");
  expect(screen.queryByRole("textbox", { name: "許可の扱い" })).not.toBeInTheDocument();
  expect(screen.queryByText(`プロジェクト ${first.name}`)).not.toBeInTheDocument();
  expect(app.navigate).not.toHaveBeenCalled();
});

it.each([
  { keys: ["k", "v"], mode: "VISUAL", operation: "別の行を選択する" },
  { keys: ["k", "j"], mode: "NORMAL", operation: "カーソルを元の行へ戻す" },
  { keys: ["v", "Escape"], mode: "NORMAL", operation: "選択して Normal に戻る" },
])("件数を待つ間に別の操作を始めると確認を出さない ($operation)", async ({ keys, mode }) => {
  const app = await setup();
  await app.select("このプロジェクトの登録を解除する");
  let release!: (response: Response) => void;
  app.fetcher.mockReturnValueOnce(
    new Promise<Response>((resolve) => {
      release = resolve;
    }),
  );
  await app.press("Enter");
  for (const key of keys) await app.press(key);
  expect(app.controller.snapshot().mode).toBe(mode);
  await act(async () => release(Response.json({ ...first, stopTargetCount: 2 })));

  expect(screen.queryByLabelText("操作の確認")).not.toBeInTheDocument();
  await app.press("y");
  expect(app.writes()).toEqual([]);
});
