import { useContext, useMemo, useRef, useState } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部システムとの同期: 設計の配信とバッファの操作を登録する
import { useEffect } from "react";
import useSWR from "swr";
import { emptyDesignRejection } from "../../../shared/api/design";
import { ScreenOpeningContext, type BufferController } from "../../buffer/controller";
import type { LifecycleFeed } from "../../components/lifecycle/use-lifecycle";
import type { LineInfo } from "../../buffer/line";
import { ListingBuffer } from "../../components/listing-buffer";
import { parseRoute } from "../../lib/routes";
import { matchesQuotedLine, sameDesignPosition } from "../../lib/stock/quote";
import { designMarks } from "../../lib/stock/workspace";
import type { ConversationSession } from "../../lib/conversation/session";
import type { ConversationDraft } from "../../../shared/conversation/api";
import type { StockSession } from "../../lib/stock/session";
import type { DesignApi } from "./design-api";
import { approvalConfirmation, designLines, designViewName } from "./design-lines";

export type IssueDesign = {
  api: DesignApi;
  enterStock?(
    this: void,
    scope: { id: string; title: string; issueId: string },
    issueId: string,
  ): () => void;
  stockSession?(this: void, id: string): StockSession;
};

export function DesignView({
  id,
  title,
  positionKey,
  controller,
  design,
  subscribe,
  loadConversation,
  stopDetail,
  showConversation,
}: {
  id: string;
  title: string;
  positionKey: string;
  controller: BufferController;
  design: IssueDesign;
  subscribe: LifecycleFeed;
  loadConversation?: (id: string) => Promise<ConversationSession>;
  stopDetail: string | null;
  showConversation: (conversationId?: string) => void;
}) {
  const opening = useContext(ScreenOpeningContext) ?? controller.screenOpening();
  const { api, enterStock, stockSession } = design;
  const { data, error, mutate } = useSWR(["issue-design", api, id], () => api.get(id), {
    revalidateOnFocus: false,
    revalidateOnMount: false,
  });
  const route = parseRoute(controller.options.url ?? "/");
  const params = new URLSearchParams(route.view === "design" ? route.query : undefined);
  const quotePath = params.get("path");
  const quoteText = params.get("quote");
  const quoteLine = Number(params.get("line"));
  const quoteSide = params.get("quoteSide");
  const quoteRowLine = Number(params.get("quoteRow"));
  const quoteBlockEnd = params.has("quoteBlockEnd")
    ? Number(params.get("quoteBlockEnd"))
    : undefined;
  const sourceRow =
    (quoteSide === "old" || quoteSide === "new") &&
    Number.isSafeInteger(quoteRowLine) &&
    quoteRowLine > 0
      ? { side: quoteSide as "old" | "new", line: quoteRowLine }
      : undefined;
  const col = Number(params.get("col"));
  const quoteColumn = Number.isSafeInteger(col) && col >= 0 ? col : 0;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(quotePath ? [quotePath] : []),
  );
  const mounted = useRef(false);
  const dismiss = useRef<(() => void) | undefined>(undefined);
  const conversationId = data?.designConversationId;
  const { data: session } = useSWR(
    conversationId && loadConversation
      ? ["design-conversation", loadConversation, conversationId]
      : null,
    ([, load, id]) => load(id),
    { revalidateOnFocus: false },
  );
  const conversationTitle = session?.snapshot().data?.conversation.title ?? "設計の会話";
  const stock = conversationId ? stockSession?.(conversationId) : undefined;
  const marks = useMemo(
    () =>
      stock && {
        read: (lines: Parameters<typeof designMarks>[1]) =>
          new Map([...designMarks(stock, lines)].map(([index, mark]) => [index, mark.symbol])),
        subscribe: stock.subscribe,
      },
    [stock],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      dismiss.current?.();
      dismiss.current = undefined;
    };
  }, []);
  const open = (path: string) => setExpanded((current) => new Set([...current, path]));

  useEffect(() => {
    const refresh = () => void mutate().catch(() => {});
    const leave = subscribe(`issue:${id}`, refresh);
    refresh();
    return leave;
  }, [id, mutate, subscribe]);
  useEffect(() => {
    if (!conversationId || (loadConversation && !session)) return;
    const leave = enterStock?.({ id: conversationId, title: conversationTitle, issueId: id }, id);
    const unsubscribe = subscribe(`conversation:${conversationId}`, (message) => {
      const catchup = !message || message.type === "resync";
      const parts = message?.type === "changed" ? message.payload.parts : [];
      if (catchup || !parts || parts.includes("stock")) void mutate().catch(() => {});
      if (catchup || !parts || parts.includes("draft")) void session?.refresh().catch(() => {});
    });
    return () => {
      unsubscribe();
      leave?.();
      const prompt = controller.snapshot().prompt;
      if (prompt?.scope === conversationId && prompt.label === "差し戻し") controller.closePrompt();
    };
  }, [
    controller,
    conversationId,
    conversationTitle,
    enterStock,
    id,
    loadConversation,
    mutate,
    session,
    subscribe,
  ]);

  useEffect(() => {
    const views = [designViewName];
    const context = { views, where: "設計", group: "そのほか" as const };
    const current = () => mounted.current && controller.screenOpening() === opening;
    const refresh = () => void mutate().catch(() => {});
    const stockCount = () => {
      const state = stock?.snapshot();
      return state?.loaded.stock
        ? state.items.filter((item) => item.kind === "instruction" && item.state === "stocked")
            .length
        : (data?.unsentInstructionCount ?? 0);
    };
    const actions = [
      controller.actions.register({
        ...context,
        name: "design.approve",
        label: "承認して実装へ進める",
        run(origin) {
          const head = data?.headCommit;
          if (!current() || data?.status !== "reviewing" || !head) return;
          dismiss.current = controller.confirm(
            approvalConfirmation(stockCount()),
            origin,
            async () => {
              if (!current()) return;
              try {
                await api.approve(id, head);
              } catch (error) {
                refresh();
                throw error;
              }
              if (!current()) return;
              controller.notify("承認しました。設計書を反映し、実装を始めます");
              showConversation();
            },
          );
        },
      }),
      controller.actions.register({
        ...context,
        name: "design.reject",
        label: "指摘を書いて差し戻す",
        async run() {
          if (!current() || data?.status !== "reviewing") return;
          const target = `${title} / 一緒に届くストックの指示 ${stockCount()} 件`;
          const submit = async (text: string, draft: ConversationDraft | null) => {
            if (!current()) throw new Error("設計を開き直してください");
            if (!text.trim() && stockCount() === 0) throw new Error(emptyDesignRejection.message);
            try {
              await api.reject(id, text, draft);
            } finally {
              refresh();
            }
          };
          const succeeded = () => {
            if (!current()) return;
            controller.notify("差し戻しました。設計した会話の続きで直します");
            showConversation(conversationId ?? undefined);
          };
          if (conversationId && loadConversation) {
            const resolved = session ?? (await loadConversation(conversationId));
            await resolved.refresh(false, current);
            if (current()) resolved.openDesignRejection(target, submit, succeeded);
          } else {
            controller.openPrompt({
              label: "差し戻し",
              target,
              verb: "差し戻す",
              allowEmpty: true,
              async submit(text) {
                await submit(text, null);
                succeeded();
              },
              close() {},
            });
          }
        },
      }),
      controller.registerActionInterceptor("diff.expand", {
        views,
        run({ window }) {
          const path = controller.currentLine(window)?.designDiff?.path;
          if (!path) return false;
          setExpanded((value) => new Set([...value, path]));
          return true;
        },
      }),
      controller.registerActionInterceptor("diff.collapse", {
        views,
        run({ window }) {
          const path = controller.currentLine(window)?.designDiff?.path;
          if (!path) return false;
          setExpanded((value) => new Set([...value].filter((file) => file !== path)));
          return true;
        },
      }),
    ];
    return () => {
      actions.forEach((remove) => remove());
    };
  }, [
    api,
    controller,
    conversationId,
    data,
    id,
    loadConversation,
    mutate,
    opening,
    session,
    showConversation,
    stock,
    title,
  ]);

  const lines: LineInfo[] = data
    ? designLines(
        data.status === "merge_failed" && stopDetail
          ? { ...data, reflection: { ...data.reflection, failure: stopDetail } }
          : data,
        expanded,
        open,
      )
    : [
        {
          kind: "note" as const,
          text: error instanceof Error ? error.message : "設計を読み込んでいます",
        },
      ];
  const quoteRow = quotePath
    ? lines.findIndex(
        ({ designDiff, text }) =>
          designDiff?.path === quotePath &&
          designDiff.newNo !== undefined &&
          sameDesignPosition(
            { line: designDiff.newNo, row: designDiff.row },
            { line: quoteLine, row: sourceRow },
          ) &&
          (quoteText === null || matchesQuotedLine(text, quoteText, quoteColumn, quoteBlockEnd)),
      )
    : -1;

  return (
    <ListingBuffer
      side="main"
      viewName={designViewName}
      posKey={positionKey}
      lines={lines}
      marks={marks}
      ready={data !== undefined}
      initialPosition={quoteRow >= 0 ? { line: quoteRow, column: quoteColumn } : undefined}
    />
  );
}
