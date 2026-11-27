import { z } from "zod";

export const filesResponseSchema = z.strictObject({
  files: z.array(z.string()),
  truncated: z.boolean(),
  changed: z.array(z.string()),
});
export type FilesResponse = z.infer<typeof filesResponseSchema>;

export const fileContentResponseSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    path: z.string(),
    kind: z.literal("text"),
    size: z.number().int().nonnegative(),
    content: z.string(),
  }),
  z.strictObject({
    path: z.string(),
    kind: z.enum(["too_large", "binary"]),
    size: z.number().int().nonnegative(),
  }),
]);
export type FileContentResponse = z.infer<typeof fileContentResponseSchema>;
export const searchQuerySchema = z.strictObject({
  mode: z.enum(["content", "name"]),
  q: z.string().refine((q) => q.trim().length > 0),
});
export const contentMatchSchema = z.strictObject({
  path: z.string(),
  line: z.number().int().positive(),
  col: z.number().int().nonnegative(),
  text: z.string(),
});
export type ContentMatch = z.infer<typeof contentMatchSchema>;
export const contentSearchResponseSchema = z.strictObject({
  mode: z.literal("content"),
  query: z.string(),
  matches: z.array(contentMatchSchema),
  truncated: z.boolean(),
  timedOut: z.boolean(),
});
export type ContentSearchResponse = z.infer<typeof contentSearchResponseSchema>;
export const nameSearchResponseSchema = z.strictObject({
  mode: z.literal("name"),
  query: z.string(),
  matches: z.array(z.strictObject({ path: z.string() })),
  truncated: z.boolean(),
});
export type NameSearchResponse = z.infer<typeof nameSearchResponseSchema>;
export const changeHunkSchema = z.strictObject({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  lines: z.array(z.string()),
});
export const changesResponseSchema = z.strictObject({
  files: z.array(
    z.strictObject({
      path: z.string(),
      added: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
      changes: z.array(
        z.strictObject({
          seq: z.number().int().positive(),
          createdAt: z.number(),
          change: z.enum(["edit", "create", "update"]),
          hunks: z.array(changeHunkSchema),
          truncated: z.boolean(),
        }),
      ),
    }),
  ),
});
export type ChangesResponse = z.infer<typeof changesResponseSchema>;
