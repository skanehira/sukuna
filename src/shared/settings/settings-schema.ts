import { z } from "zod";
import { keymapSchema } from "./keymap-schema";

export const backupStatusSchema = z.object({
  lastAt: z.number().nullable(),
  lastError: z.string().nullable(),
});
const backupItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["daily", "before_restore"]),
  createdAt: z.number(),
  sizeBytes: z.number().int().nonnegative(),
});
export const restoreStatusSchema = z.object({
  backupId: z.string(),
  at: z.number(),
  status: z.enum(["done", "failed"]),
  message: z.string().nullable(),
});
export const settingsSchema = z.object({
  keymap: keymapSchema,
  flowPaused: z.boolean(),
  runningAiCount: z.number().int().nonnegative(),
  backup: backupStatusSchema.extend({
    schedule: z.literal("03:00"),
    items: z.array(backupItemSchema),
  }),
  lastRestore: restoreStatusSchema.nullable(),
  push: z.object({ vapidPublicKey: z.string().nullable() }),
});

export type BackupItem = z.infer<typeof backupItemSchema>;
export type Settings = z.infer<typeof settingsSchema>;
