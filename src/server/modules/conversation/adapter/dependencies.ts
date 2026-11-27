import {
  constants,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { WORKSPACE_SWITCH_RECEIPT_TTL_MS } from "../../../../shared/ipc";
import { err, ok } from "neverthrow";
import type Database from "better-sqlite3";
import type { RunnerLink } from "../../../runner-link";
import type { ConversationDependencies } from "../domain/ports";
import { createConversationRepository } from "./repository";
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
      exists: (path) => {
        const target = resolve(home, path);
        return target.startsWith(`${home}${sep}`) && existsSync(target);
      },
    },
  };
}
