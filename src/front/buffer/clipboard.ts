export type ClipboardPort = {
  secure: boolean;
  write(text: string): Promise<void>;
  fallback(text: string): boolean;
  notify(message: string, kind: "error"): void;
};
export async function copyText(text: string, port: ClipboardPort): Promise<void> {
  try {
    if (port.secure) await port.write(text);
    else if (!port.fallback(text)) throw new Error("copy failed");
  } catch {
    port.notify("クリップボードに書けませんでした。Vim のレジスタには入っています", "error");
  }
}
export function browserClipboard(
  document: Document,
  navigator: Navigator,
  secure: boolean,
  notify: ClipboardPort["notify"],
): ClipboardPort {
  return {
    secure,
    notify,
    write: (text) => navigator.clipboard.writeText(text),
    fallback(text) {
      const focused = document.activeElement;
      const input = document.createElement("textarea");
      input.value = text;
      input.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.append(input);
      input.select();
      try {
        return document.execCommand("copy");
      } finally {
        input.remove();
        if (focused instanceof HTMLElement) focused.focus();
      }
    },
  };
}
