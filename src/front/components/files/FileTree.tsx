import { useCallback, useMemo, useState } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部システムとの同期: ツリーの配信とコマンドをウィンドウの寿命に合わせて登録する
import { useEffect } from "react";
import { EditorView } from "@codemirror/view";
import useSWR from "swr";
import { Frame } from "../../buffer/Frame";
import type { LineInfo } from "../../buffer/line";
import type { FileScope, FileViewContext } from "../../lib/files/context";
import { singleLine } from "../../lib/files/display";
import { relativeFilePath } from "../../lib/files/path-at-cursor";
import { fileDiff } from "../../lib/files/realtime";
import { buildFileTree, visibleFileTree } from "../../lib/files/tree";
import { useFileChanges } from "../../lib/files/use-changes";
import { FileBuffer } from "./FileBuffer";

const treeDisplay = EditorView.theme({
  ".cm-menu-name": { minWidth: "max-content" },
  ".cm-menu-effect": { display: "none" },
});

function revealParents(current: ReadonlySet<string>, path?: string): ReadonlySet<string> {
  if (!path) return current;
  const result = new Set(current);
  const parts = path.split("/");
  parts.pop();
  while (parts.length) {
    result.add(parts.join("/"));
    parts.pop();
  }
  return result;
}

export function FileTree({
  files,
  scope,
  currentPath,
}: {
  files: FileViewContext;
  scope: FileScope;
  currentPath?: string;
}) {
  const { id, cwd } = scope;
  const [lastSeq] = useState(scope.lastSeq);
  const [expanded, setExpanded] = useState(() => revealParents(files.treeFolders(id), currentPath));
  const [placement, select] = useState(() => (currentPath ? { id: currentPath } : undefined));
  const [diffs, setDiffs] = useState<ReadonlySet<string>>(() => new Set());
  const { data, error, mutate } = useSWR(["file-tree", id], () => files.api.list(id), {
    revalidateOnMount: true,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    shouldRetryOnError: false,
    dedupingInterval: 0,
  });
  const { data: changes, mutate: reloadChanges } = useFileChanges(files.api, id);
  const root = useMemo(() => buildFileTree(data?.files ?? []), [data]);
  const rows = useMemo(() => visibleFileTree(root, expanded), [root, expanded]);
  const toggle = useCallback(
    (path: string, next: boolean) => {
      const value = new Set(expanded);
      if (next) value.add(path);
      else value.delete(path);
      files.rememberFolders(id, value);
      setExpanded(value);
    },
    [expanded, files, id],
  );
  useEffect(() => {
    let cancel: (() => void) | undefined;
    let refreshFiles = false;
    let refreshChanges = false;
    const off = files.watch({ id, cwd, lastSeq }, (message) => {
      const diff = fileDiff(message);
      if (!diff) return;
      const { path, change } = diff;
      const name = relativeFilePath(path, cwd);
      if (!name) return;
      if (message.topic === `conversation:${id}`) {
        setDiffs((previous) => new Set(previous).add(name));
        refreshChanges = true;
      }
      if (change === "create") refreshFiles = true;
      if ((refreshFiles || refreshChanges) && !cancel)
        cancel = files.schedule(() => {
          cancel = undefined;
          if (refreshFiles) void mutate().catch(() => undefined);
          if (refreshChanges) void reloadChanges().catch(() => undefined);
          refreshFiles = false;
          refreshChanges = false;
        }, 1000);
    });
    return () => {
      cancel?.();
      off();
    };
  }, [files, id, cwd, lastSeq, mutate, reloadChanges]);
  useEffect(
    () =>
      files.controlTree(id, {
        reload: () => {
          void mutate().catch(() => undefined);
          void reloadChanges().catch(() => undefined);
        },
        reveal: (path) => {
          const value = revealParents(files.treeFolders(id), path);
          files.rememberFolders(id, value);
          setExpanded(value);
          select(
            path && files.controller.currentLine("right")?.id !== path ? { id: path } : undefined,
          );
          void mutate().catch(() => undefined);
        },
        folder: (open) => {
          const path = files.controller.currentLine("right")?.id;
          if (path && rows.some((row) => row.path === path && row.folder)) toggle(path, open);
        },
      }),
    [files, id, mutate, reloadChanges, rows, toggle],
  );

  const lines: LineInfo[] = useMemo(() => {
    const changed = new Set(data?.changed);
    const totalChanges = new Set(changes ? changes.files.map(({ path }) => path) : data?.changed);
    const paths = new Set(data?.files);
    diffs.forEach((path) => {
      if (paths.has(path)) changed.add(path);
      totalChanges.add(path);
    });
    return [
      {
        kind: "menu",
        text: `AI が変えた箇所 (${totalChanges.size} ファイル)`,
        open: () => files.openChanges(id),
      },
      ...(data?.truncated
        ? [
            {
              kind: "note" as const,
              text: "ファイルが多いため 20,000 件まで出しています。:files で名前を検索できます",
            },
          ]
        : []),
      ...(error
        ? [
            {
              kind: "note" as const,
              text:
                error instanceof Error
                  ? singleLine(error.message)
                  : "ファイルを取得できませんでした",
            },
          ]
        : []),
      ...(!data && !error ? [{ kind: "skeleton" as const, text: "読み込み中" }] : []),
      ...(data && rows.length === 0
        ? [{ kind: "note" as const, text: "ファイルはありません" }]
        : []),
      ...rows.map(({ folder, path, name, depth }): LineInfo => ({
        kind: "tree",
        id: path,
        text: `${"  ".repeat(depth)}${folder ? (expanded.has(path) ? "▾ " : "▸ ") : "  "}${singleLine(name)}`,
        ...(changed.has(path) && !folder ? { mark: "●" } : {}),
        open: folder ? () => toggle(path, !expanded.has(path)) : () => files.openFile(id, path, 1),
      })),
    ];
  }, [data, changes, diffs, error, expanded, files, id, rows, toggle]);
  return (
    <Frame title="ファイル" side="right">
      <FileBuffer
        lines={lines}
        viewName="file-tree"
        side="right"
        posKey={`/conversations/${id}:right:file-tree`}
        placement={placement}
        ready={data !== undefined}
        display={treeDisplay}
      />
    </Frame>
  );
}
