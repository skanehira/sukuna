import { z } from "zod";
import { backupFileName } from "./backup-paths";

export const restoreBackupIdSchema = z.string().refine((id) => backupFileName(id) !== undefined);
export const restoreIdSchema = z.uuid();
export const restoreGenerationHeader = "X-Sukuna-Restore-Generation";
export const restoreRequestHeader = "X-Sukuna-Restore-Request";
export const restoreGenerationCheckHeader = "If-Sukuna-Restore-Generation";
export const initialRestoreGeneration = "initial";
export const restoreGenerationSchema = z.object({
  id: restoreIdSchema,
  requestId: restoreIdSchema.optional(),
});
export type RestoreGeneration = z.infer<typeof restoreGenerationSchema>;
export const restoreRequestSchema = z.strictObject({
  backupId: restoreBackupIdSchema,
  requestedAt: z.number().int().nonnegative(),
  requestId: restoreIdSchema.optional(),
  workerPid: z.number().int().positive().optional(),
});
export const restoreStatusSchema = z.object({
  backupId: z.string(),
  at: z.number(),
  status: z.enum(["done", "failed"]),
  message: z.string().nullable(),
  requestId: restoreIdSchema.optional(),
});
export const restoreReceiptSchema = restoreStatusSchema.extend({ requestId: restoreIdSchema });
export const restoreAcceptedSchema = z.object({
  restarting: z.literal(true),
  requestId: restoreIdSchema,
});
export const restoreLookupSchema = z.union([
  z.object({ status: z.literal("pending") }),
  restoreReceiptSchema,
]);
export type RestoreRequest = z.infer<typeof restoreRequestSchema>;
export type RestoreStatus = z.infer<typeof restoreStatusSchema>;
export type RestoreLookup = z.infer<typeof restoreLookupSchema>;
