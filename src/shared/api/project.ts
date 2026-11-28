import { z } from "zod";

const model = z.enum(["opus", "sonnet", "haiku"]).nullable();
const permissionMode = z.enum(["bypassPermissions", "acceptEdits", "default"]);
const autoStage = z.enum(["triage", "design", "impl"]);

export const projectRegistrationSchema = z.strictObject({
  path: z.string(),
  name: z.string().optional(),
});

const projectSettingsFields = {
  model,
  permissionMode,
  autoStages: z
    .array(autoStage)
    .max(3)
    .refine((stages) => new Set(stages).size === stages.length),
  implConcurrency: z.number().int().min(1).max(20),
  designMergeMode: z.enum(["direct", "pr"]),
  confirmBeforeMergeDefault: z.boolean(),
  flowPaused: z.boolean(),
};

const projectIdentity = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  usesGithub: z.boolean(),
  defaultBranch: z.string(),
});
export const projectRegistrationResponseSchema = z.object({
  project: projectIdentity,
  restored: z.boolean(),
  notes: z.array(z.string()),
});
export const projectSettingsSchema = projectIdentity.extend({
  ...projectSettingsFields,
  globalFlowPaused: z.boolean(),
  stopTargetCount: z.number().int().nonnegative(),
});

export const projectPatchSchema = z
  .strictObject({
    ...projectSettingsFields,
    permissionMode: z
      .enum([
        "bypassPermissions",
        "acceptEdits",
        "default",
        "確認しない",
        "編集だけ確認しない",
        "毎回確認する",
      ])
      .transform((value) => {
        switch (value) {
          case "確認しない":
            return "bypassPermissions";
          case "編集だけ確認しない":
            return "acceptEdits";
          case "毎回確認する":
            return "default";
          default:
            return value;
        }
      }),
    name: z.string(),
    usesGithub: z.boolean(),
    defaultBranch: z
      .string()
      .min(1)
      .refine((branch) => !branch.includes("\0")),
  })
  .partial();

export const projectRemovalResponseSchema = z.object({
  stoppedConversationIds: z.array(z.string()),
});
export type ProjectRegistration = z.infer<typeof projectRegistrationSchema>;
export type ProjectRegistered = z.infer<typeof projectRegistrationResponseSchema>;
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
export type ProjectPatch = z.infer<typeof projectPatchSchema>;

export const pathCandidatesSchema = z.object({
  candidates: z.array(z.object({ name: z.string(), text: z.string(), repository: z.boolean() })),
  truncated: z.boolean(),
  note: z.string().nullable(),
});
export type PathCandidates = z.infer<typeof pathCandidatesSchema>;
