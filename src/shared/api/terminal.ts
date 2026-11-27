import { z } from "zod";

const size = {
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(200),
};

const entityId = z.string().min(1);
export const openTerminalSchema = z.object({
  projectId: entityId,
  worktreeId: entityId.nullable(),
  conversationId: entityId.nullable(),
  ...size,
});
export type OpenTerminalInput = z.infer<typeof openTerminalSchema>;

export const terminalOpenedSchema = z.object({
  id: entityId,
  cwd: z.string(),
  label: z.string(),
  conversationId: entityId.nullable(),
  reused: z.boolean(),
});
export type TerminalOpened = z.infer<typeof terminalOpenedSchema>;

export const terminalInputFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string() }),
  z.object({ type: z.literal("resize"), ...size }),
]);

export const terminalOutputFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), data: z.string(), ...size }),
  z.object({ type: z.literal("output"), data: z.string() }),
  z.object({
    type: z.literal("exit"),
    code: z.number().int(),
    signal: z.number().int().nullable(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type TerminalOutputFrame = z.infer<typeof terminalOutputFrameSchema>;

export const TERMINAL_INPUT_BYTES = 64 * 1024;
