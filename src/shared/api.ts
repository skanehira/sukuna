import { z } from "zod";

export function isReadOnlyHttpMethod(method: string): boolean {
  return ["GET", "HEAD", "OPTIONS", "TRACE"].includes(method.toUpperCase());
}

export const healthResponseSchema = z.strictObject({
  status: z.literal("ok"),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const meResponseSchema = z.strictObject({
  login: z.string(),
  device: z.string(),
  build: z.string(),
});

export type MeResponse = z.infer<typeof meResponseSchema>;

export const errorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
