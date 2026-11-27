import { z } from "zod";
const seq = z.number().int().nonnegative();
const content = z
  .string()
  .refine((value) => value.trim().length > 0 && Array.from(value).length <= 200);
export const decisionItemSchema = z.strictObject({
  id: z.string().regex(/^D[1-9]\d*$/),
  kind: z.enum(["decision", "rejected", "pending"]),
  text: content,
  reason: z
    .string()
    .refine((value) => Array.from(value).length <= 200)
    .nullable(),
  seq: seq.nullable(),
  changedTo: z
    .string()
    .regex(/^D[1-9]\d*$/)
    .nullable(),
});
export const recapStateSchema = z.strictObject({
  reflectedSeq: seq,
  failedAt: z.number().nullable(),
  updating: z.boolean(),
});
export type RecapState = z.infer<typeof recapStateSchema>;
export const saveReadSchema = z.strictObject({ readSeq: seq.optional(), position: seq.optional() });
export const patchTocSchema = z
  .strictObject({
    title: z
      .string()
      .refine((value) => value.trim().length > 0 && Array.from(value).length <= 60)
      .optional(),
    startSeq: seq.optional(),
    base: z.strictObject({ title: z.string(), startSeq: seq }),
  })
  .refine((value) => value.title !== undefined || value.startSeq !== undefined);
export const putDecisionsSchema = z
  .strictObject({
    baseHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    items: z.array(decisionItemSchema),
  })
  .superRefine((value, context) => {
    const ids = new Set(value.items.map((item) => item.id));
    if (
      ids.size !== value.items.length ||
      value.items.some((item) => item.changedTo !== null && !ids.has(item.changedTo))
    )
      context.addIssue({ code: "custom", message: "項目の番号または変わった先が不正です。" });
  });
export const recapResponseSchema = z.strictObject({
  lastUserMessage: z.strictObject({ seq, text: z.string() }).nullable(),
  questions: z.array(
    z.strictObject({ id: z.string(), seq, kind: z.enum(["choice", "text"]), text: z.string() }),
  ),
  pendingPermission: z
    .strictObject({ requestId: z.string(), seq, toolName: z.string(), summary: z.string() })
    .nullable(),
  draft: z.strictObject({ exists: z.boolean() }),
  counts: z.strictObject({ stock: seq, threads: seq, activeThreads: seq, queue: seq }),
  lastReadSeq: seq,
  lastPosition: seq.nullable(),
  state: recapStateSchema,
});
export type RecapResponse = z.infer<typeof recapResponseSchema>;
export const tocResponseSchema = z.strictObject({
  chapters: z.array(
    z.strictObject({
      position: z.number().int().positive(),
      title: z.string(),
      startSeq: seq,
      endSeq: seq.nullable(),
      decisions: z.array(z.strictObject({ id: z.string(), text: z.string() })),
    }),
  ),
  state: recapStateSchema,
});
export type TocResponse = z.infer<typeof tocResponseSchema>;
export const decisionsResponseSchema = z.strictObject({
  path: z.string(),
  exists: z.boolean(),
  hash: z.string().nullable(),
  items: z.array(decisionItemSchema),
  state: recapStateSchema,
});
export type DecisionsResponse = z.infer<typeof decisionsResponseSchema>;
