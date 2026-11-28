import type { Result } from "neverthrow";

export type LoadedImage = { path: string; mediaType: string; data: Buffer };
export type ImageReadError = { code: "invalid_input" | "internal"; message: string };
export type ImageWriteError = { message: string };
export interface ImagePort {
  read(conversationId: string, imageId: string): Result<LoadedImage, ImageReadError>;
}
export interface ImageWritePort {
  write(
    conversationId: string,
    imageId: string,
    mediaType: string,
    data: Buffer,
  ): Result<void, ImageWriteError>;
}
