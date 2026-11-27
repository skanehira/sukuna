import { err } from "neverthrow";
import {
  missingConversation,
  type ConversationDependencies,
  type ConversationError,
} from "../domain/ports";
export function uploadImage(
  id: string,
  mediaType: string,
  bytes: Uint8Array,
  deps: ConversationDependencies,
) {
  if (!deps.repository.conversation(id)) return err(missingConversation);
  if (
    !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mediaType) ||
    bytes.length > 5 * 1024 * 1024
  )
    return err<never, ConversationError>({
      code: "invalid_input",
      message: "入力を確認してください。",
    });
  const imageId = deps.id();
  return deps.images
    .save(id, imageId, mediaType, bytes)
    .map(() => ({ image: { id: imageId, mediaType, bytes: bytes.length } }));
}
