import {
  defaultHighlightStyle,
  LanguageDescription,
  syntaxHighlighting,
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";

export function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

export async function fileSyntax(path: string): Promise<Extension> {
  const { languages } = await import("@codemirror/language-data");
  const language = LanguageDescription.matchFilename(languages, path.split("/").at(-1) ?? "");
  if (!language) return [];
  return [await language.load(), syntaxHighlighting(defaultHighlightStyle)];
}

export function sizeLabel(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / 1024).toFixed(1)} KB`;
}

export function singleLine(text: string): string {
  return text.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}
