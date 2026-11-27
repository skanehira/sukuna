import { useEffectEvent, useMemo, useRef, useSyncExternalStore } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部システムとの同期: 表示中のスレッドだけを購読し、スレッド用のキーと入力欄を登録する
import { useEffect } from "react";
import useSWR from "swr";
import type { Quote } from "../../../shared/stock";
import { isThreadRight } from "../../buffer/right-window";
import type { BufferController } from "../../buffer/controller";
import { Frame } from "../../buffer/Frame";
import type { ColumnDef, LineInfo } from "../../buffer/line";
import { ConversationApiError } from "../../lib/conversation/api";
import type { ConversationSession } from "../../lib/conversation/session";
import type { ConversationApi } from "../../lib/conversation/types";
import { completedProposal } from "../../lib/stock/proposal";
import type { StockSession } from "../../lib/stock/session";
import { FileBuffer } from "../files/FileBuffer";
import type { LifecycleFeed } from "../lifecycle/use-lifecycle";
import { quotePreview } from "./StockWindow";

export const stockThreadView = "stock-thread";
const menuColumns: ColumnDef[] = [{ name: "thread-menu", widths: [1.4, 21, 0] }];
const singleLine = (value: string) => value.split(/\r?\n/, 1)[0];

type Interaction = {
  interaction: number;
  opening: number;
  right: number;
  prompt: number;
};
type PendingProposal = Interaction & {
  sequence: number | null;
  hydrated: boolean;
  confirmFromHistory: boolean;
};

