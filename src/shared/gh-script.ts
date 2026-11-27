import { z } from "zod";
const responseSchema = z.object({
  stdout: z.string(),
  stderr: z.string().default(""),
  exit_code: z.number().int(),
});
export const ghScriptSchema = z.object({
  responses: z.array(responseSchema.extend({ match: z.string() })),
  fallback: responseSchema,
});
export type GhScript = z.input<typeof ghScriptSchema>;
