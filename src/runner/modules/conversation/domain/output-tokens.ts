export type OutputTokens = {
  finished: number;
  characters: number;
  confirmed: number | null;
};
export type CountedOutput =
  | { kind: "message_start" }
  | { kind: "text_delta"; text: string }
  | { kind: "output_chars"; characters: number }
  | { kind: "message_usage"; outputTokens: number };

export const emptyOutputTokens: OutputTokens = { finished: 0, characters: 0, confirmed: null };

export function countOutputTokens(state: OutputTokens, output: CountedOutput): OutputTokens {
  if (output.kind === "message_start")
    return { finished: outputTokenTotal(state), characters: 0, confirmed: null };
  if (output.kind === "message_usage") return { ...state, confirmed: output.outputTokens };
  const characters =
    output.kind === "text_delta" ? Array.from(output.text).length : output.characters;
  return { ...state, characters: state.characters + characters };
}

export function outputTokenTotal(state: OutputTokens): number {
  return state.finished + (state.confirmed ?? Math.ceil(state.characters / 4));
}
