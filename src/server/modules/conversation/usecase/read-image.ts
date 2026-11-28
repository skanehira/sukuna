import { err } from "neverthrow";
import { missingImage, type ConversationDependencies } from "../domain/ports";

const ulid = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export function readImage(id: string, imageId: string, deps: ConversationDependencies) {
  if (!ulid.test(imageId)) return err(missingImage);
  return deps.images.read(id, imageId);
}
