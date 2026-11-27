import type { ScreenContent } from "../../App";
import type { BufferController } from "../../buffer/controller";
import type { ActionDef } from "../../buffer/keymap/registry";
import type { TimerPort } from "../../buffer/position-store";
import { ChangesView } from "../../components/files/ChangesView";
import { FileTree } from "../../components/files/FileTree";
import { FileView } from "../../components/files/FileView";
import { SearchResults } from "../../components/files/SearchResults";
import type { FileContentResponse } from "../../../shared/files";
import { ConversationApiError } from "../conversation/api";
import { parseRoute, routeUrl, screenKey, type Route } from "../routes";
import type { StockSession } from "../stock/session";
import type { FilesApi } from "./api";
import type { FileControls, FileScope, FileViewContext, TreeControls } from "./context";
import { isMarkdown } from "./display";
import { pathAtCursor, relativeFilePath } from "./path-at-cursor";

const outside = "会話のディレクトリの外のファイルは開けません";
const deniedStock = "差分には、会話かファイルの表示で質問と指示を付けてください";
const fileViews = ["file", "markdown-file"];
type PreparedFile = { url: string; entry: string; data: FileContentResponse; scope: FileScope };
export const filesRouteViews = new Set(["file", "changes", "grep", "files"]);

function positive(text: string | null): number {
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : 1;
}

function conversationUrl(id: string): string {
  return `/conversations/${encodeURIComponent(id)}`;
}

function fileUrl(id: string, path: string, line: number): string {
  return `${conversationUrl(id)}/file?${new URLSearchParams({ path, line: String(line) })}`;
}

