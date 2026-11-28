import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { prLines } from "./pr-lines";
import { base, file } from "./pr.test-support";

test.prop([
  fc.array(fc.constantFrom("+", "-", " "), { minLength: 1, maxLength: 45 }),
  fc.integer({ min: 1, max: 1000 }),
  fc.integer({ min: 1, max: 1000 }),
])("PR の行番号は追加で元の側を進めず、削除で先の側を進めない", (prefixes, oldStart, newStart) => {
  const hunks = [
    {
      oldStart,
      oldLines: prefixes.filter((prefix) => prefix !== "+").length,
      newStart,
      newLines: prefixes.filter((prefix) => prefix !== "-").length,
      lines: prefixes.map((prefix, index) => `${prefix}data-${index}`),
    },
  ];
  const rows = prLines(
    { ...base, files: [{ ...file, hunks }] },
    { github: true, merged: false, expanded: new Set([file.path]) },
  ).filter(({ diff }) => diff);
  expect(rows.map(({ diff, text }) => [diff!.position.side, diff!.position.line, text])).toEqual(
    prefixes.map((prefix, index) => {
      const earlier = prefixes.slice(0, index);
      return [
        prefix === "-" ? "old" : "new",
        prefix === "-"
          ? oldStart + earlier.filter((p) => p !== "+").length
          : newStart + earlier.filter((p) => p !== "-").length,
        `data-${index}`,
      ];
    }),
  );
});
