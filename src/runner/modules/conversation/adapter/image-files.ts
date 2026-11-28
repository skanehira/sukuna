import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { err, ok } from "neverthrow";
import type { ImagePort, ImageReadError, ImageWritePort } from "../domain/image-port";

const mediaTypes = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
]);
const extensions = new Map([...mediaTypes].map(([extension, type]) => [type, extension]));
const missing: ImageReadError = {
  code: "invalid_input",
  message: "画像が見つかりません。貼り直してください",
};
export function createImageFiles(homeDir: string): ImagePort & ImageWritePort {
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
    write(conversationId, imageId, mediaType, data) {
      const extension = extensions.get(mediaType);
      if (!extension) return err({ message: `画像の形式が対象外です: ${mediaType}` });
      try {
        const directory = join(home, "images", conversationId);
        mkdirSync(directory, { recursive: true });
        if (realpathSync(directory) !== directory)
          return err({ message: "画像のディレクトリがシンボリックリンクです。" });
        const descriptor = openSync(
          join(directory, `${imageId}.${extension}`),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          writeFileSync(descriptor, data);
        } finally {
          closeSync(descriptor);
        }
        return ok(undefined);
      } catch (error) {
        return err({ message: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}
