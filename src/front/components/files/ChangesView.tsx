import { useMemo } from "react";
import type { ChangesResponse } from "../../../shared/files";
import { Frame } from "../../buffer/Frame";
import type { LineInfo } from "../../buffer/line";
import type { FileViewContext } from "../../lib/files/context";
import { singleLine } from "../../lib/files/display";
import { useFileChanges } from "../../lib/files/use-changes";
import { Skeleton } from "../../shell/loading";
import { FileBuffer } from "./FileBuffer";

const labels = { edit: "編集", create: "作成", update: "書き換え" };
const time = new Intl.DateTimeFormat("ja-JP", { timeStyle: "short" });

function changesLines(files: FileViewContext, id: string, data: ChangesResponse): LineInfo[] {
  return [
    { kind: "note", text: "コマンド (Bash など) で変えたファイルは含みません" },
    ...(data.files.length === 0
      ? [{ kind: "note" as const, text: "この会話で AI が変えたファイルはありません" }]
      : []),
    ...data.files.flatMap(({ path, added, removed, changes }): LineInfo[] => [
      { kind: "heading", text: `${singleLine(path)}  追加 ${added} 行、削除 ${removed} 行` },
      ...changes.flatMap(({ seq, createdAt, change, hunks, truncated }): LineInfo[] => [
        {
          kind: "row",
          id: `change:${seq}`,
          text: `${time.format(createdAt)} ${labels[change]}`,
          open: () => files.openRecord(id, seq),
        },
        ...hunks.flatMap(({ oldStart, newStart, lines }) => {
          let oldLine = oldStart,
            newLine = newStart;
          return lines.map((line): LineInfo => {
            const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "code";
            const destination = Math.max(1, newLine);
            const number = kind === "del" ? oldLine : newLine;
            if (kind !== "add") oldLine++;
            if (kind !== "del") newLine++;
            return {
              kind,
              text: `${number} ${singleLine(line)}`,
              open: () => files.openFile(id, path, destination),
            };
          });
        }),
        ...(truncated
          ? [{ kind: "note" as const, text: "(差分が大きいため、一部を省いています)" }]
          : []),
      ]),
    ]),
  ];
}

export function ChangesView({ files, id }: { files: FileViewContext; id: string }) {
  const { data, error } = useFileChanges(files.api, id);
  const lines = useMemo<LineInfo[]>(
    () =>
      data
        ? changesLines(files, id, data)
        : [
            {
              kind: "note",
              text: error instanceof Error ? singleLine(error.message) : "読み込み中",
            },
          ],
    [data, error, files, id],
  );
  return (
    <Frame title="AI が変えた箇所" side="main" active>
      {data || error ? (
        <FileBuffer lines={lines} viewName="file-changes" />
      ) : (
        <Skeleton side="main" />
      )}
    </Frame>
  );
}
