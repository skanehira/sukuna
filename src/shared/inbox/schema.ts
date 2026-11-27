import { z } from "zod";
import { issueStateSchema, issueStopReasonSchema } from "../issue/state";
import { progressResponseSchema } from "../progress/schema";

export const sectionNames = ["decision", "instruction", "working"] as const;
export const reasonSchema = z.enum([
  "working",
  "question",
  "permission",
  "failed",
  "usage_limited",
  "summarizing",
  "turn_ended",
  "stopped_by_user",
  "restarted",
  "thread",
  "design_review",
  "flow_waiting",
  "usage_limit",
  "ci_failed",
  "merge_confirm",
  "dependency_withdrawn",
]);
const projectSchema = z.strictObject({ id: z.string(), name: z.string() });
export const inboxRowSchema = z.strictObject({
  key: z.string(),
  kind: z.enum(["issue", "conversation"]),
  id: z.string(),
  project: projectSchema,
  title: z.string(),
  section: z.enum(sectionNames),
  reason: reasonSchema,
  status: z.string(),
  notice: z.string(),
  unread: z.boolean(),
  priority: z.enum(["high", "medium", "low"]).nullable(),
  lastActivityAt: z.number(),
  threadAnswers: z.number(),
  activity: progressResponseSchema.shape.activity,
  issue: z
    .strictObject({
      number: z.number(),
      state: issueStateSchema,
      stopReason: issueStopReasonSchema.nullable(),
    })
    .nullable(),
});
export const inboxResponseSchema = z.strictObject({
  sections: z.array(z.strictObject({ name: z.enum(sectionNames), rows: z.array(inboxRowSchema) })),
});
export const projectsResponseSchema = z.strictObject({
  projects: z.array(
    projectSchema.extend({
      flowPaused: z.boolean(),
      conversations: z.array(z.strictObject({ id: z.string(), title: z.string() })),
      issues: z.array(
        z.strictObject({
          id: z.string(),
          number: z.number(),
          title: z.string(),
          state: issueStateSchema,
        }),
      ),
    }),
  ),
});
const overviewRowSchema = z.strictObject({
  key: z.string(),
  id: z.string(),
  title: z.string(),
  status: z.string(),
  lastActivityAt: z.number(),
  unread: z.boolean(),
  activity: progressResponseSchema.shape.activity,
});
export const overviewResponseSchema = z.strictObject({
  project: projectSchema.extend({ flowPaused: z.boolean() }),
  issueSections: z.array(
    z.strictObject({
      state: issueStateSchema,
      total: z.number(),
      rows: z.array(overviewRowSchema.extend({ number: z.number() })),
    }),
  ),
  conversations: z.array(overviewRowSchema),
});
export type InboxRow = z.infer<typeof inboxRowSchema>;
export type InboxResponse = z.infer<typeof inboxResponseSchema>;
export type ProjectsResponse = z.infer<typeof projectsResponseSchema>;
export type OverviewResponse = z.infer<typeof overviewResponseSchema>;
export type RowPlacement = Pick<InboxRow, "section" | "reason">;
