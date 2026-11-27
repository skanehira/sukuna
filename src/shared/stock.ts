import { z } from "zod";
import { runStateSchema } from "./events";

export type StockSendInput = {
  kinds: "all" | "questions" | "instructions";
  stockIds?: string[];
};

const textWithin = (min: number, max: number) =>
  z.string().refine((text) => {
    const length = Array.from(text).length;
    return length >= min && length <= max;
  });
export const stockTextSchema = textWithin(1, 10_000);
const mode = z.enum(["char", "line", "block"]);
const base = { mode, text: textWithin(0, 20_000) };
const position = { line: z.number().int().positive(), col: z.number().int().nonnegative() };
const filePosition = z.strictObject(position);
const conversationPosition = z.strictObject({
  ...position,
  line: z.number().int().nonnegative(),
  seq: z.number().int().positive(),
});
const diffPosition = z.strictObject({ ...position, side: z.enum(["old", "new"]) });
export const quoteSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...base,
    kind: z.literal("conversation"),
    start: conversationPosition,
    end: conversationPosition,
  }),
  z.strictObject({
    ...base,
    kind: z.literal("file"),
    path: z.string(),
    start: filePosition,
    end: filePosition,
  }),
  z.strictObject({
    ...base,
    kind: z.literal("design_diff"),
    path: z.string(),
    start: filePosition,
    end: filePosition,
  }),
  z.strictObject({
    ...base,
    kind: z.literal("pr_diff"),
    path: z.string(),
    commit: z.string().regex(/^[a-fA-F0-9]{40}$/),
    start: diffPosition,
    end: diffPosition,
  }),
  z.strictObject({ ...base, kind: z.literal("terminal") }),
]);
export type Quote = z.infer<typeof quoteSchema>;
export const stockStateSchema = z.enum(["stocked", "sent", "cancelled"]);
export type StockState = z.infer<typeof stockStateSchema>;
export const addStockSchema = z.strictObject({
  kind: z.enum(["question", "instruction"]),
  text: stockTextSchema,
  quote: quoteSchema,
});
export type AddStockInput = z.infer<typeof addStockSchema>;
export const patchStockSchema = z.union([
  z.strictObject({ text: stockTextSchema }),
  z.strictObject({ state: z.literal("stocked") }),
]);
export const finishThreadSchema = z.strictObject({ action: z.literal("close") });
export const stockThreadSchema = z.strictObject({
  id: z.string(),
  title: z.string().nullable(),
  runState: runStateSchema,
  closed: z.boolean(),
});
export const stockItemSchema = z.strictObject({
  id: z.string(),
  conversationId: z.string(),
  kind: z.enum(["question", "instruction"]),
  text: z.string(),
  quote: quoteSchema,
  state: stockStateSchema,
  stale: z.boolean(),
  sentAt: z.number().int().nullable(),
  sentSeq: z.number().int().nullable(),
  thread: stockThreadSchema.nullable(),
  githubCommentUrl: z.string().nullable(),
});
export type StockItem = z.infer<typeof stockItemSchema>;
export const stockResponseSchema = z.strictObject({ items: z.array(stockItemSchema) });
export const stockItemResponseSchema = z.strictObject({ item: stockItemSchema });
export const threadSchema = z.strictObject({
  id: z.string(),
  title: z.string().nullable(),
  stockId: z.string(),
  quote: quoteSchema,
  runState: runStateSchema,
  closedAt: z.number().int().nullable(),
  lastActivityAt: z.number().int().nullable(),
});
export type Thread = z.infer<typeof threadSchema>;
export const threadsResponseSchema = z.strictObject({ threads: z.array(threadSchema) });
export const finishThreadResponseSchema = z.strictObject({
  thread: z.strictObject({ id: z.string(), closedAt: z.number().int() }),
});
