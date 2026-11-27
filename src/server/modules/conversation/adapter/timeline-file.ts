import { open } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import { timelineFileSchema, type TimelineFile } from "../../../../shared/progress/schema";
import type { TimelineFilePort } from "../domain/timeline/file-port";

const LIMIT = 4 * 1024 * 1024;
const SHAPE_ERROR = "タイムラインのファイルの形式が正しくありません。";
const SIZE_ERROR = "タイムラインのファイルが 4 MiB を超えています。";
type ReadFailure = "missing" | "shape" | "size" | "io";

export function timelineFilePath(configDir: string, sessionId: string): string | null {
  return /^[A-Za-z0-9_-]+$/.test(sessionId)
    ? join(configDir, "timeline", "sessions", `${sessionId}.json`)
    : null;
}

export function createTimelineFilePort(options: {
  configDir: string;
  sleep(milliseconds: number): Promise<void>;
}): TimelineFilePort {
  const cache = new Map<string, TimelineFile>();
  return {
    async read(sessionId) {
      const path = timelineFilePath(options.configDir, sessionId);
      if (path === null)
        return { file: null, readError: "タイムラインの session id が正しくありません。" };
      let read = await readFile(path);
      if (read.isErr() && read.error === "shape") {
        await options.sleep(200);
        read = await readFile(path);
      }
      if (read.isOk()) {
        cache.set(sessionId, read.value);
        return { file: read.value, readError: null };
      }
      if (read.error === "missing") {
        cache.delete(sessionId);
        return { file: null, readError: null };
      }
      return {
        file: cache.get(sessionId) ?? null,
        readError:
          read.error === "shape"
            ? SHAPE_ERROR
            : read.error === "size"
              ? SIZE_ERROR
              : "タイムラインのファイルを読めませんでした。",
      };
    },
  };
}

async function readFile(path: string): Promise<Result<TimelineFile, ReadFailure>> {
  const read = await ResultAsync.fromPromise(readBounded(path), (error) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
      ? ("missing" as const)
      : ("io" as const),
  );
  if (read.isErr()) return err(read.error);
  if (read.value.length > LIMIT) return err("size");
  const parsed = ResultAsync.fromPromise(
    Promise.resolve().then(() => JSON.parse(read.value.toString("utf8")) as unknown),
    () => "shape" as const,
  );
  const value = await parsed;
  if (value.isErr()) return err(value.error);
  const shaped = timelineFileSchema.safeParse(value.value);
  return shaped.success ? ok(shaped.data) : err("shape");
}

async function readBounded(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(LIMIT + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return buffer.subarray(0, total);
  } finally {
    await file.close();
  }
}
