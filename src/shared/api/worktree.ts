import { z } from "zod";
import { issueStateSchema } from "../issue/state";

export const createWorktreeSchema = z.object({ name: z.string() });
export const worktreeItemSchema = z.object({
  id: z.string().nullable(),
  name: z.string(),
  path: z.string(),
  branch: z.string().nullable(),
  origin: z.enum(["main", "user", "flow"]),
  issue: z
    .object({
      id: z.string(),
      number: z.number().int(),
      title: z.string(),
      state: issueStateSchema,
    })
    .nullable(),
  conversations: z.array(
    z.object({
      id: z.string(),
      title: z.string().nullable(),
      runState: z.enum([
        "idle",
        "working",
        "waiting_answer",
        "waiting_permission",
        "stopped",
        "failed",
        "usage_limited",
      ]),
    }),
  ),
  uncommittedCount: z.number().int().nonnegative(),
  uncommittedSample: z.array(z.string()).max(5),
  unpushedCount: z.number().int().nonnegative(),
  locked: z.string().nullable(),
  missing: z.boolean(),
  terminalId: z.string().nullable(),
});
export const worktreeListSchema = z.object({ worktrees: z.array(worktreeItemSchema) });
export const worktreeCreatedSchema = worktreeItemSchema.extend({ notice: z.string().nullable() });
export const worktreeRemovedSchema = z.object({
  removedBranch: z.boolean(),
  movedConversationIds: z.array(z.string()),
});
export type WorktreeItem = z.infer<typeof worktreeItemSchema>;
