import { useContext, useMemo, useRef, useState, type ReactNode } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部システムとの同期: PR の配信とキー操作を登録し、画面を離れると解除する
import { useEffect } from "react";
import useSWR, { SWRConfig } from "swr";
import type { IssueView } from "../../../shared/issue/schema";
import type { PrResponse } from "../../../shared/api/pr";
import { Frame } from "../../buffer/Frame";
import { ScreenOpeningContext, type BufferController } from "../../buffer/controller";
import type { ColumnDef, LineInfo } from "../../buffer/line";
import { FileBuffer } from "../../components/files/FileBuffer";
import type { LifecycleFeed } from "../../components/lifecycle/use-lifecycle";
import type { ConversationSession } from "../../lib/conversation/session";
import { ConversationApiError } from "../../lib/conversation/api";
import { conversationActions } from "../../lib/conversation/keymap";
import type { createStockWorkspace } from "../../lib/stock/workspace";
import { issueFormColumns } from "./issue-form-lines";
import type { PrApi } from "./pr-api";
import {
  mergePrompt,
  prLines,
  prQuoteSources,
  prUnavailableLines,
  prView,
  runningChecks,
  type PrLine,
} from "./pr-lines";
import { prImageDisplay } from "./pr-images";

export type PrReviewServices = {
  api: PrApi;
  stock?: Pick<ReturnType<typeof createStockWorkspace>, "session" | "enterReview">;
  openExternal: (url: string) => void;
  schedule: (run: () => void, ms: number) => () => void;
  trackDraft: (session: ConversationSession) => (() => void) | undefined;
  watchDraft: (id: string, current: () => boolean) => () => void;
};

type Props = {
  issue: IssueView;
  project: { path: string; usesGithub: boolean };
  controller: BufferController;
  services: PrReviewServices;
  subscribe: LifecycleFeed;
  loadConversation: (id: string, current?: () => boolean) => Promise<ConversationSession>;
  title: string;
  tabs: ReactNode;
  positionKey: string;
};

const columns: ColumnDef[] = [...issueFormColumns, { name: "pr-checks", widths: [17, 7, 9] }];
const loading: LineInfo[] = [{ kind: "skeleton", text: "読み込み中" }];
const canPublish = (data?: PrResponse) => data?.source === "github" && data.pr?.state === "open";
const awaitingMerge = (issue: IssueView) =>
  issue.state === "stopped" && issue.stopReason === "merge_confirm";

function location(query: string) {
  const params = new URLSearchParams(query);
  const path = params.get("path");
  const side = params.get("side");
  const line = Number(params.get("line"));
  const col = Number(params.get("col"));
  return path && (side === "old" || side === "new") && Number.isSafeInteger(line) && line > 0
    ? { path, side, line, col: Number.isSafeInteger(col) && col >= 0 ? col : 0 }
    : null;
}

type PrRead =
  | { ok: true; data: PrResponse }
  | { ok: false; data?: PrResponse; error: { message: string; status?: number } };

export function PrView(props: Props) {
  const [config] = useState(() => {
    const cache = new Map();
    return { provider: () => cache };
  });
  return (
    <SWRConfig value={config}>
      <PrReviewBody {...props} />
    </SWRConfig>
  );
}

