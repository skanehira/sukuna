import { createHash } from "node:crypto";
import { err, ok } from "neverthrow";
import type { RecapState } from "../../../../shared/recap/api";
import type { DecisionFileStore } from "../../../../shared/recap/ports";
import type { Clock } from "../../conversation/domain/clock";
import type { PendingRecaps } from "../domain/pending-recap";
import { saveRecap } from "./save-recap";
import type { RecapConversation, RecapRepository, RecapTurn } from "../domain/repository";
import type { SummarizerPort } from "../domain/summarizer-port";
import { applySummary, turnLines } from "../domain/turn-summary";

type Dependencies = {
  repository: RecapRepository;
  files: DecisionFileStore;
  pending: PendingRecaps;
  summarizer: SummarizerPort;
  clock: Clock;
  id: () => string;
  uuid: () => string;
  changed: (id: string) => void;
  failure: (id: string, error: unknown) => void;
};

type Job = {
  through: number;
  markingFailure: boolean;
  rebuildRequested: boolean;
  wake?: () => void;
  done: Promise<void>;
};
const limitMs = 30_000;
const retryMs = 50;

function isSqliteLock(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return [error, error.cause].some(
    (cause) =>
      cause instanceof Error &&
      "code" in cause &&
      /^SQLITE_(BUSY|LOCKED)(_|$)/.test(String(cause.code)),
  );
}

export class RecapUpdates {
  private jobs = new Map<string, Job>();
  private shutdown = new AbortController();
  private deps: Dependencies;
  constructor(deps: Dependencies) {
    this.deps = deps;
  }

  recover(): void {
    for (const { id, endSeq } of this.deps.repository.unfinished()) this.enqueue(id, endSeq);
  }

  rebuild(id: string) {
    const conversation = this.deps.repository.get(id);
    if (!conversation)
      return err({ code: "not_found" as const, message: "会話が見つかりません。" });
    const last = this.deps.repository.lastTurn(id);
    if (!last || last.seq <= conversation.reflectedSeq)
      return err({
        code: "conflict" as const,
        message: "反映していない番がありません。次の応答を待ってください。",
      });
    this.enqueue(id, last.seq, true);
    const state: RecapState = {
      reflectedSeq: conversation.reflectedSeq,
      failedAt: null,
      updating: true,
    };
    return ok({ state });
  }

  enqueue(id: string, endSeq: number, rebuild = false): void {
    if (this.shutdown.signal.aborted) return;
    const current = this.jobs.get(id);
    if (current) {
      current.through = Math.max(current.through, endSeq);
      if (rebuild && current.markingFailure) current.rebuildRequested = true;
      current.wake?.();
      return;
    }
    const conversation = this.deps.repository.get(id);
    if (!conversation || conversation.reflectedSeq >= endSeq) return;
    const job: Job = {
      through: endSeq,
      markingFailure: false,
      rebuildRequested: false,
      done: Promise.resolve()
        .then(() => this.drain(id, job))
        .catch((error: unknown) => {
          this.deps.failure(id, error);
        }),
    };
    this.jobs.set(id, job);
  }

  async stop(): Promise<void> {
    this.shutdown.abort(new Error("ランナーが終了しました。"));
    const jobs = [...this.jobs.values()];
    for (const job of jobs) job.wake?.();
    await Promise.all(jobs.map(({ done }) => done));
  }

  private async drain(id: string, job: Job): Promise<void> {
    const { repository } = this.deps;
    const owns = () => !this.shutdown.signal.aborted && this.jobs.get(id) === job;
    try {
      while (owns()) {
        job.markingFailure = false;
        job.rebuildRequested = false;
        const conversation = repository.get(id);
        if (!conversation) return;
        const turn = repository.nextTurn(id, conversation.reflectedSeq);
        if (!turn) return;
        if (conversation.failedAt !== null) {
          if (!(await this.writeFailure(conversation, null, job, owns)) || !owns()) continue;
          this.deps.changed(id);
        }
        const requestedThrough = job.through;
        const superseded = () => job.through > requestedThrough || job.rebuildRequested;
        try {
          await this.update(conversation, turn);
        } catch (error) {
          if (!owns()) return;
          this.deps.failure(id, error);
          job.markingFailure = true;
          const marked = await this.writeFailure(
            conversation,
            () => this.deps.clock.now(),
            job,
            () => owns() && !superseded(),
          );
          if (!marked || !owns() || superseded()) continue;
          this.jobs.delete(id);
          this.deps.changed(id);
          return;
        }
        if (owns()) this.deps.changed(id);
      }
    } finally {
      if (this.jobs.get(id) === job) this.jobs.delete(id);
    }
  }

  private async writeFailure(
    conversation: RecapConversation,
    time: (() => number) | null,
    job: Job,
    current: () => boolean,
  ): Promise<boolean> {
    while (current()) {
      try {
        return this.deps.repository.fail(
          conversation.id,
          conversation.reflectedSeq,
          time?.() ?? null,
        );
      } catch (error) {
        if (!isSqliteLock(error)) throw error;
        await new Promise<void>((resolve) => {
          const cancel = this.deps.clock.setTimeout(() => job.wake?.(), retryMs);
          job.wake = () => {
            cancel();
            job.wake = undefined;
            resolve();
          };
        });
      }
    }
    return false;
  }

  private async update(conversation: RecapConversation, turn: RecapTurn): Promise<void> {
    const { pending } = this.deps;
    const { id } = conversation;
    const turnHash = createHash("sha256").update(JSON.stringify(turn.events)).digest("hex");
    const stored = pending.read(id);
    if (stored?.endSeq === turn.endSeq && stored.turnHash === turnHash) {
      saveRecap(this.deps, conversation, turn, stored);
      return;
    }
    const summary = await this.summarize(conversation, turn);
    this.shutdown.signal.throwIfAborted();
    const record = { endSeq: turn.endSeq, turnHash, token: this.deps.uuid(), summary };
    saveRecap(this.deps, conversation, turn, record);
  }

  private async summarize(conversation: RecapConversation, turn: RecapTurn) {
    const { id, path, cwd } = conversation;
    const { repository, files, summarizer } = this.deps;
    const file = files.read(path, id);
    if (file.isErr()) throw new Error(file.error.message);
    const { entries, ...references } = turnLines(turn.events, cwd);
    const input = {
      chapters: repository.chapters(id).map(({ position, title }) => ({ position, title })),
      decisions: file.value.items.map(({ id, kind, text }) => ({ id, kind, text })),
      questions: repository.questions(id),
      entries,
    };
    const deadline = new AbortController();
    const signal = AbortSignal.any([this.shutdown.signal, deadline.signal]);
    const timeout = this.deps.clock.setTimeout(
      () => deadline.abort(new Error("会話の要約が 30 秒以内に終わりませんでした。")),
      limitMs,
    );
    let onAbort = () => {};
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted();
        const output = await Promise.race([summarizer.summarize(input, signal), cancelled]);
        signal.throwIfAborted();
        const summary = applySummary(output, input, { entries, ...references });
        if (summary) return summary;
      }
      throw new Error("会話の要約の形式または参照番号が正しくありません。");
    } finally {
      timeout();
      signal.removeEventListener("abort", onAbort);
    }
  }
}
