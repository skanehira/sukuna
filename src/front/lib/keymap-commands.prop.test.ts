import { fc, test } from "@fast-check/vitest";
import { resolveKeymap } from "../buffer/keymap/resolve";
import { ActionRegistry, type KeymapEntry } from "../buffer/keymap/registry";
import { proposeKeymapChange } from "./keymap-commands";

const suffixes = fc.uniqueArray(fc.constantFrom("A", "B", "C", "D", "E", "F"), { minLength: 1 });
const bind = (keys: string, context: KeymapEntry["context"], action: string): KeymapEntry => ({
  keys,
  context,
  to: { action },
});

test.prop([suffixes, fc.boolean()])(
  "確認した割り当ては同じ場所の重なりをまとめて外し、ほかの割り当てを保つ",
  (suffix, sameKey) => {
    const key = "<Space>Y";
    const collisions = suffix.map((letter) => bind(key + letter, "normal", "open"));
    if (sameKey) collisions.push(bind(key, "normal", "open"));
    const unchanged = [bind("<Space>U", "normal", "open"), bind(key, "visual", "open")];
    const entry = bind(key, "normal", "back");
    const before = [...collisions, ...unchanged];
    const proposal = proposeKeymapChange(before, entry, new ActionRegistry());
    return (
      proposal.confirmation !== undefined &&
      JSON.stringify(resolveKeymap(before, proposal.additions)) ===
        JSON.stringify([...unchanged, entry])
    );
  },
);
