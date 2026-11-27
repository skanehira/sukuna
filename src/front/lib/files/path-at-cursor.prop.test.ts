import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { pathAtCursor } from "./path-at-cursor";

test.prop([
  fc.array(fc.stringMatching(/^[a-z][a-z0-9]{0,9}$/), { minLength: 1, maxLength: 5 }),
  fc.integer({ min: 1, max: 50000 }),
  fc.integer({ min: 1, max: 100 }),
])("括弧内の作業場所のファイルを、任意の深さと行番号で開く", (parts, line, column) => {
  const path = parts.join("/") + ".ts";
  expect(pathAtCursor(`[${path}:${line}:${column}],`, 1, "/work")).toEqual({ path, line });
});
