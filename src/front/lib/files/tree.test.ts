import { test, expect } from "vite-plus/test";
import { buildFileTree, visibleFileTree } from "./tree";

test("各階層ではフォルダを先に並べ、開いたフォルダの中だけを見せる", () => {
  const tree = buildFileTree(["Zoo.ts", "b/a.ts", "a.ts", "b/Z.ts", "b/nested/m.ts", "A/b.ts"]);
  const rows = visibleFileTree(tree, new Set(["b"]));
  expect(rows.map(({ path, folder, depth }) => ({ path, folder, depth }))).toEqual([
    { path: "A", folder: true, depth: 0 },
    { path: "b", folder: true, depth: 0 },
    { path: "b/nested", folder: true, depth: 1 },
    { path: "b/a.ts", folder: false, depth: 1 },
    { path: "b/Z.ts", folder: false, depth: 1 },
    { path: "a.ts", folder: false, depth: 0 },
    { path: "Zoo.ts", folder: false, depth: 0 },
  ]);
});
