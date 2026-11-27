import { useMemo } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部システムとの同期: 表示中の締めくくりの行に対応するキー操作を登録する
import { useEffect } from "react";
import type { ServerMessage } from "../../../shared/ws";
import { Buffer } from "../../buffer/Buffer";
import { copyText } from "../../buffer/clipboard";
import type { BufferController } from "../../buffer/controller";
import { Frame } from "../../buffer/Frame";
import type { LineInfo } from "../../buffer/line";
import { ConversationApiError } from "../../lib/conversation/api";
import type { ClosingSummary, LifecycleApi } from "../../lib/lifecycle/api";
import { issueUrl, singleLine } from "../../lib/lifecycle/rows";
import { useBufferLines, useLifecycleData, type LifecycleFeed } from "./use-lifecycle";

const title = "会話を締めくくる";
export const closingView = "closing";
const confirmClose = "lifecycle.close";
const stopAndClose = "lifecycle.stop-and-close";
const cancelClose = "lifecycle.cancel-close";
const runRowAction = "lifecycle.closing-row";
const safeRow = "closing:retained-content";
const draftNote = "閉じても、会話の内容・目次・決まったことは残ります。";

type RowAction = { kind: "copy" | "external"; value: string };
type ClosingContent = { lines: LineInfo[]; actions: Map<string, RowAction> };

function closingChanged(message: ServerMessage) {
  return (
    message.type === "state" ||
    (message.type === "changed" &&
      (message.payload.parts ?? []).some((part) => part === "stock" || part === "threads"))
  );
}

function createClosingContent(
  summary: ClosingSummary | undefined,
  id: string,
  error: unknown,
): ClosingContent {
  const actions = new Map<string, RowAction>();
  if (!summary)
    return {
      actions,
      lines: [
        {
          kind: error ? "note" : "skeleton",
          text:
            error instanceof Error
              ? singleLine(error.message)
              : error
                ? "締めくくりの確認を取得できませんでした"
                : "読み込み中",
        },
        { kind: "note", text: "q で会話に戻る" },
      ],
    };
  const lines: LineInfo[] = [];
  const heading = (text: string) => lines.push({ kind: "heading", text });
  const note = (text: string) => lines.push({ kind: "note", text });
  const pair = (
    name: string,
    value: string,
    extra?: Pick<LineInfo, "id" | "target" | "action">,
  ) => {
    const cols = [name, singleLine(value)];
    lines.push({ kind: "pair", text: cols.join("  "), cols, colDef: "closing-pair", ...extra });
  };
  const failure = (reason: string) => "取得できませんでした (" + reason + ")";
  const group = <T,>(
    name: string,
    data: { ok: true; items: T[]; more?: number } | { ok: false; error: string } | undefined,
    item: (value: T) => [string, Pick<LineInfo, "id" | "target" | "action">?],
  ) => {
    if (!data) {
      pair(name, "Git の管理外");
      return;
    }
    if (!data.ok) {
      pair(name, failure(data.error));
      return;
    }
    if (data.items.length === 0) pair(name, "なし");
    for (const [index, value] of data.items.entries()) {
      const [text, target] = item(value);
      pair(index === 0 ? name : "", text, target);
    }
    if (data.more) pair("", "ほか " + data.more + " 件");
  };
  const store = (key: string, action: RowAction) => {
    actions.set(key, action);
    return { id: key, action: runRowAction };
  };
  const { outputs, remaining, git, working } = summary;
  if (working) note("AI が作業中です。閉じるには AI を止めます");
  if (error)
    note(
      error instanceof Error ? singleLine(error.message) : "締めくくりの確認を取得できませんでした",
    );
  heading("できたもの");
  note("この会話を始めてから、この作業場所でできたもの");
  group("issue", outputs.issues, (issue) => [
    "#" + issue.number + " " + issue.title,
    { id: "issue:" + issue.id, target: { url: issueUrl(issue.id, issue.state) } },
  ]);
  group("ファイル", outputs.files, (path) => [
    path,
    {
      id: "file:" + path,
      target: {
        url:
          "/conversations/" +
          encodeURIComponent(id) +
          "/file?path=" +
          encodeURIComponent(path) +
          "&line=1",
      },
    },
  ]);
  group("コミット", git ? outputs.commits : undefined, (commit) => [
    commit.hash + " " + commit.subject,
    store("commit:" + commit.hash, { kind: "copy", value: commit.hash }),
  ]);
  group("PR", git ? outputs.prs : undefined, (pr) => [
    "#" + pr.number + " " + pr.title,
    store("pr:" + pr.url, { kind: "external", value: pr.url }),
  ]);
  heading("残っているもの");
  group("未コミット", git ? remaining.uncommitted : undefined, (path) => [path]);
  const unpushed = git ? remaining.unpushed : undefined;
  pair(
    "未 push",
    !unpushed
      ? "Git の管理外"
      : unpushed.ok
        ? (unpushed.count === 0 ? "なし" : unpushed.count + " 件") +
          (unpushed.upstream ? "" : " (上流のブランチなし)")
        : failure(unpushed.error),
  );
  const { instructions, questions } = remaining.stock;
  pair(
    "ストック",
    instructions || questions ? "指示 " + instructions + " 件 / 質問 " + questions + " 件" : "なし",
  );
  if (remaining.runningThreads.length) {
    remaining.runningThreads.forEach((thread, index) =>
      pair(index === 0 ? "スレッド" : "", thread.title),
    );
  } else pair("スレッド", "なし");
  heading("操作");
  lines.push(
    {
      kind: "menu",
      colDef: "closing-menu",
      main: true,
      danger: working,
      text: working ? "AI を止めて、この会話を閉じる" : "この会話を閉じる",
      id: working ? stopAndClose : confirmClose,
      action: working ? stopAndClose : confirmClose,
    },
    {
      kind: "menu",
      colDef: "closing-menu",
      id: cancelClose,
      text: "やめて会話に戻る",
      action: cancelClose,
    },
  );
  lines.push({ kind: "note", id: safeRow, text: draftNote });
  note("worktree とファイルは消しません。");
  return { lines, actions };
}

