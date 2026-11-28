import useSWR from "swr";
import { z } from "zod";
import type { ScreenContent } from "../App";
import type { BufferController } from "../buffer/controller";
import { Frame } from "../buffer/Frame";
import { Buffer } from "../buffer/Buffer";
import type { RightView } from "../buffer/right-window";
import { WorktreeWindow, worktreeView } from "../components/worktree-window";
import { Skeleton } from "../shell/loading";
import type { ConversationApi } from "./conversation/types";
import { ConversationApiError } from "./conversation/api";
import { parseRoute, type Route } from "./routes";
import type { StockApi } from "./stock/api";
import { openTerminalSchema, terminalOpenedSchema } from "../../shared/api/terminal";
import type { WorktreeApi } from "./worktree-api";
import { createWorktreeLocation, worktreeSelection } from "./worktree-location";
import {
  createTerminalComposer,
  registerTerminalOpen,
  TerminalPage,
  type TerminalMode,
  type TerminalRecord,
} from "../pages/terminal/terminal-page";
import { connectBrowserTerminal } from "../pages/terminal/terminal-client";

const recordSchema = z.object({
  opened: terminalOpenedSchema,
  input: openTerminalSchema,
  projectName: z.string(),
});
const missing = "ターミナルを開いたタブから操作してください。";

export function createWorktreeWorkspace({
  browser,
  controller,
  api,
  conversations,
  stock,
}: {
  browser: Window;
  controller: BufferController;
  api: WorktreeApi;
  conversations: Pick<ConversationApi, "get" | "projects">;
  stock: StockApi;
}) {
  const storage = browser.sessionStorage;
  const selection = worktreeSelection(storage);
  const locate = createWorktreeLocation({
    conversation: conversations.get,
    projects: conversations.projects,
    issue: api.issue,
    selection,
  });
  const key = (id: string) => `sukuna:terminal:${id}`;
  const read = (id: string) => {
    const text = storage.getItem(key(id));
    if (!text) return undefined;
    try {
      return recordSchema.safeParse(JSON.parse(text)).data;
    } catch {
      return undefined;
    }
  };
  const remember = (id: string, record: TerminalRecord) =>
    storage.setItem(key(id), JSON.stringify(record));

  const findDestination = (id: string) =>
    conversations.get(id).then(
      ({ conversation }) => conversation,
      (error: unknown) => {
        if (error instanceof ConversationApiError && error.status === 404) return null;
        throw error;
      },
    );

  const terminal = {
    connect: connectBrowserTerminal(browser),
    exists: api.terminalExists,
    async restart(record: TerminalRecord) {
      const trees = await api.list(record.input.projectId);
      const item = trees.find(({ path }) => path === record.opened.cwd);
      if (!item || item.missing) throw new Error("ターミナルの作業ディレクトリが見つかりません");
      const previous = record.opened.conversationId;
      const destination = previous ? await findDestination(previous) : null;
      const conversationId = item.id === null ? null : (destination?.id ?? null);
      const input = { ...record.input, worktreeId: item.id, conversationId };
      try {
        const opened = await api.openTerminal(input);
        return { ...record, input, opened: { ...opened, conversationId: destination?.id ?? null } };
      } catch (error) {
        if (
          !conversationId ||
          !(error instanceof ConversationApiError) ||
          error.status !== 404 ||
          (await findDestination(conversationId))
        )
          throw error;
        const withoutDestination = { ...input, conversationId: null };
        const reopened = await api.openTerminal(withoutDestination);
        return {
          ...record,
          input: withoutDestination,
          opened: { ...reopened, conversationId: null },
        };
      }
    },
  };

  function Worktrees({ source, opening }: { source: string; opening: number }) {
    const { data, error } = useSWR(["worktree-location", source, opening] as const, ([, url]) =>
      locate(parseRoute(url), "worktree"),
    );
    if (data)
      return (
        <WorktreeWindow
          api={api}
          controller={controller}
          location={data}
          selection={selection}
          opening={opening}
        />
      );
    if (error || data === null)
      return (
        <Frame title="worktree" side="right">
          <Buffer
            side="right"
            lines={[{ kind: "note", text: error?.message ?? "プロジェクトを開いてから使えます" }]}
            onReady={() => {}}
          />
        </Frame>
      );
    return (
      <Frame title="worktree" side="right">
        <Skeleton side="right" />
      </Frame>
    );
  }

  const compose = createTerminalComposer(controller, findDestination, stock);

  return {
    start() {
      const terminalOpen = registerTerminalOpen(
        controller,
        locate,
        async (input) => {
          const opened = await api.openTerminal(input);
          if (input.conversationId || !opened.conversationId) return opened;
          const destination = await findDestination(opened.conversationId).catch(() => undefined);
          return destination === null ? { ...opened, conversationId: null } : opened;
        },
        (record) => {
          remember(record.opened.id, record);
          return controller.navigate(`/terminals/${encodeURIComponent(record.opened.id)}`);
        },
        read,
      );
      const worktreeList = controller.actions.register({
        name: "worktree.list",
        label: "worktree の一覧",
        group: "そのほか",
        where: "会話・issue・プロジェクト",
        async run() {
          const opening = controller.screenOpening();
          const intent = controller.interactionRevision();
          const route = parseRoute(controller.options.url ?? "/");
          const found = await locate(route, "worktree");
          if (controller.screenOpening() !== opening || controller.interactionRevision() !== intent)
            return;
          if (!found) {
            controller.notify("プロジェクトを開いてから使えます");
            return;
          }
          controller.openRight({ view: worktreeView, target: route.id ?? found.projectId });
        },
      });
      return () => {
        terminalOpen();
        worktreeList();
      };
    },
    loadScreen(route: Route): Promise<ScreenContent> | undefined {
      if (route.kind !== "terminal" || !route.id) return;
      const id = route.id;
      const record = read(id);
      if (!record)
        return Promise.resolve({ kind: "error", error: { code: "not_found", message: missing } });
      const modeKey = key(id) + ":mode";
      const initialMode: TerminalMode = storage.getItem(modeKey) === "normal" ? "normal" : "input";
      return import("../pages/terminal/terminal-surface").then(
        ({ createTerminalSurface }): ScreenContent => ({
          kind: "ready",
          title: "ターミナル",
          fullWindow: true,
          content: (
            <TerminalPage
              key={id}
              initial={record}
              initialMode={initialMode}
              terminal={{ ...terminal, createSurface: createTerminalSurface }}
              controller={controller}
              remember={(next) => remember(id, next)}
              rememberMode={(mode) => storage.setItem(modeKey, mode)}
              compose={compose}
            />
          ),
        }),
      );
    },
    renderRight(view: RightView) {
      if (view.view !== worktreeView) return null;
      const source = controller.options.url ?? "/";
      const opening = controller.right.openingRevision();
      return <Worktrees key={`${source}:${opening}`} source={source} opening={opening} />;
    },
  };
}
