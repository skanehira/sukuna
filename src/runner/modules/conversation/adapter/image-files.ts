import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { err, ok } from "neverthrow";
import type { ImagePort, ImageReadError } from "../domain/image-port";

const mediaTypes = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
]);
const missing: ImageReadError = {
  code: "invalid_input",
  message: "画像が見つかりません。貼り直してください",
};
export function createImageFiles(homeDir: string): ImagePort {
  const home = realpathSync(homeDir);
  return {
    read(conversationId, imageId) {
      if (!/^[A-Za-z0-9_-]+$/.test(conversationId) || !/^[A-Za-z0-9_-]+$/.test(imageId))
        return err(missing);
      try {
        const directory = join(home, "images", conversationId);
        if (realpathSync(directory) !== directory) return err(missing);
        const prefix = `${imageId}.`;
        const filename = readdirSync(directory)
          .sort()
          .find((name) => name.startsWith(prefix) && mediaTypes.has(name.slice(prefix.length)));
        if (!filename) return err(missing);
        const descriptor = openSync(
          join(directory, filename),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          if (!fstatSync(descriptor).isFile()) return err(missing);
          return ok({
            path: `images/${conversationId}/${filename}`,
            mediaType: mediaTypes.get(filename.slice(prefix.length))!,
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
          return err(missing);
        return err({
          code: "internal",
          message: "画像を読み取れませんでした。もう一度操作してください。",
        });
      }
    },
  };
}
