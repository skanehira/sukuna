export type ClipboardContent = { images: File[]; text: string };
export type ClipboardPort = {
  secure: boolean;
  mac?: boolean;
  write(text: string): Promise<void>;
  read?(): Promise<ClipboardContent>;
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
    mac: navigator.platform.startsWith("Mac"),
    notify,
    write: (text) => navigator.clipboard.writeText(text),
    async read() {
      const content: ClipboardContent = { images: [], text: "" };
      for (const item of await navigator.clipboard.read())
        for (const type of item.types) {
          const blob = await item.getType(type);
          if (type.startsWith("image/"))
            content.images.push(new File([blob], `clipboard.${type.slice(6)}`, { type }));
          else if (type === "text/plain" && !content.text) content.text = await blob.text();
        }
      return content;
    },
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
export async function pasteClipboard(
  port: ClipboardPort,
  target: {
    paste?(images: File[]): void;
    insert(text: string): void;
    notify(message: string, kind?: "error" | "info"): void;
  },
): Promise<void> {
  if (!port.secure || !port.read) {
    target.notify("このページではクリップボードを読めません。Cmd+V で貼り付けてください", "error");
    return;
  }
  let content: ClipboardContent;
  try {
    content = await port.read();
  } catch {
    target.notify(
      "クリップボードを読めませんでした。ブラウザで、このページにクリップボードの読み取りを許可してください",
      "error",
    );
    return;
  }
  if (content.images.length && target.paste) target.paste(content.images);
  else if (content.text) target.insert(content.text);
  else if (content.images.length) target.notify("この入力欄には画像を添えられません");
  else target.notify("クリップボードに貼り付けられるものがありません");
}