export function createFilesWorkspace({
  api,
  controller,
  schedule,
  watch,
  prepare,
  readStart,
  refreshScope,
  entryId,
  scope,
  stock,
}: {
  api: FilesApi;
  controller: BufferController;
  schedule: TimerPort["schedule"];
  watch: FileViewContext["watch"];
  prepare: (scope: FileScope, signal?: AbortSignal) => Promise<FileScope>;
  readStart: FileViewContext["readStart"];
  refreshScope: (id: string) => Promise<FileScope>;
  entryId: () => string;
  scope: (id: string) => FileScope | undefined;
  stock?: (id: string) => StockSession;
}) {
  const files = new Map<string, FileControls>();
  const trees = new Map<string, TreeControls>();
  const folds = new Map<string, ReadonlySet<string>>();
  let prepared: PreparedFile | undefined;
  let pendingFile: AbortController | undefined;
  let pendingSearch: AbortController | undefined;
  const currentRoute = () => parseRoute(controller.options.url ?? "/");
  const currentScope = () => {
    const route = currentRoute();
    return route.kind === "conversation" && route.id ? scope(route.id) : undefined;
  };
  const currentPath = () => {
    const route = currentRoute();
    return route.kind === "conversation" && route.view === "file"
      ? (new URLSearchParams(route.query).get("path") ?? undefined)
      : undefined;
  };
  const navigateMain = (url: string, remember = true, entry?: string) => {
    const place = controller.context();
    if (remember) controller.pushJump(place.window, place.line);
    controller.focus("main");
    return controller.navigate(url, entry);
  };
  const open = async (id: string, path: string, line: number, column = 0, entry?: string) => {
    const url = fileUrl(id, path, line);
    const view = isMarkdown(path) ? "markdown-file" : "file";
    const current = routeUrl(currentRoute()) === url ? files.get(url) : undefined;
    if (current) {
      controller.focus("main");
      controller.place("main", line - 1, column);
      current.reload();
      return;
    }
    controller.positions.setPosition(`${url}:main:${view}`, {
      line: line - 1,
      column,
      topLine: line - 1,
    });
    await navigateMain(url, true, entry);
  };
  const openFromConversation = async (context: FileScope, path: string, line: number) => {
    const { url: previousUrl, entry: previousEntry } = controller.options;
    pendingFile?.abort();
    const request = new AbortController();
    pendingFile = request;
    const active = () =>
      !request.signal.aborted &&
      previousUrl === controller.options.url &&
      previousEntry === controller.options.entry;
    const stop = controller.subscribe(() => {
      if (!active()) request.abort();
    });
    try {
      const root = await refreshScope(context.id);
      if (!active()) return;
      const metadata = await prepare(root, request.signal);
      if (!active()) return;
      const scope = readStart(metadata);
      const data = await api.content(scope.id, path, request.signal);
      if (!active()) return;
      const entry = entryId();
      prepared = { url: fileUrl(scope.id, path, line), entry, data, scope };
      stop();
      await open(scope.id, path, line, 0, entry);
    } catch (error) {
      if (!active()) return;
      controller.notify(
        error instanceof Error ? error.message : "ファイルを開けませんでした",
        "error",
      );
      if (error instanceof ConversationApiError && error.status === 404)
        trees.get(context.id)?.reload();
    } finally {
      stop();
      if (pendingFile === request) pendingFile = undefined;
    }
  };

  const context: FileViewContext = {
    api,
    controller,
    schedule,
    watch,
    readStart,
    async search(id, mode, query) {
      if (!query.trim()) throw new Error("検索する語を入れてください");
      pendingSearch?.abort();
      const request = new AbortController();
      pendingSearch = request;
      try {
        return await api.search(id, mode, query, request.signal);
      } finally {
        if (pendingSearch === request) pendingSearch = undefined;
      }
    },
    openFile: open,
    openChanges: (id) => {
      void navigateMain(`${conversationUrl(id)}/changes`);
    },
    openRecord: (id, seq) => {
      void navigateMain(`${conversationUrl(id)}?seq=${seq}`, true, entryId());
    },
    reloadTree: (id) => trees.get(id)?.reload(),
    controlFile(url, controls) {
      files.set(url, controls);
      return () => {
        if (files.get(url) === controls) files.delete(url);
      };
    },
    controlTree(id, controls) {
      trees.set(id, controls);
      return () => {
        if (trees.get(id) === controls) trees.delete(id);
      };
    },
    treeFolders: (id) => folds.get(id) ?? new Set<string>(),
    rememberFolders: (id, expanded) => {
      folds.set(id, expanded);
    },
  };

  const currentTree = () => {
    const id = currentScope()?.id;
    return id && controller.right.current?.view === "file-tree" ? trees.get(id) : undefined;
  };
  const currentFile = () => {
    const route = currentRoute();
    return files.get(routeUrl(route));
  };
  const requireSearchScope = () => {
    const root = currentScope();
    if (!root) controller.notify("会話を開いてから検索してください", "error");
    return root;
  };
  const search = (view: "grep" | "files", query: string) => {
    const root = requireSearchScope();
    if (!root) return;
    if (!query.trim()) {
      controller.notify("検索する語を入れてください", "error");
      return;
    }
    const url = `${conversationUrl(root.id)}/${view}?${new URLSearchParams({ q: query })}`;
    pendingSearch?.abort();
    return navigateMain(url, false, entryId());
  };

  return {
    openFile: open,
    takePrepared(route: Route): PreparedFile | undefined {
      if (!prepared || prepared.entry !== route.entry || prepared.url !== routeUrl(route))
        return undefined;
      const opening = prepared;
      prepared = undefined;
      return opening;
    },
    async render(
      route: Route,
      root: FileScope,
      prepared?: PreparedFile,
      onResolved?: (available: boolean) => void,
    ): Promise<ScreenContent> {
      const params = new URLSearchParams(route.query);
      const url = routeUrl(route);
      if (route.view === "file") {
        const path = params.get("path") ?? "";
        const opening = prepared?.scope ?? (await prepare(root));
        return {
          kind: "ready",
          title: path,
          fullWindow: true,
          content: (
            <FileView
              files={context}
              scope={opening}
              url={url}
              path={path}
              startLine={positive(params.get("line")) - 1}
              initialContent={prepared?.data}
              onResolved={onResolved}
              stock={stock?.(opening.id)}
            />
          ),
        };
      }
      if (route.view === "changes")
        return {
          kind: "ready",
          title: "AI が変えた箇所",
          fullWindow: true,
          content: <ChangesView files={context} id={root.id} />,
        };
      const mode = route.view === "grep" ? "content" : "name";
      const title = mode === "content" ? "ファイルの中身を検索" : "ファイルの名前を検索";
      return {
        kind: "ready",
        title,
        fullWindow: true,
        content: (
          <SearchResults
            files={context}
            id={root.id}
            mode={mode}
            query={params.get("q") ?? ""}
            entry={screenKey(route)}
          />
        ),
      };
    },
    tree(id: string) {
      const base = currentScope();
      if (!base || base.id !== id) return null;
      return <FileTree key={id} files={context} scope={base} currentPath={currentPath()} />;
    },
    start() {
      const action = (name: string, label: string, run: ActionDef["run"], views?: string[]) =>
        controller.actions.register({
          name,
          label,
          group: "そのほか",
          where: "ファイル",
          views,
          run,
        });
      const oldTarget = controller.options.openTarget;
      const intercept: typeof oldTarget = (target, actionContext) => {
        const targetRoute = parseRoute(target.url);
        const root = currentScope();
        if (
          root &&
          actionContext.view === "conversation" &&
          targetRoute.kind === "conversation" &&
          targetRoute.view === "file"
        ) {
          const params = new URLSearchParams(targetRoute.query);
          const path = relativeFilePath(params.get("path") ?? "", root.cwd);
          if (path) void openFromConversation(root, path, positive(params.get("line")));
          else controller.notify(outside, "error");
          return true;
        }
        return oldTarget?.(target, actionContext) ?? false;
      };
      controller.options.openTarget = intercept;
      const removers = [
        action("files.tree", "ファイルツリー", () => {
          const root = currentScope();
          if (!root) {
            controller.notify("会話を開いてから使えます");
            return;
          }
          currentTree()?.reveal(currentPath());
          controller.openRight({ view: "file-tree", target: root.id });
        }),
        action("files.folder-open", "フォルダを開く", () => currentTree()?.folder(true), [
          "file-tree",
        ]),
        action("files.folder-close", "フォルダを閉じる", () => currentTree()?.folder(false), [
          "file-tree",
        ]),
        action(
          "files.markdown-toggle",
          "Markdown の表示を切り替える",
          () => currentFile()?.toggle(),
          ["markdown-file"],
        ),
        action("files.grep", "ファイルの中身を検索する", () => {
          if (requireSearchScope()) controller.openCommand("rg ");
        }),
        action(
          "files.open-path",
          "パスを開く",
          async ({ window }) => {
            const root = currentScope();
            const line = controller.currentLine(window);
            if (!root || !line) return;
            const target = pathAtCursor(line.text, controller.currentColumn(window), root.cwd);
            if (!target) return;
            if ("outside" in target) {
              controller.notify(outside, "error");
              return;
            }
            await openFromConversation(root, target.path, target.line);
          },
          ["conversation"],
        ),
        action("files.diff-question", "差分に質問する", () => controller.notify(deniedStock), [
          "file-changes",
        ]),
        action("files.diff-instruct", "差分に指示する", () => controller.notify(deniedStock), [
          "file-changes",
        ]),
        controller.commands.register({
          name: "rg",
          label: "ファイルの中身を検索する",
          run: (_args, raw) => search("grep", raw),
        }),
        controller.commands.register({
          name: "files",
          label: "ファイルの名前を検索する",
          run: (_args, raw) => search("files", raw),
        }),
        controller.commands.register({
          name: "changes",
          label: "AI が変えた箇所",
          run: () => {
            const root = currentScope();
            if (root) context.openChanges(root.id);
            else controller.notify("会話を開いてから使えます");
          },
        }),
        controller.commands.register({
          name: "e",
          label: "ファイルを読み直す",
          run: () => {
            const view = controller.context().view;
            if (view === "file-tree") currentTree()?.reload();
            else if (fileViews.includes(view)) currentFile()?.reload();
          },
        }),
      ];
      return () => {
        pendingFile?.abort();
        prepared = undefined;
        removers.forEach((remove) => remove());
        if (controller.options.openTarget === intercept) controller.options.openTarget = oldTarget;
        pendingFile?.abort();
        pendingSearch?.abort();
      };
    },
  };
}
