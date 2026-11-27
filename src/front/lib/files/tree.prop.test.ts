import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { buildFileTree, visibleFileTree } from "./tree";

const segment = fc.stringMatching(/^[a-z][a-z0-9]{0,9}$/);
const file = fc
  .array(segment, { minLength: 1, maxLength: 5 })
  .map((parts) => parts.join("/") + ".txt");

test.prop([fc.uniqueArray(file, { minLength: 1, maxLength: 70 })])(
  "すべてのフォルダを広げると各ファイルが元の階層に一度だけ現れる",
  (paths) => {
    const folders = new Set(
      paths.flatMap((path) => {
        const parts = path.split("/");
        return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("/"));
      }),
    );
    const rows = visibleFileTree(buildFileTree(paths), folders);
    const leaves = rows.filter((row) => !row.folder);
    expect(leaves).toHaveLength(paths.length);
    expect(new Map(leaves.map(({ path, depth }) => [path, depth]))).toEqual(
      new Map(paths.map((path) => [path, path.split("/").length - 1])),
    );
    expect(
      rows
        .filter((row) => row.folder)
        .map(({ path }) => path)
        .sort(),
    ).toEqual([...folders].sort());
  },
);
