import {
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { WORKSPACE_SWITCH_RECEIPT_TTL_MS } from "../../../../shared/ipc";
import { err, ok } from "neverthrow";
import type Database from "better-sqlite3";
import type { RunnerLink } from "../../../runner-link";
import { missingImage, type ConversationDependencies } from "../domain/ports";
import { createConversationRepository } from "./repository";
const imageTypes = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
]);
export function createConversationDependencies(options: {
  sqlite: Database.Database;
  home: string;
  runner: Pick<RunnerLink, "call">;
  id: () => string;
  now: () => number;
  changed: ConversationDependencies["changed"];
  reopened: ConversationDependencies["reopened"];
  notice?: ConversationDependencies["notice"];
}): ConversationDependencies {
  const home = realpathSync(options.home);
  return {
    repository: createConversationRepository(options.sqlite),
    runner: options.runner,
    id: options.id,
    workspaceSwitchAttempt: () => ({
      id: randomUUID(),
      expires_at: options.now() + WORKSPACE_SWITCH_RECEIPT_TTL_MS,
    }),
    now: options.now,
    changed: options.changed,
    reopened: options.reopened,
    notice: options.notice,
    images: {
      save: (conversationId, imageId, mediaType, data) => {
        try {
          const directory = join(home, "images", conversationId);
          mkdirSync(directory, { recursive: true });
          if (realpathSync(directory) !== directory)
            return err({
              code: "invalid_input",
              message: "画像を保存できません。貼り直してください。",
            });
          const extension = {
            "image/png": "png",
            "image/jpeg": "jpg",
            "image/gif": "gif",
            "image/webp": "webp",
          }[mediaType];
          const fd = openSync(
            join(directory, `${imageId}.${extension}`),
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          );
          try {
            writeFileSync(fd, data);
          } finally {
            closeSync(fd);
          }
          return ok(undefined);
        } catch {
          return err({
            code: "internal",
            message: "画像を保存できませんでした。もう一度貼り付けてください。",
          });
        }
      },
      read: (conversationId, imageId) => {
        try {
          const directory = join(home, "images", conversationId);
          if (realpathSync(directory) !== directory) return err(missingImage);
          const prefix = `${imageId}.`;
          const name = readdirSync(directory)
            .sort()
            .find((file) => file.startsWith(prefix) && imageTypes.has(file.slice(prefix.length)));
          if (!name) return err(missingImage);
          const descriptor = openSync(
            join(directory, name),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            if (!fstatSync(descriptor).isFile()) return err(missingImage);
            return ok({
              mediaType: imageTypes.get(name.slice(prefix.length))!,
              data: readFileSync(descriptor),
            });
          } finally {
            closeSync(descriptor);
          }
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(error.code))
          )
            return err(missingImage);
          return err({
            code: "internal",
            message: "画像を読み取れませんでした。もう一度操作してください。",
          });
        }
      },
      exists: (path) => {
        const target = resolve(home, path);
        return target.startsWith(`${home}${sep}`) && existsSync(target);
      },
    },
  };
}