export function ThreadWindow({
  session,
  id,
  stock,
  parentTitle,
  controller,
  conversations,
  subscribe,
  showConversation,
  jump,
  finished,
  missing,
}: {
  session: ConversationSession;
  id: string;
  stock: StockSession;
  parentTitle: string;
  controller: BufferController;
  conversations: ConversationApi;
  subscribe: LifecycleFeed;
  showConversation(this: void, id: string): () => void;
  jump(this: void, quote: Quote): void | Promise<void>;
  finished(this: void): void;
  missing(this: void, id: string, parent: string): void;
}) {
  const snapshot = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const parent = useSyncExternalStore(stock.subscribe, stock.snapshot, stock.snapshot);
  const thread = parent.threads.find((entry) => entry.id === id);
  const original = parent.items.find(
    (item) => item.id === thread?.stockId || (item.kind === "question" && item.thread?.id === id),
  );
  const quote = thread?.quote ?? original?.quote;
  const loadThread = async () => {
    await session.load();
    const target = session.snapshot().data?.conversation;
    if (!target || target.kind !== "thread" || target.parentConversationId !== stock.id)
      throw new ConversationApiError(404, "not_found", "この会話のスレッドが見つかりません");
    return target.id;
  };
  const { data, error, mutate } = useSWR(["stock-thread", session, stock.id], loadThread, {
    shouldRetryOnError: false,
    revalidateOnMount: true,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });
  const active = useRef(false);
  const observedThread = useRef(false);
  const pending = useRef<PendingProposal | undefined>(undefined);
  const denied =
    error instanceof ConversationApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 425, 429].includes(error.status);
  const target = snapshot.data?.conversation;
  const ready =
    data === id && target?.kind === "thread" && target.parentConversationId === stock.id && !denied;
  const focused = () => {
    const view = controller.right.current;
    return view && isThreadRight(view) && view.target === id && view.parent === stock.id;
  };
  useEffect(() => {
    if (error instanceof ConversationApiError && error.status === 404) missing(id, stock.id);
  }, [error, id, missing, stock.id]);
  useEffect(() => {
    if (thread) observedThread.current = true;
    else if (observedThread.current && parent.loaded.threads) {
      observedThread.current = false;
      void mutate().catch(() => undefined);
    }
  }, [thread, parent.loaded.threads, mutate]);
  const retryOnReconnect = error !== undefined && !ready && !denied;
  useEffect(() => {
    if (!retryOnReconnect) return;
    return subscribe("app", (message) => {
      if (!message || message.type === "resync") void mutate().catch(() => undefined);
    });
  }, [retryOnReconnect, subscribe, mutate]);

  const captureInteraction = (): Interaction => ({
    interaction: controller.interactionRevision(),
    opening: controller.screenOpening(),
    right: controller.right.openingRevision(),
    prompt: controller.snapshot().promptId,
  });
  const mayPresent = (start: Interaction) => {
    const state = controller.snapshot();
    const current = captureInteraction();
    return (
      active.current &&
      focused() &&
      state.active === "right" &&
      !state.prompt &&
      state.command === null &&
      !state.confirmation &&
      current.prompt === start.prompt &&
      current.interaction === start.interaction &&
      current.opening === start.opening &&
      current.right === start.right
    );
  };
  const latestUserMessage = () =>
    session.eventRecords().findLast((event) => event.type === "user_message");
  const openProposal = (proposal: string) => {
    session.proposeFinish(proposal, async (text, stillCurrent) => {
      const result = await stock.api.finish(id, text);
      stock.finished(result.item);
      if (active.current && focused() && stillCurrent()) finished();
      controller.notify("確定事項を指示としてストックに入れ、スレッドを終えました");
    });
  };
  const confirmHistory = (seq: number, proposal: string) => {
    const first = Array.from(singleLine(proposal.trimStart()));
    const preview = first.length > 80 ? first.slice(0, 80).join("") + "…" : first.join("");
    controller.confirm(
      `記録 ${seq} の確定事項の案「${preview}」を開きますか?`,
      controller.context("right"),
      async () => {
        const selected = captureInteraction();
        await loadThread();
        const current = completedProposal(session.eventRecords());
        if (!mayPresent(selected)) return;
        if (current?.seq !== seq || current.text !== proposal) {
          controller.notify("案の記録が変わりました。メニューからもう一度開いてください");
          return;
        }
        openProposal(proposal);
      },
    );
  };
  const processProposal = () => {
    const request = pending.current;
    if (!request?.hydrated || request.sequence === null || !active.current || !focused()) return;
    const latest = latestUserMessage();
    if (
      latest?.type !== "user_message" ||
      latest.seq !== request.sequence ||
      latest.payload.origin !== "finish_proposal"
    ) {
      pending.current = undefined;
      controller.notify("確定事項の案を取得できませんでした", "error");
      return;
    }
    const proposal = completedProposal(session.eventRecords());
    if (!proposal) return;
    pending.current = undefined;
    if (!proposal.text) {
      controller.notify("確定事項の案を取得できませんでした", "error");
      return;
    }
    if (!mayPresent(request)) {
      controller.notify("確定事項の案が届きました。スレッドのメニューから開けます");
      return;
    }
    if (request.confirmFromHistory) confirmHistory(proposal.seq, proposal.text);
    else openProposal(proposal.text);
  };
  const processUpdate = useEffectEvent(processProposal);
  useEffect(() => {
    if (!ready) return;
    active.current = true;
    const stop = session.connect();
    const unshow = showConversation(id);
    const watch = subscribe(
      `conversation:${id}`,
      (message) => {
        if (!message || message.type === "resync") void mutate().catch(() => undefined);
        else session.receive(message);
      },
      session.receivedThrough(),
    );
    const next = session.subscribe(() => processUpdate());
    return () => {
      active.current = false;
      pending.current = undefined;
      next();
      watch();
      unshow();
      stop();
    };
  }, [ready, session, showConversation, subscribe, id, mutate]);

  const lines = useMemo((): LineInfo[] => {
    if (error && !ready)
      return [
        {
          kind: "note",
          text: error instanceof Error ? singleLine(error.message) : "スレッドを読めませんでした",
        },
      ];
    if (!ready || !snapshot.data) return [{ kind: "skeleton", text: "読み込み中" }];
    const conversation = snapshot.data.conversation;
    const input = session
      .eventRecords()
      .find((event) => event.type === "user_message" && event.payload.origin === "stock");
    const question =
      original?.text ?? (input?.type === "user_message" ? input.payload.text : conversation.title);
    const head: LineInfo[] = [
      { kind: "note", text: `元の会話: ${parentTitle} から分岐` },
      {
        kind: "row",
        text: `質問: ${singleLine(question)}`,
        ...(quote ? { open: () => jump(quote) } : {}),
      },
      ...(quote ? quotePreview(quote) : []),
    ];
    const footer: LineInfo[] =
      conversation.closedAt === null
        ? [
            {
              kind: "menu",
              text: "確定事項をまとめて終える",
              colDef: "thread-menu",
              main: true,
              open: async () => {
                if (pending.current) return;
                const proposal: PendingProposal = {
                  ...captureInteraction(),
                  sequence: null,
                  hydrated: false,
                  confirmFromHistory: false,
                };
                pending.current = proposal;
                try {
                  const sequence = await stock.api.propose(id);
                  if (pending.current !== proposal) return;
                  await loadThread();
                  if (pending.current !== proposal) return;
                  if (sequence === null) {
                    const latest = latestUserMessage();
                    if (
                      latest?.type !== "user_message" ||
                      latest.payload.origin !== "finish_proposal"
                    )
                      throw new Error("受け付けた確定事項の案を記録から確認できませんでした");
                    proposal.sequence = latest.seq;
                    proposal.confirmFromHistory = true;
                  } else {
                    if (session.receivedThrough() < sequence)
                      throw new Error("確定事項の案の記録を読み込めませんでした");
                    proposal.sequence = sequence;
                  }
                  proposal.hydrated = true;
                  processProposal();
                } catch (failure) {
                  if (pending.current === proposal) pending.current = undefined;
                  throw failure;
                }
              },
            },
            {
              kind: "menu",
              text: "閉じるだけ",
              open: async () => {
                await stock.api.close(id);
                stock.finished();
                await session.refresh();
                if (active.current && focused())
                  controller.notify("スレッドを閉じました。元の箇所の印から開けます");
              },
            },
            ...(conversation.runState === "working"
              ? [
                  {
                    kind: "menu" as const,
                    text: "このスレッドの AI を止める",
                    open: async () => {
                      pending.current = undefined;
                      await conversations.stop(id);
                      await session.refresh();
                      if (active.current && focused())
                        controller.notify("スレッドの AI を止めました");
                    },
                  },
                ]
              : []),
          ]
        : [{ kind: "menu", text: "再開する", action: "prompt.open" }];
    const failure =
      error instanceof Error ? singleLine(error.message) : "スレッドを読めませんでした";
    return [
      ...head,
      ...session.bodyLines(),
      ...(error ? [{ kind: "note" as const, text: failure }] : []),
      ...footer,
    ];
  }, [
    snapshot,
    ready,
    error,
    controller,
    conversations,
    id,
    jump,
    original,
    parentTitle,
    quote,
    session,
    stock,
  ]);
  const title = snapshot.data?.conversation.title;
  return (
    <Frame side="right" title={title ? `スレッド: ${title}` : "スレッド"}>
      <FileBuffer
        side="right"
        viewName={stockThreadView}
        columns={menuColumns}
        lines={lines}
        ready={ready || error !== undefined}
      />
    </Frame>
  );
}
