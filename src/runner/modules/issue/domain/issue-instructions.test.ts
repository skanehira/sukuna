import { readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
import { issueInstructions } from "./issue-instructions";
it("issue の追加の指示は設計書の文と完全に一致する", () => {
  const document = readFileSync(
    new URL("../../../../../docs/design/features/issue.md", import.meta.url),
    "utf8",
  );
  const expected = document
    .split("### issue の扱いの追加の指示\n")[1]!
    .split("```text\n")[1]!
    .split("\n```")[0]!;
  expect(issueInstructions()).toBe(expected);
});
