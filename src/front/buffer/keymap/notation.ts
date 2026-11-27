const special: Record<string, string> = {
  Space: "Space",
  CR: "Enter",
  Esc: "Esc",
  Tab: "Tab",
  BS: "Backspace",
  Del: "Delete",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  Home: "Home",
  End: "End",
  lt: "<",
};
export function parseKeys(keys: string): string[] | null {
  if (keys.length === 0) return null;
  const tokens: string[] = [];
  for (let index = 0; index < keys.length;) {
    const char = keys[index];
    if (char === "<") {
      const end = keys.indexOf(">", index);
      if (end < 0) return null;
      const body = keys.slice(index + 1, end);
      const match = /^(?:(?:C|A|S|M)-)*(.+)$/.exec(body);
      const base = match?.[1];
      if (!base || (!(base in special) && !/^(?:(?:C|A|S|M)-)+.$/.test(body))) return null;
      tokens.push(keys.slice(index, end + 1));
      index = end + 1;
    } else {
      if (/\s/.test(char) || char === ">") return null;
      tokens.push(char);
      index += 1;
    }
  }
  return tokens;
}
export function normalizeKeys(keys: string): string {
  return (parseKeys(keys) ?? [])
    .map((token) => {
      if (!token.startsWith("<")) return token;
      const parts = token.slice(1, -1).split("-");
      let base = parts.pop()!;
      const modifiers = new Set(parts);
      if (base === "lt") modifiers.delete("S");
      if (base === "[" && modifiers.has("C")) return "<Esc>";
      if (modifiers.has("S") && /^[a-zA-Z]$/.test(base)) {
        base = base.toUpperCase();
        modifiers.delete("S");
      }
      const prefix = ["C", "A", "M", "S"]
        .filter((modifier) => modifiers.has(modifier))
        .map((modifier) => `${modifier}-`)
        .join("");
      return prefix || base.length > 1 ? `<${prefix}${base}>` : base;
    })
    .join("");
}
export function displayKeys(keys: string): string {
  return (parseKeys(keys) ?? [])
    .map((key) => {
      if (!key.startsWith("<")) return key;
      return key
        .slice(1, -1)
        .replace(/C-/g, "Ctrl+")
        .replace(/A-/g, "Alt+")
        .replace(/M-/g, "Command+")
        .replace(/S-/g, "Shift+")
        .replace(/[^+]+$/, (base) => special[base] ?? base);
    })
    .join(" ");
}
export function eventKey(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey">,
): string | null {
  if (["Shift", "Control", "Alt", "Meta", "Dead", "Unidentified"].includes(event.key)) return null;
  if (event.ctrlKey && event.key === "[") return "<Esc>";
  const names: Record<string, string> = {
    " ": "Space",
    "<": "lt",
    Enter: "CR",
    Escape: "Esc",
    Backspace: "BS",
    Delete: "Del",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
  };
  const key = names[event.key] ?? event.key;
  const modifier = `${event.ctrlKey ? "C-" : ""}${event.altKey ? "A-" : ""}${event.metaKey ? "M-" : ""}${event.shiftKey && key.length > 1 ? "S-" : ""}`;
  return normalizeKeys(modifier || key.length > 1 ? `<${modifier}${key}>` : key);
}
