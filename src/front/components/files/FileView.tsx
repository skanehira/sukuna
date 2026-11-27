import { useEffectEvent, useMemo, useRef, useState } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部システムとの同期: ファイルの配信とキーボード操作を画面の寿命に合わせて登録する
import { useEffect } from "react";
import useSWR from "swr";
import type { FileContentResponse } from "../../../shared/files";
import { Frame } from "../../buffer/Frame";
import type { LineInfo } from "../../buffer/line";
import { ConversationApiError } from "../../lib/conversation/api";
import type { FileScope, FileViewContext } from "../../lib/files/context";
import { fileSyntax, isMarkdown, singleLine, sizeLabel } from "../../lib/files/display";
import { markdownPreview } from "../../lib/files/markdown-decorations";
import { relativeFilePath } from "../../lib/files/path-at-cursor";
import { fileDiff } from "../../lib/files/realtime";
import { FileBuffer } from "./FileBuffer";

function contentLines(data?: FileContentResponse, error?: unknown): LineInfo[] {
  if (error)
    return [
      {
        kind: "note",
        text: singleLine(error instanceof Error ? error.message : "ファイルを取得できませんでした"),
      },
    ];
  if (!data) return [{ kind: "skeleton", text: "読み込み中" }];
  if (data.kind !== "text")
    return [
      {
        kind: "note",
        text:
          data.kind === "binary"
            ? `文字として読めないため表示できません (大きさ ${sizeLabel(data.size)})`
            : `表示できません (大きさ ${sizeLabel(data.size)}、上限 1 MB)`,
      },
    ];
  if (!data.content) return [{ kind: "note", text: "(空のファイル)" }];
  return data.content.split(/\r\n?|\n/).map((text) => ({ kind: "code", text, cursor: true }));
}

function compareContent(previous: FileContentResponse, current: FileContentResponse) {
  if (previous.kind !== current.kind || previous.size !== current.size) return "changed";
  if (previous.kind === "text" && current.kind === "text")
    return previous.content === current.content ? "same" : "changed";
  return "unverified";
}

function retryable(error: unknown): boolean {
  return !!error && (!(error instanceof ConversationApiError) || error.status >= 500);
}

export function FileView({
  files,
  scope,
  url,
  path,
  startLine,
  initialContent,
}: {
  files: FileViewContext;
  scope: FileScope;
  url: string;
  path: string;
  startLine: number;
  initialContent?: FileContentResponse;
}) {
  const { id, cwd } = scope;
  const watchedPath = relativeFilePath(path, cwd) ?? path;
  const [preview, setPreview] = useState(true);
  const [changed, setChanged] = useState(false);
  const [checksRequested, requestCheck] = useState(0);
  const [dismissedCheck, dismissCheck] = useState(0);
  const comparison = useRef<AbortController | null>(null);
  const replay = useRef<AbortController | null>(null);
  const opening = useRef(initialContent === undefined ? null : scope);
  const markdown = isMarkdown(path);
  const { data, error, isValidating, mutate } = useSWR(
    ["file-content", id, path],
    async () => {
      try {
        return await files.api.content(id, path);
      } catch (error) {
        if (error instanceof ConversationApiError && error.status === 404) files.reloadTree(id);
        throw error;
      }
    },
    {
      fallbackData: initialContent,
      revalidateOnMount: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
      dedupingInterval: 0,
    },
  );
  const compare = useSWR(
    data && !error && !isValidating && !changed && checksRequested > dismissedCheck
      ? ["file-change-check", id, path, checksRequested]
      : null,
    async () => {
      comparison.current?.abort();
      const request = new AbortController();
      comparison.current = request;
      try {
        const current = await files.api.content(id, path, request.signal);
        request.signal.throwIfAborted();
        return compareContent(data!, current);
      } catch (failure) {
        request.signal.throwIfAborted();
        if (failure instanceof ConversationApiError && failure.status === 404) return "changed";
        throw failure;
      } finally {
        if (comparison.current === request) comparison.current = null;
      }
    },
    {
      shouldRetryOnError: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      onSuccess: (result) => {
        if (result === "changed") setChanged(true);
      },
    },
  );
  const retryComparison = useEffectEvent(() => {
    if (retryable(compare.error) && !compare.isValidating)
      void compare.mutate().catch(() => undefined);
  });
  const { data: syntax } = useSWR(
    !markdown || !preview ? ["file-syntax", path] : null,
    () => fileSyntax(path),
    { revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false },
  );
  const lines = useMemo(() => contentLines(data, error), [data, error]);
  useEffect(() => {
    const firstRead = opening.current === null;
    const baseline = (opening.current ??= files.readStart(scope));
    const request = new AbortController();
    replay.current = request;
    const stop = files.watch(
      baseline,
      (message) => {
        const diff = fileDiff(message);
        if (diff && relativeFilePath(diff.path, cwd) === watchedPath) {
          comparison.current?.abort();
          setChanged(true);
        }
      },
      {
        replaySignal: request.signal,
        recheck: () => requestCheck((count) => count + 1),
        reconnected: () => retryComparison(),
      },
    );
    if (firstRead) void mutate().catch(() => undefined);
    return () => {
      request.abort();
      comparison.current?.abort();
      stop();
    };
  }, [files, scope, cwd, watchedPath, mutate]);
  useEffect(
    () =>
      files.controlFile(url, {
        reload: () => {
          replay.current?.abort();
          comparison.current?.abort();
          dismissCheck(checksRequested);
          setChanged(false);
          void mutate().catch(() => undefined);
        },
        toggle: () => setPreview((current) => !current),
      }),
    [files, url, mutate, checksRequested],
  );

  const updateNotice = changed
    ? "AI がこのファイルを変えました。:e で読み直します"
    : compare.data === "unverified" || compare.error
      ? "ファイルの変更を確認できませんでした。:e で読み直します"
      : null;
  const title = `${singleLine(path)}  ${data && !error ? `${sizeLabel(data.size)}  ` : ""}読み取り専用`;
  const initial = Math.min(startLine, lines.length - 1);
  const view = markdown ? "markdown-file" : "file";
  return (
    <Frame title={title} side="main" active>
      {updateNotice ? (
        <div className="shrink-0 border-b border-line px-4 py-1 text-sm text-doing" role="status">
          {updateNotice}
        </div>
      ) : null}
      {data || error ? (
        <FileBuffer
          lines={lines}
          viewName={view}
          startLine={initial}
          display={markdown && preview ? markdownPreview : syntax}
        />
      ) : (
        <p className="px-4 py-2 text-muted" role="status">
          読み込み中
        </p>
      )}
    </Frame>
  );
}
