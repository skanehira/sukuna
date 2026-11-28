export type CompletionCandidate = { text: string; label: string; strong: boolean };
export type CompletionResult = {
  candidates: CompletionCandidate[];
  truncated: boolean;
  note: string | null;
};
export type CompletionPanel =
  | { kind: "candidates"; shown: CompletionCandidate[]; more: string | null }
  | { kind: "note"; text: string };

const shownLimit = 30;

function commonPrefix(texts: string[]): string {
  const [first = [], ...rest] = texts.map((text) => Array.from(text));
  let length = first.length;
  for (const characters of rest) {
    let index = 0;
    while (index < length && characters[index] === first[index]) index += 1;
    length = index;
  }
  return first.slice(0, length).join("");
}

export function completeText(text: string, result: CompletionResult): string {
  const { candidates, truncated } = result;
  if (candidates.length === 1) return candidates[0].text;
  if (candidates.length === 0 || truncated) return text;
  const prefix = commonPrefix(candidates.map((candidate) => candidate.text));
  return prefix.length > text.length ? prefix : text;
}

export function completionPanel(result: CompletionResult): CompletionPanel | null {
  const { candidates, truncated, note } = result;
  if (candidates.length === 0) return note === null ? null : { kind: "note", text: note };
  if (candidates.length === 1) return null;
  const hidden = candidates.length - shownLimit;
  return {
    kind: "candidates",
    shown: candidates.slice(0, shownLimit),
    more:
      hidden > 0 || truncated ? `…ほか ${Math.max(hidden, 0)} 件${truncated ? "以上" : ""}` : null,
  };
}

export function createCompletionGate() {
  let waiting: object | null = null;
  return {
    start(): object | undefined {
      if (waiting) return undefined;
      waiting = {};
      return waiting;
    },
    finish(ticket: object): boolean {
      if (waiting !== ticket) return false;
      waiting = null;
      return true;
    },
    cancel(): void {
      waiting = null;
    },
  };
}
