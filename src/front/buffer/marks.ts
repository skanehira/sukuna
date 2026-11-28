import { StateEffect, StateField } from "@codemirror/state";
import type { LineInfo } from "./line";
import { bufferField } from "./state";

export type BufferMarks = {
  read(lines: readonly LineInfo[]): ReadonlyMap<number, string>;
  subscribe(listener: () => void): () => void;
};

export const refreshMarks = StateEffect.define<null>();

export function markField(marks: BufferMarks) {
  return StateField.define<ReadonlyMap<number, string>>({
    create: (state) => marks.read(state.field(bufferField).lines),
    update: (value, transaction) => {
      const lines = transaction.state.field(bufferField).lines;
      return lines !== transaction.startState.field(bufferField).lines ||
        transaction.effects.some((effect) => effect.is(refreshMarks))
        ? marks.read(lines)
        : value;
    },
  });
}
