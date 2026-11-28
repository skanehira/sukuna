import { readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
import { implementationInstruction } from "./impl-instructions";

const design = readFileSync("docs/design/features/implementation-flow.md", "utf8");
const sections = [...design.matchAll(/```text\n([\s\S]+?)\n```/g)].map((match) => match[1]!);
const table = design
  .split("`dev-impl` の読み替え:")[1]!
  .split("### merge の手順")[0]!
  .trim()
  .split("\n")
  .map((line) => {
    const [left, , right] = line.slice(2, -2).split(" | ");
    return `| ${left} | ${right} |`;
  })
  .join("\n");

it.each([true, false])("開始指示は設計書の全体と一致する (GitHub=%s)", (usesGithub) => {
  const expected = sections[0]!
    .replace("<番号>", "42")
    .replace("<題名>", "API の追加")
    .replace("<worktree のパス>", "/fixture/work/issue-42")
    .replace("<ブランチ>", "sukuna/issue-42")
    .replace("<port_slot × 10>", "20")
    .replace("<プロジェクト名>", "fixture")
    .replace("<プロジェクトのパス>", "/fixture")
    .replace("<ブランチ>", "main")
    .replace("<使う / 使わない>", usesGithub ? "使う" : "使わない")
    .replace("。<GitHub のリポジトリ名>", usesGithub ? "。 owner/repo" : "。")
    .replace("<読み替えの表 (下の表の「スキルの箇所」と「この会話での読み替え」の 2 列)>", table)
    .replace(
      "<merge の手順 (下の「merge の手順」の、GitHub を使うかどうかに合う方)>",
      sections[usesGithub ? 1 : 2]!.replaceAll("<リポジトリ名>", "owner/repo"),
    );
  expect(
    implementationInstruction(
      { number: 42, title: "API の追加" },
      { name: "fixture", path: "/fixture", defaultBranch: "main", usesGithub },
      { path: "/fixture/work/issue-42", branch: "sukuna/issue-42", portSlot: 2 },
      usesGithub ? "owner/repo" : null,
    ),
  ).toBe(expected);
});
