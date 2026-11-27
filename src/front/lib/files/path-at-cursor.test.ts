import { test, expect } from "vite-plus/test";
import { pathAtCursor, relativeFilePath } from "./path-at-cursor";

test.each([
  ["Try (`src/注文.ts:14:2`), next", "注文", { path: "src/注文.ts", line: 14 }],
  ["Read </work/shop/docs/a.md>.", "a.md", { path: "docs/a.md", line: 1 }],
  ["Read /work/shop-old/a.md", "a.md", { outside: true }],
  ["Read /work/shop/../a.md", "a.md", { outside: true }],
  ["See src/a.ts; next", "a.ts", { path: "src/a.ts", line: 1 }],
  ["See [note.txt:8] next", "note", { path: "note.txt", line: 8 }],
])("%s のカーソル下から作業場所内のパスと行を取り出す", (text, at, expected) => {
  expect(pathAtCursor(text, text.indexOf(at), "/work/shop")).toEqual(expected);
});

test("空白の上から隣の語を開かない", () => {
  expect(pathAtCursor("see src/a.ts", 3, "/work/shop")).toBeNull();
});

test("配信の相対名と作業場所内の絶対名を同じファイルに解決する", () => {
  expect(relativeFilePath("/work/shop/docs/../src/a.ts", "/work/shop/")).toBe("src/a.ts");
  expect(relativeFilePath("./src/a.ts", "/work/shop")).toBe("src/a.ts");
  expect(relativeFilePath("../shop-old/a.ts", "/work/shop")).toBeNull();
  expect(relativeFilePath("/etc/.git/a", "/etc")).toBeNull();
});
