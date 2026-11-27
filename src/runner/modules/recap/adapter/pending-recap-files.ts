import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { PendingRecaps } from "../domain/pending-recap";

const seq = z.number().int().positive();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const pendingSchema = z.strictObject({
  endSeq: seq,
  turnHash: hash,
  token: z.uuid(),
  summary: z.strictObject({
    title: z.string().nullable(),
    decisions: z.array(
      z.strictObject({
        seq,
        kind: z.enum(["decision", "rejected", "pending"]),
        text: z.string(),
        reason: z.string().nullable(),
      }),
    ),
    changes: z.array(z.tuple([z.string(), z.number().int().nonnegative()])),
    questions: z.array(z.strictObject({ seq, text: z.string() })),
    answered: z.array(z.string()),
  }),
  replacement: z.strictObject({ before: hash.nullable(), after: hash }),
});

export function pendingRecapFiles(home: string): PendingRecaps {
  const directory = join(home, "runner", "recap");
  const path = (id: string) =>
    join(directory, createHash("sha256").update(id).digest("hex") + ".json");
  return {
    read: (id) => {
      try {
        return pendingSchema.parse(JSON.parse(readFileSync(path(id), "utf8")));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
    },
    write: (id, pending) => {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const target = path(id);
      const temporary = target + "." + randomUUID() + ".tmp";
      try {
        writeFileSync(temporary, JSON.stringify(pending), { flag: "wx", mode: 0o600, flush: true });
        renameSync(temporary, target);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    remove: (id) => rmSync(path(id), { force: true }),
  };
}