const columns = [
  { name: "closing-pair", widths: [5, 0], classes: ["text-[12px] text-muted", ""] },
  { name: "closing-menu", widths: [1.4, 30, 0] },
];

export function ClosingWindow({
  id,
  conversationTitle,
  api,
  subscribe,
  controller,
  openExternal,
}: {
  id: string;
  conversationTitle: string;
  api: LifecycleApi;
  subscribe: LifecycleFeed;
  controller: BufferController;
  openExternal: (url: string) => void;
}) {
  const { data, error, mutate } = useLifecycleData(
    ["closing-summary", api, id],
    () => api.closingSummary(id),
    subscribe,
    "conversation:" + id,
    closingChanged,
  );
  const { lines, actions } = useMemo(
    () => createClosingContent(data, id, error),
    [data, id, error],
  );
  const ready = useBufferLines(lines, safeRow);
  useEffect(() => {
    const register = (name: string, label: string, run: () => void | Promise<void>) =>
      controller.actions.register({
        name,
        label,
        group: "会話",
        where: title,
        views: [closingView],
        run,
      });
    const close = async (stopIfWorking: boolean) => {
      try {
        await api.close(id, stopIfWorking);
      } catch (error) {
        if (error instanceof ConversationApiError && error.status === 409) {
          await mutate().catch(() => {});
        }
        throw error;
      }
      if (
        controller.right.current?.view === closingView &&
        controller.right.current.target === id
      ) {
        controller.closeRight();
        await controller.navigate("/");
      }
      controller.notify(
        "会話: " + conversationTitle + " を閉じました。Space b の一覧から開き直せます",
      );
    };
    const removers = [
      register(confirmClose, "この会話を閉じる", () => close(false)),
      register(stopAndClose, "AI を止めて、この会話を閉じる", () => close(true)),
      register(cancelClose, "やめて会話に戻る", () => controller.closeRight()),
      register(runRowAction, "成果を開く", async () => {
        const row = actions.get(controller.currentLine()?.id ?? "");
        if (row?.kind === "copy" && controller.options.clipboard) {
          await copyText(row.value, {
            ...controller.options.clipboard,
            notify: () =>
              controller.notify("コミットのハッシュをクリップボードに書けませんでした", "error"),
          });
        } else if (row?.kind === "external" && /^https?:\/\//i.test(row.value))
          openExternal(row.value);
      }),
    ];
    return () => removers.forEach((remove) => remove());
  }, [actions, api, controller, conversationTitle, id, mutate, openExternal]);
  return (
    <Frame title={title} side="right">
      <Buffer side="right" viewName={closingView} lines={lines} columns={columns} onReady={ready} />
    </Frame>
  );
}
