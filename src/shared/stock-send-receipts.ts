import { and, eq, sql } from "drizzle-orm";
import type { OpenedDatabase } from "./db/open";
import { settings } from "./db/schema";
import type { StockSendResponse } from "./stock";

type Storage = Pick<OpenedDatabase["db"], "select" | "insert" | "update" | "delete" | "get">;
type QuestionResult = StockSendResponse["questions"][number];
type InstructionReceipt = {
  instructions: StockSendResponse["instructions"];
  closedAt: number | null;
};
type Plan = {
  conversationId: string;
  cancelled: boolean;
  expiresAt: number;
};
type Outcome = (
  | { kind: "instructions"; accepted: InstructionReceipt }
  | { kind: "question"; accepted: QuestionResult }
) & { expiresAt: number };

const scope = "runner-stock-send:";
const retainForMs = 60_000;

export function stockSendReceipt(db: Storage, attemptId: string, conversationId: string) {
  const key = scope + attemptId;
  const outcomePrefix = key + ":outcome:";
  const questionKey = key + ":questions";
  const now = sql`unixepoch('subsec') * 1000`;
  const prune = () =>
    db
      .delete(settings)
      .where(
        and(
          sql`${settings.key} GLOB ${scope + "*"}`,
          sql`json_extract(${settings.value}, '$.expiresAt') <= ${now}`,
        ),
      )
      .run();
  const expiresAt = () =>
    db.get<{ expiresAt: number }>(sql`SELECT ${now} + ${retainForMs} AS expiresAt`)!.expiresAt;
  const plan = () =>
    db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get()
      ?.value as Plan | undefined;
  const insertPlan = (planExpiresAt: number, cancelled: boolean) =>
    db
      .insert(settings)
      .values({
        key,
        value: { conversationId, cancelled, expiresAt: planExpiresAt } satisfies Plan,
      })
      .onConflictDoNothing()
      .run().changes === 1;
  const isActive = () => {
    const value = plan();
    return value?.conversationId === conversationId && !value.cancelled;
  };
  const record = (
    suffix: string,
    value:
      | Omit<Extract<Outcome, { kind: "instructions" }>, "expiresAt">
      | Omit<Extract<Outcome, { kind: "question" }>, "expiresAt">,
  ) => {
    const active = plan();
    if (active?.conversationId !== conversationId || active.cancelled)
      throw new Error("ストック送信の受付が終わりました。");
    db.insert(settings)
      .values({
        key: outcomePrefix + suffix,
        value: { ...value, expiresAt: active.expiresAt } satisfies Outcome,
      })
      .run();
  };

  return {
    start(questionIds: string[]) {
      prune();
      const planExpiresAt = expiresAt();
      if (!insertPlan(planExpiresAt, false)) return false;
      db.insert(settings)
        .values({
          key: questionKey,
          value: { questionIds, expiresAt: planExpiresAt },
        })
        .run();
      return true;
    },
    isActive,
    instructions(instructions: StockSendResponse["instructions"], closedAt: number | null) {
      record("instructions", { kind: "instructions", accepted: { instructions, closedAt } });
    },
    question(accepted: QuestionResult) {
      record("question:" + accepted.stockId, { kind: "question", accepted });
    },
    settle(cancel: boolean, missingQuestion: (stockId: string) => QuestionResult) {
      const savedPlan = plan();
      if (!savedPlan) {
        if (cancel) {
          prune();
          insertPlan(expiresAt(), true);
        }
        return null;
      }
      if (savedPlan.conversationId !== conversationId) return null;
      if (cancel && !savedPlan.cancelled)
        db.update(settings)
          .set({ value: { ...savedPlan, cancelled: true } })
          .where(eq(settings.key, key))
          .run();
      const results = db
        .select({ value: settings.value })
        .from(settings)
        .where(sql`${settings.key} GLOB ${outcomePrefix + "*"}`)
        .all();
      let instructions: InstructionReceipt = {
        instructions: { count: 0, delivery: null },
        closedAt: null,
      };
      const questions = new Map<string, QuestionResult>();
      for (const { value } of results) {
        const result = value as Outcome;
        if (result.kind === "instructions") instructions = result.accepted;
        else questions.set(result.accepted.stockId, result.accepted);
      }
      if (
        instructions.instructions.count === 0 &&
        ![...questions.values()].some((entry) => entry.ok)
      )
        return null;
      const savedQuestions = db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, questionKey))
        .get()?.value as { questionIds: string[] };
      return {
        closedAt: instructions.closedAt,
        response: {
          instructions: instructions.instructions,
          questions: savedQuestions.questionIds.map(
            (id) => questions.get(id) ?? missingQuestion(id),
          ),
        } satisfies StockSendResponse,
      };
    },
  };
}

export type StockSendReceipt = ReturnType<typeof stockSendReceipt>;
