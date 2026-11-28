import type { FlowEvent } from "./evaluate";
import { stateChange } from "./evaluate";
import type { StageSnapshot } from "./stage-ports";

export function issueHistoryPoint(events: readonly FlowEvent[]) {
  return events.findLast((event) => event.type === "state_changed")?.seq ?? 0;
}

export function implementationOrigin(events: readonly FlowEvent[]) {
  return events.findLast((event) => {
    const change = stateChange(event);
    return (
      change?.to === "implementing" &&
      (change.cause === "impl_started" || change.cause === "reopened_for_fix")
    );
  });
}

export function implementationState(record: StageSnapshot) {
  return (
    record.issue.state === "implementing" ||
    (record.issue.state === "stopped" &&
      record.context.stoppedFrom === "implementing" &&
      record.context.stoppedCause === "worktree_failed")
  );
}

export function implementationReady(events: readonly FlowEvent[]) {
  const origin = implementationReviewBoundary(events);
  return events.findLast((event) => event.seq > origin && event.type === "ready_for_merge");
}

function implementationReviewBoundary(events: readonly FlowEvent[]) {
  return Math.max(
    implementationOrigin(events)?.seq ?? 0,
    events.findLast((event) => stateChange(event)?.cause === "impl_instruction")?.seq ?? 0,
  );
}

export function implementationRevision(events: readonly FlowEvent[], conversationId: string) {
  const origin = implementationOrigin(events)?.seq ?? 0;
  const event = events.findLast(
    ({ type, seq }) => type === "implementation_revision_requested" && seq > origin,
  );
  const revision = event?.payload as
    | {
        conversationId: string;
        afterTurnSeq: number;
        queuedIds: string[];
      }
    | undefined;
  return revision?.conversationId === conversationId ? revision : undefined;
}

export function pendingImplementationFix(events: readonly FlowEvent[]) {
  const origin = implementationOrigin(events);
  if (!origin || stateChange(origin)?.cause !== "reopened_for_fix") return;
  const reopened = events.findLast(
    (event) => event.type === "reopened_for_fix" && event.seq > origin.seq,
  );
  if (!reopened || events.some((event) => event.type === "ai_started" && event.seq > reopened.seq))
    return;
  const url = (reopened.payload as { previousPrUrl?: string | null }).previousPrUrl;
  return { seq: reopened.seq, previousPrUrl: url ?? null };
}

export function implementationFixInstruction({ previousPrUrl }: { previousPrUrl: string | null }) {
  return previousPrUrl
    ? `この issue の PR ${previousPrUrl} は merge 済みです。既定ブランチの最新から作った worktree で、新しい PR を作って次の点を直してください`
    : "この issue の変更は既定ブランチに入っています。既定ブランチの最新から作った worktree で、次の点を直してください";
}

export function implementationPrUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = URL.parse(value);
  if (
    url?.protocol !== "https:" ||
    url.host !== "github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return null;
  const match = /^\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)$/i.exec(url.pathname);
  return match ? `https://github.com/${match[1]!.toLowerCase()}/pull/${match[2]}` : null;
}

export function completedPr(events: readonly FlowEvent[], url: string) {
  const normalized = implementationPrUrl(url);
  return (
    normalized !== null &&
    events.some(
      (event) =>
        event.type === "implementation_done" &&
        implementationPrUrl((event.payload as { prUrl?: string }).prUrl) === normalized,
    )
  );
}

export function readyDetails(event: FlowEvent | undefined) {
  if (event?.type !== "ready_for_merge" || !event.payload || typeof event.payload !== "object")
    return;
  const value = event.payload as {
    prUrl?: unknown;
    headSha?: unknown;
    comparisonBase?: unknown;
    worktreeId?: unknown;
    approvedReadySeq?: unknown;
  };
  if (typeof value.headSha !== "string" || typeof value.worktreeId !== "string") return;
  return {
    prUrl: value.prUrl === null ? null : implementationPrUrl(value.prUrl),
    head: value.headSha.toLowerCase(),
    comparisonBase:
      typeof value.comparisonBase === "string" && /^[0-9a-f]{40}$/.test(value.comparisonBase)
        ? value.comparisonBase
        : null,
    worktreeId: value.worktreeId,
    approvedReadySeq:
      typeof value.approvedReadySeq === "number" ? value.approvedReadySeq : undefined,
  };
}

export function implementationApproval(events: readonly FlowEvent[], ready: FlowEvent | undefined) {
  const details = readyDetails(ready);
  if (!ready || !details) return;
  const attempt = implementationReviewBoundary(events);
  const approved =
    details.approvedReadySeq === undefined
      ? ready
      : events.find((event) => event.seq === details.approvedReadySeq && event.seq < ready.seq);
  const original = readyDetails(approved);
  if (
    !approved ||
    approved.seq <= attempt ||
    !original ||
    original.worktreeId !== details.worktreeId ||
    original.prUrl !== details.prUrl
  )
    return;
  const nextReady = events.find(
    (event) => event.type === "ready_for_merge" && event.seq > approved.seq,
  );
  const grant = events.find((event) => {
    const approval = event.payload as { headSha?: string; readySeq?: number };
    return (
      event.type === "merge_allowed" &&
      event.seq > approved.seq &&
      (!nextReady || event.seq < nextReady.seq) &&
      approval.headSha?.toLowerCase() === original.head &&
      (approval.readySeq === undefined || approval.readySeq === approved.seq)
    );
  });
  return grant ? approved.seq : undefined;
}
