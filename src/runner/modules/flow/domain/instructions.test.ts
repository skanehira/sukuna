import { readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
import {
  firstInstruction,
  missingReport,
  nudgeInstruction,
  restartInstruction,
  resumeDependency,
} from "./instructions";

const doc = readFileSync(
  new URL("../../../../../docs/design/features/issue-flow.md", import.meta.url),
  "utf8",
);
const readBlock = (section: string) => section.split("```text\n")[1]!.split("\n```")[0]!;
const issue = { number: 42, title: "在庫" };
const project = { name: "商品", path: "/repo", defaultBranch: "main", usesGithub: true };
const tree = { path: "/repo/design", branch: "sukuna/design-42" };

it.each([
  ["triage", "精査", "dev-triage"],
  ["design", "設計", "dev-feat-spec"],
] as const)("%s の最初の指示と読み替え全行が設計書に一致する", (stage, name, skill) => {
  const section = doc.split(`### ${name}の AI\n`)[1]!;
  const table = section.split(`\`${skill}\` の読み替え:\n\n`)[1]!.split("\n\n")[0]!;
  const expectedTable = table
    .split("\n")
    .map((row) => {
      const [step, , rewrite] = row.slice(2, -2).split(" | ");
      return `| ${step} | ${rewrite} |`;
    })
    .join("\n");
  const prompt = readBlock(section)
    .replace("<番号>", "42")
    .replace("<題名>", issue.title)
    .replace("<プロジェクト名>", project.name)
    .replace("<パス>", project.path)
    .replace("<使う / 使わない>", "使う")
    .replace(/(<worktree のパス>)(.*?)(<ブランチ>)/, `${tree.path}$2${tree.branch}`)
    .replace("<ブランチ>", project.defaultBranch)
    .replace(/^<読み替えの表.*>$/m, expectedTable);
  expect(firstInstruction(stage, issue, project, tree)).toBe(prompt);
});

it("精査をやり直す最初の指示の前置きが設計書に一致する", () => {
  const before = readBlock(doc.split("再開 (`cause` が `reopen`)")[1]!);
  expect(firstInstruction("triage", issue, project, undefined, true)).toBe(
    `${before}\n\n${firstInstruction("triage", issue, project)}`,
  );
});

it("続きの指示と催促が設計書に一致する", () => {
  const nudge = doc.match(/文は「(この issue の結果を .*?)」とする/)?.[1];
  expect(nudgeInstruction("triage")).toBe(nudge?.replace("<報告のツール名>", "report_triage"));
  expect(nudgeInstruction("design")).toBe(nudge?.replace("<報告のツール名>", "report_design"));
  expect(restartInstruction).toBe(readBlock(doc.split("続きの指示の文は次のとおりとする。")[1]!));
  expect(resumeDependency).toBe(
    doc.match(/文は「(依存先の取り下げが解消しました.*?)」とする/)?.[1],
  );
  expect(missingReport).toBe(doc.match(/detail` は「(結果の報告が無いまま.*?)」とする/)?.[1]);
});