function PrReviewBody({
  issue,
  project,
  controller,
  services,
  subscribe,
  loadConversation,
  title,
  tabs,
  positionKey,
}: Props) {
  const opening = useContext(ScreenOpeningContext) ?? controller.screenOpening();
  const [locationToOpen] = useState(() =>
    location((controller.options.url ?? "").split("?", 2)[1] ?? ""),
  );
  const [expanded, setExpanded] = useState(
    () => new Set(locationToOpen ? [locationToOpen.path] : []),
  );
  const lastRead = useRef<{ id: string; api: PrApi; data: PrResponse }>(undefined);
  const { id } = issue;
  const { api } = services;
  const { data: result, mutate } = useSWR<PrRead>(
    ["issue-pr", api, id],
    async () => {
      try {
        return { ok: true, data: await api.get(id) };
      } catch (error) {
        const previous = lastRead.current;
        const data = previous?.id === id && previous.api === api ? previous.data : undefined;
        return {
          ok: false,
          data,
          error: {
            message: error instanceof Error ? error.message : "PR を取得できませんでした",
            status: error instanceof ConversationApiError ? error.status : undefined,
          },
        };
      }
    },
    {
      revalidateOnMount: true,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      revalidateOnReconnect: false,
      onSuccess(result) {
        if (result.ok) lastRead.current = { id, api, data: result.data };
      },
    },
  );
  const data = result?.data;
  const error = result?.ok === false ? result.error : undefined;
  const unavailable = error?.status !== undefined && [401, 404, 502].includes(error.status);
  const failure = error?.message ?? null;
  const snapshot = unavailable ? undefined : data;
  const alive = useRef(false);
  const dismiss = useRef<() => void>(undefined);
  const stopDraftTracking = useRef<() => void>(undefined);
  const placed = useRef(false);
  const current = () => alive.current && opening === controller.screenOpening();
  const conversationId = snapshot?.implConversationId;
  const stock = conversationId ? services.stock?.session(conversationId) : undefined;
  const publishable = canPublish(snapshot);
  const marks = useMemo(() => stock?.bufferMarks(prQuoteSources), [stock]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      dismiss.current?.();
      stopDraftTracking.current?.();
    };
  }, []);
  const polling = snapshot !== undefined && runningChecks(snapshot.checks);
  const { schedule } = services;
  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    let cancel: (() => void) | undefined;
    const again = () => {
      cancel = schedule(() => {
        if (stopped || opening !== controller.screenOpening()) return;
        void mutate().finally(() => {
          if (!stopped) again();
        });
      }, 30_000);
    };
    again();
    return () => {
      stopped = true;
      cancel?.();
    };
  }, [controller, mutate, opening, polling, schedule]);
  useEffect(
    () =>
      subscribe(`issue:${issue.id}`, () => {
        void mutate();
      }),
    [issue.id, mutate, subscribe],
  );
  useEffect(() => {
    if (!conversationId || opening !== controller.screenOpening()) return;
    return services.stock?.enterReview(
      {
        id: conversationId,
        issueId: issue.id,
        cwd: project.path,
        title: `#${issue.number} の実装`,
      },
      {
        issueId: issue.id,
        view: prView,
        sources: prQuoteSources,
        showSentInstructions: true,
        ...(publishable && {
          publish: async (ids) =>
            alive.current && opening === controller.screenOpening()
              ? services.api.publish(issue.id, ids)
              : undefined,
        }),
      },
    );
  }, [
    controller,
    conversationId,
    issue.id,
    issue.number,
    opening,
    project.path,
    publishable,
    services,
  ]);

  useEffect(() => {
    const change = (open: boolean, line: number) => {
      const row: PrLine | undefined = controller.windowLines("main")[line];
      if (row?.diffPath) setFileExpanded(row.diffPath, open);
    };
    const remove = [
      controller.registerActionInterceptor(conversationActions.expandDiff.name, {
        views: [prView],
        run: ({ line }) => {
          change(true, line);
          return true;
        },
      }),
      controller.registerActionInterceptor(conversationActions.collapseDiff.name, {
        views: [prView],
        run: ({ line }) => {
          change(false, line);
          return true;
        },
      }),
    ];
    return () => remove.forEach((unregister) => unregister());
  }, [controller]);

  function setFileExpanded(path: string, expand: boolean) {
    setExpanded((old) => {
      if (old.has(path) === expand) return old;
      const next = new Set(old);
      if (expand) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  const reload = async () => {
    if (current()) await mutate();
  };
  const allow = (snapshot: PrResponse) => {
    const head = snapshot.pr?.headSha ?? snapshot.local?.headSha;
    if (!head || !current()) return;
    const state = stock?.snapshot();
    const count =
      state?.loaded.stock && !state.errors.stock
        ? state.items.filter((item) => item.state === "stocked" && item.kind === "instruction")
            .length
        : snapshot.unsentInstructionCount;
    dismiss.current = controller.confirm(
      mergePrompt(count),
      controller.context("main"),
      async () => {
        if (!current()) return;
        await services.api.allowMerge(issue.id, head);
        if (!current()) return;
        controller.notify("merge を許可しました");
      },
    );
  };
  const instruct = async () => {
    if (!conversationId || !current()) return;
    const interaction = controller.interactionRevision();
    const stillOpening = () => current() && interaction === controller.interactionRevision();
    const stop = services.watchDraft(conversationId, stillOpening);
    stopDraftTracking.current?.();
    stopDraftTracking.current = stop;
    try {
      const [session] = await Promise.all([
        loadConversation(conversationId, stillOpening),
        stock?.load("stock"),
      ]);
      if (!stillOpening()) return;
      await session.settleRefresh(stillOpening);
      if (!stillOpening()) return;
      const list = stock?.snapshot();
      if (list?.errors.stock) throw new Error(list.errors.stock);
      const ids =
        list?.items
          .filter((item) => item.kind === "instruction" && item.state === "stocked")
          .map((item) => item.id) ?? [];
      if (session.openReviewPrompt(ids)) stopDraftTracking.current = services.trackDraft(session);
    } catch (error) {
      if (stillOpening()) throw error;
    } finally {
      stop();
      if (stopDraftTracking.current === stop) stopDraftTracking.current = undefined;
    }
  };

  const lines: PrLine[] = snapshot
    ? prLines(
        {
          ...snapshot,
          fetchError: failure ?? snapshot.fetchError,
          waitingMergeConfirm: snapshot.waitingMergeConfirm && awaitingMerge(issue),
        },
        {
          github: project.usesGithub,
          merged: issue.state === "done",
          expanded,
          expand: (path) => setFileExpanded(path, true),
          allowMerge: () => allow(snapshot),
          instruct,
          reload,
          openExternal: services.openExternal,
        },
      )
    : failure
      ? prUnavailableLines(failure, reload, project.usesGithub)
      : loading;
  const startLine = locationToOpen
    ? lines.findIndex(
        ({ diff }) =>
          diff?.path === locationToOpen.path &&
          diff.position.line === locationToOpen.line &&
          diff.position.side === locationToOpen.side,
      )
    : -1;
  useEffect(() => {
    if (placed.current || startLine < 0 || !locationToOpen) return;
    placed.current = true;
    controller.place("main", startLine, locationToOpen.col);
  }, [controller, locationToOpen, startLine]);

  return (
    <Frame title={title} side="main">
      {tabs}
      <FileBuffer
        key={stock?.id ?? "no-stock"}
        lines={lines}
        columns={columns}
        display={prImageDisplay}
        marks={marks}
        posKey={positionKey}
        startLine={startLine >= 0 ? startLine : undefined}
        ready={Boolean(data || error)}
        viewName={prView}
      />
    </Frame>
  );
}
