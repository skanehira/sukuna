import { issueNumberSchema, type IssueInput, type IssueView } from "../../../shared/issue/schema";
import type { ColumnDef, LineInfo } from "../../buffer/line";

export const issueFormTitle = "issue の作成・編集";
export const issueFields = {
  title: "題名",
  body: "本文",
  parentNumber: "親",
  dependsOn: "依存",
  priority: "優先度",
  confirmBeforeMerge: "merge 前の確認",
};
export type IssueField = keyof typeof issueFields;
export const issueFormColumns: ColumnDef[] = [{ name: "issue-fields", widths: [10, 0] }];

export const priorityLabels = { high: "高", medium: "中", low: "低" };

export function isClosedIssue(issue: IssueView | null): boolean {
  return issue?.state === "done" || issue?.state === "withdrawn";
}

export function mayEditIssueField(issue: IssueView | null, field: IssueField): boolean {
  return (
    !isClosedIssue(issue) &&
    (issue === null || issue.state === "draft" || (field !== "title" && field !== "body"))
  );
}

export function issueFieldValue(
  field: IssueField,
  issue: IssueView | null,
  confirmDefault: boolean,
): string {
  switch (field) {
    case "title":
      return issue?.title ?? "";
    case "body":
      return issue?.body ?? "";
    case "parentNumber":
      return issue?.parent ? String(issue.parent.number) : "";
    case "dependsOn":
      return issue?.dependsOn.map(({ number }) => number).join("、") ?? "";
    case "priority":
      return issue?.priority ? priorityLabels[issue.priority] : "";
    case "confirmBeforeMerge":
      return (issue?.confirmBeforeMerge ?? confirmDefault) ? "する" : "しない";
  }
}

function issueNumber(value: string) {
  if (!/^#?\d+$/.test(value)) return null;
  const result = issueNumberSchema.safeParse(Number(value.replace(/^#/, "")));
  return result.success ? result.data : null;
}

export function issueFieldInput(field: IssueField, raw: string): IssueInput {
  const value = raw.trim();
  switch (field) {
    case "title":
      if (/[\r\n]/.test(value)) throw new Error("題名は 1 行で書いてください");
      return { title: value };
    case "body":
      return { body: value };
    case "parentNumber": {
      const number = issueNumber(value);
      if (value && number === null) throw new Error("親は issue の番号で書いてください");
      return { parentNumber: number };
    }
    case "dependsOn": {
      const numbers = value ? value.split(/[\s、,]+/).map(issueNumber) : [];
      if (numbers.includes(null)) throw new Error("依存は issue の番号で書いてください");
      return { dependsOn: numbers.filter((number) => number !== null) };
    }
    case "priority": {
      const priority = (Object.keys(priorityLabels) as (keyof typeof priorityLabels)[]).find(
        (level) => priorityLabels[level] === value,
      );
      if (value && !priority) throw new Error("優先度は高・中・低のいずれかで書いてください");
      return { priority: priority ?? null };
    }
    case "confirmBeforeMerge":
      if (value !== "する" && value !== "しない")
        throw new Error("merge 前の確認は「する」か「しない」で書いてください");
      return { confirmBeforeMerge: value === "する" };
  }
}

export function issuePair(id: string, label: string, value: string): LineInfo {
  const cols = [label, value];
  return { id, kind: "pair", colDef: "issue-fields", cols, text: cols.join("  ") };
}

function issueMenu(name: string, text: string, description?: string): LineInfo {
  return {
    kind: "menu",
    id: name,
    action: name,
    text: [text, description].filter(Boolean).join("  "),
    cols: [text, description ?? ""],
  };
}

export function issueFormLines(
  project: string,
  issue: IssueView | null,
  confirmDefault: boolean,
): LineInfo[] {
  const fields = Object.keys(issueFields) as IssueField[];
  const closed = isClosedIssue(issue);
  return [
    issuePair("project", "プロジェクト", project),
    ...fields
      .map((field) => {
        const locked =
          issue !== null && issue.state !== "draft" && (field === "title" || field === "body");
        const [first, ...rest] = issueFieldValue(field, issue, confirmDefault).split(/\r?\n/);
        const row = (value: string, index: number) =>
          issuePair(
            index === 0 ? field : `${field}:${index}`,
            index === 0 ? issueFields[field] : "",
            value,
          );
        return [
          row(locked ? `${first} (会話で AI に頼んで直します)`.trimStart() : first, 0),
          ...rest.map((line, index) => row(line, index + 1)),
        ];
      })
      .flat(),
    {
      kind: "note",
      text: closed
        ? "閉じた issue は直せません。再開してから直します。"
        : "項目の行で i を押すと、その項目を書けます。",
    },
    { kind: "heading", text: "操作" },
    ...(issue === null || issue.state === "draft"
      ? [
          { ...issueMenu("issue.confirm", "確定する", "AI が精査を始める"), main: true },
          issueMenu("issue.save-draft", "下書きとして保存する"),
        ]
      : [issueMenu("back", "戻る")]),
  ];
}
