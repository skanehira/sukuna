import { useMemo } from "react";
import useSWR from "swr";
import { Frame } from "../../buffer/Frame";
import type { LineInfo } from "../../buffer/line";
import type { FileViewContext } from "../../lib/files/context";
import { singleLine } from "../../lib/files/display";
import { Skeleton } from "../../shell/loading";
import { FileBuffer } from "./FileBuffer";

export function SearchResults({
  files,
  id,
  mode,
  query,
  entry,
}: {
  files: FileViewContext;
  id: string;
  mode: "content" | "name";
  query: string;
  entry: string;
}) {
  const { data, error } = useSWR(["file-search", entry], () => files.search(id, mode, query), {
    revalidateIfStale: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    shouldRetryOnError: false,
  });
  const title = mode === "content" ? "ファイルの中身を検索" : "ファイルの名前を検索";
  const lines = useMemo<LineInfo[]>(() => {
    if (error)
      return [
        {
          kind: "note",
          text: error instanceof Error ? singleLine(error.message) : "検索できませんでした",
        },
      ];
    if (!data) return [];
    const prefix = mode === "content" ? "rg" : "files";
    const results: LineInfo[] =
      data.mode === "content"
        ? data.matches.map(({ path, line, col, text }) => ({
            kind: "row",
            text: `${singleLine(path)}:${line}:  ${singleLine(text)}`,
            id: JSON.stringify([path, line]),
            open: () => files.openFile(id, path, line, col),
          }))
        : data.matches.map(({ path }) => ({
            kind: "row",
            text: singleLine(path),
            id: path,
            open: () => files.openFile(id, path, 1),
          }));
    return [
      { kind: "heading", text: `${prefix} "${singleLine(data.query)}"   ${results.length} 件` },
      ...(data.mode === "content" && data.timedOut
        ? [
            {
              kind: "note" as const,
              text: "検索を 10 秒で打ち切りました。見つかった結果だけを出しています",
            },
          ]
        : []),
      ...(data.truncated
        ? [{ kind: "note" as const, text: "結果が多いため、一部を省いています" }]
        : []),
      ...(results.length === 0
        ? [
            {
              kind: "note" as const,
              text: mode === "content" ? "一致する行はありません" : "一致するファイルはありません",
            },
          ]
        : results),
    ];
  }, [data, error, files, id, mode]);
  return (
    <Frame title={title} side="main" active>
      {data || error ? (
        <FileBuffer
          lines={lines}
          viewName="file-search"
          side="table"
          posKey={`${entry}:main:file-search`}
        />
      ) : (
        <Skeleton side="table" />
      )}
    </Frame>
  );
}
