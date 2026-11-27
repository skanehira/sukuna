import { z } from "zod";
import { issueNumberSchema } from "../issue/schema";

export const githubImportInputSchema = z.strictObject({
  numbers: z
    .array(issueNumberSchema)
    .min(1)
    .max(100)
    .transform((numbers) => [...new Set(numbers)]),
});

const candidate = z.object({
  number: issueNumberSchema,
  title: z.string(),
  labels: z.array(z.string()),
  createdAt: z.number(),
  url: z.url(),
});
export type GithubIssueCandidate = z.infer<typeof candidate>;
export const githubIssuesResponseSchema = z.object({
  issues: z.array(candidate.extend({ imported: z.boolean() })),
  truncated: z.boolean(),
});
export const githubImportResponseSchema = z.object({
  imported: z.array(
    z.object({
      githubNumber: issueNumberSchema,
      issueId: z.string(),
      issueNumber: issueNumberSchema,
    }),
  ),
  skipped: z.array(
    z.object({
      githubNumber: issueNumberSchema,
      reason: z.enum(["already_imported", "not_open", "not_found", "too_long"]),
    }),
  ),
});
export type GithubIssuesResponse = z.infer<typeof githubIssuesResponseSchema>;
export type GithubImportResponse = z.infer<typeof githubImportResponseSchema>;
