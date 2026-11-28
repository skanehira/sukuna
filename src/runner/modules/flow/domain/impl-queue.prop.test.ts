import { fc, test } from "@fast-check/vitest";
import { implementationQueue, type ImplementationCandidate } from "./impl-queue";

test.prop([
  fc.array(fc.constantFrom("ready", "implementing", "done", "stopped"), {
    minLength: 1,
    maxLength: 30,
  }),
  fc.integer({ min: 1, max: 15 }),
])("依存のない同順位では空き枠を番号順に埋める", (states, limit) => {
  const rows: ImplementationCandidate[] = states.map((state, index) => ({
    id: String(index),
    number: index + 1,
    state,
    priority: null,
    parentId: null,
    dependsOn: [],
    stoppedFrom: null,
    busy: state === "implementing",
  }));
  const free = Math.max(0, limit - states.filter((state) => state === "implementing").length);
  return (
    JSON.stringify(implementationQueue([...rows].reverse(), true, limit).start) ===
    JSON.stringify(
      rows
        .filter((row) => row.state === "ready")
        .slice(0, free)
        .map((row) => row.id),
    )
  );
});
