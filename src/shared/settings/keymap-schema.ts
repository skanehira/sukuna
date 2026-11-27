import { z } from "zod";

const keys = z.string().refine((value) => value.trim().length > 0 && !/[\r\n]/.test(value));

export const keymapEntrySchema = z.strictObject({
  keys,
  context: z.enum(["normal", "visual", "prompt", "terminal"]),
  to: z.union([z.strictObject({ action: z.string().min(1) }), z.strictObject({ keys }), z.null()]),
});

export const keymapInputSchema = z.strictObject({ entries: z.array(keymapEntrySchema) });
export const keymapSchema = keymapInputSchema.extend({ version: z.literal(1) });

export type KeymapEntry = z.infer<typeof keymapEntrySchema>;
export type KeymapConfig = z.infer<typeof keymapSchema>;
