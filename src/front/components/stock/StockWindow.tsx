import { useMemo, useSyncExternalStore } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部システムとの同期: ストック一覧のキーを登録し閉じると解除する
import { useEffect } from "react";
import type { PublishResponse } from "../../../shared/api/pr";
import type { BufferController } from "../../buffer/controller";
import type { Quote, StockItem } from "../../../shared/stock";
import { Frame } from "../../buffer/Frame";
import type { LineInfo } from "../../buffer/line";
import type { StockSession } from "../../lib/stock/session";
import { FileBuffer } from "../files/FileBuffer";

export const stockView = "stock-list";
export type PublishStock = (ids: string[]) => Promise<PublishResponse | undefined>;

const firstLine = (value: string) => value.split(/\r?\n/, 1)[0];

export function quoteSummary(quote: Quote): string {
  switch (quote.kind) {
    case "conversation":
      return "会話";
    case "file":
      return `${quote.path}:${quote.start.line}`;
    case "design_diff":
      return `設計 ${quote.path}:${quote.start.line}`;
    case "pr_diff":
      return `PR ${quote.path}:${quote.start.line}`;
    case "terminal":
      return "ターミナル";
  }
}

export function quotePreview(quote: Quote): LineInfo[] {
  return quote.text
    .split("\n")
    .slice(0, 2)
    .map((value) => ({ kind: "note", text: `    > ${value}` }));
}

export function StockWindow({
  stock,
  title,
  jump,
  publication,
  showSentInstructions = false,
}: {
  stock: StockSession;
  title: string;
  jump(this: void, item: StockItem): void | Promise<void>;
  publication?: { controller: BufferController; publish: PublishStock };
  showSentInstructions?: boolean;
}) {
  const state = useSyncExternalStore(stock.subscribe, stock.snapshot, stock.snapshot);
  const controller = publication?.controller;
  const publish = publication?.publish;
  useEffect(() => {
    if (!controller || !publish) return;
    let dismiss: (() => void) | undefined;
    let pending = false;
    const unregister = controller.actions.register({
      name: "stock.publish",
      label: "PR のレビューコメントを GitHub に投稿する",
      group: "質問と指示",
      where: "ストックの一覧",
      views: [stockView],
      run(context) {
        if (pending || controller.right.current?.target !== stock.id) return;
        const rows = controller.windowLines(context.window);
        const selected = context.selection?.ranges.map(({ line }) => rows[line]) ??
          context.selectedLines ?? [rows[context.line]];
        const ids = new Set(
          selected.flatMap((line) => (line?.kind === "row" && line.id ? [line.id] : [])),
        );
        const instructions = stock
          .snapshot()
          .items.filter((item) => ids.has(item.id) && item.kind === "instruction");
        if (!instructions.length) return controller.notify("投稿する指示を選んでください");
        if (ids.size > 50) return controller.notify("一度に投稿できるのは 50 件までです", "error");
        const opening = controller.screenOpening();
        const right = controller.right.openingRevision();
        dismiss = controller.confirm(
          `選んだ指示 ${instructions.length} 件を、PR のレビューコメントとして GitHub に投稿しますか?`,
          context,
          async () => {
            if (
              opening !== controller.screenOpening() ||
              right !== controller.right.openingRevision()
            )
              return;
            pending = true;
            try {
              const result = await publish([...ids]);
              if (!result) return;
              await stock.load("stock");
              if (opening === controller.screenOpening())
                controller.notify(
                  `指示 ${result.published.length} 件を GitHub に投稿しました${result.skipped.length ? `。${result.skipped.length} 件を飛ばしました` : ""}`,
                );
            } finally {
              pending = false;
            }
          },
        );
      },
    });
    return () => {
      dismiss?.();
      unregister();
    };
  }, [controller, publish, stock]);
  const lines = useMemo(() => {
    const items = state.items.filter((item) => item.state === "stocked");
    const questions = items.filter((item) => item.kind === "question").length;
    const visible = showSentInstructions
      ? state.items.filter(
          (item) =>
            item.state === "stocked" || (item.kind === "instruction" && item.state === "sent"),
        )
      : items;
    const rows: LineInfo[] = visible.flatMap((item): LineInfo[] => [
      {
        kind: "row",
        id: item.id,
        text: `${item.state === "sent" ? "→" : item.kind === "instruction" ? "!" : "?"} ${quoteSummary(item.quote)} ${firstLine(item.text)}${item.githubCommentUrl ? "  GitHub に投稿済み" : ""}`,
        open: () => jump(item),
      },
      ...quotePreview(item.quote).map((line, index) => ({
        ...line,
        id: `stock-quote:${item.id}:${index}`,
      })),
      ...(item.stale
        ? [
            {
              kind: "note" as const,
              id: `stock-stale:${item.id}`,
              text: "    箇所が古くなっています (保存した引用の文を出しています)",
            },
          ]
        : []),
    ]);
    if (state.errors.stock) rows.push({ kind: "note", text: firstLine(state.errors.stock) });
    else if (!state.loaded.stock) rows.push({ kind: "skeleton", text: "読み込み中" });
    else if (!visible.length)
      rows.push(
        { kind: "note", text: "この会話のストックはありません。" },
        { kind: "note", text: "箇所を選び、Space q で質問、Space c で指示を書きます。" },
      );
    if (items.length)
      rows.push(
        { kind: "section", text: `送る (送り先: ${title})` },
        {
          kind: "menu",
          text: `全部送る (${items.length} 件)`,
          open: () => stock.send(title, "all"),
          main: true,
        },
        {
          kind: "menu",
          text: `質問だけ送る (${questions} 件)`,
          open: () => stock.send(title, "questions"),
        },
        {
          kind: "menu",
          text: `指示だけ送る (${items.length - questions} 件)`,
          open: () => stock.send(title, "instructions"),
        },
      );
    return rows;
  }, [state, stock, title, jump, showSentInstructions]);
  return (
    <Frame title={`ストック: ${title}`} side="right">
      <FileBuffer
        side="right"
        viewName={stockView}
        lines={lines}
        placement={state.placement}
        ready={state.loaded.stock || state.errors.stock !== undefined}
      />
    </Frame>
  );
}
