import { z } from "zod";

const totals = z.object({
  tokens5h: z.number(),
  tokens7d: z.number(),
  costUsd7d: z.number(),
});
export const rateLimitReadingSchema = z.object({
  status: z.enum(["allowed", "allowed_warning", "rejected"]),
  resetsAt: z.number().nullable(),
  overageStatus: z.string().nullable(),
  observedAt: z.number(),
});
export const usageResponseSchema = z.object({
  rateLimit: rateLimitReadingSchema
    .omit({ overageStatus: true })
    .extend({
      usingOverage: z.boolean(),
    })
    .nullable(),
  now: z.number(),
  projects: z.array(
    z.object({
      projectId: z.string(),
      name: z.string(),
      total: totals,
      issues: z.array(
        totals.extend({ issueId: z.string(), number: z.number(), title: z.string() }),
      ),
      withoutIssue: totals,
    }),
  ),
});
export type UsageReport = z.infer<typeof usageResponseSchema>;
export type UsageTotals = z.infer<typeof totals>;
export type UsageRateLimit = NonNullable<UsageReport["rateLimit"]>;
