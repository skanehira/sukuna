import type { DesignResponse } from "../../../shared/api/design";
import type { LineInfo } from "../../buffer/line";

export const designViewName = "issue-design";
const noChanges = "設計書の変更はありません。承認すると、何も反映せずに実装待ちになります";
const beforeApproval = "設計を承認して、実装へ進めますか?";
const noDesign = "設計はまだありません。設計の AI が作ると、ここに出ます";

export function approvalConfirmation(count: number): string {
  return count === 0
    ? beforeApproval
    : `${beforeApproval} 送っていない指示が ${count} 件あります。承認しても送られずに残ります`;
}

function notice({ status, reflection }: DesignResponse): string | undefined {
  const { failure, prUrl, reflectedCommit } = reflection;
  if (status === "none") return noDesign;
  if (status === "reflecting") return "設計書を既定ブランチへ反映しています";
  if (status === "merging_pr")
    return `承認済み。設計書の PR ${prUrl} の CI を待って、AI が merge します`;
  if (status === "merge_failed")
    return `設計書の PR ${prUrl} を merge できませんでした${failure ? `: ${failure}` : ""}。設計の会話で指示を送ると、AI が merge を続けます`;
  if (status === "approved") {
    if (!reflectedCommit) return "承認済み (設計書の変更はありません)";
    return `承認済み (${prUrl ? `PR ${prUrl} で` : ""}反映したコミット ${reflectedCommit.slice(0, 7)})`;
  }
  if (failure) return `反映できませんでした: ${failure}`;
  if (status === "designing") return "設計を直しています";
}

function changeLines(
  design: DesignResponse,
  expanded: ReadonlySet<string>,
  toggle?: (path: string) => void,
): LineInfo[] {
  if (design.diffError) return [{ kind: "note", text: design.diffError }];
  if (!design.files.length) return [{ kind: "note", text: noChanges }];
  return design.files.flatMap(({ path, binary, hunks }): LineInfo[] => {
    const heading: LineInfo = {
      kind: "heading",
      text: `設計書の差分  ${path.replace(/\r?\n/g, "\\n")}`,
      id: `design-file:${path}`,
      designDiff: { path },
    };
    if (binary) return [heading, { kind: "note", text: "バイナリのため差分を出しません" }];
    const rows = hunks.flatMap(({ newStart, lines }) => {
      let newLine = Math.max(1, newStart);
      return lines.map(({ kind, oldNo, newNo, text }): LineInfo => {
        const position = newNo ?? newLine;
        if (newNo !== null) newLine = newNo + 1;
        return {
          kind: kind === "ctx" ? "code" : kind,
          text,
          lineNumber: newNo ?? oldNo ?? undefined,
          designDiff: {
            path,
            newNo: position,
            row:
              newNo === null && oldNo !== null
                ? { side: "old", line: oldNo }
                : { side: "new", line: position },
          },
        };
      });
    });
    if (rows.length <= 25 || expanded.has(path)) return [heading, ...rows];
    return [
      heading,
      ...rows.slice(0, 10),
      {
        kind: "note",
        text: `残り ${rows.length - 10} 行 (Enter か zo で開く)`,
        designDiff: { path },
        open: toggle && (() => toggle(path)),
      },
    ];
  });
}

export function designLines(
  design: DesignResponse,
  expanded: ReadonlySet<string> = new Set(),
  toggle?: (path: string) => void,
): LineInfo[] {
  const front = notice(design);
  if (design.status === "none") return [{ kind: "note", text: noDesign }];
  return [
    ...(front ? [{ kind: "note" as const, text: front }] : []),
    { kind: "heading", text: "修正方針" },
    ...(design.policy?.split(/\r?\n/).map((text) => ({ kind: "text" as const, text })) ?? []),
    { kind: "heading", text: `AI が確かめたい点  ${design.checks.length} 件` },
    ...(design.checks.length
      ? design.checks.map((text) => ({ kind: "text" as const, text: text.replace(/\r?\n/g, " ") }))
      : [{ kind: "note" as const, text: "ありません" }]),
    ...changeLines(design, expanded, toggle),
    ...(design.status === "reviewing"
      ? [
          { kind: "heading" as const, text: "操作" },
          { kind: "menu" as const, text: "承認して実装へ進める", action: "design.approve" },
          { kind: "menu" as const, text: "指摘を書いて差し戻す", action: "design.reject" },
        ]
      : []),
  ];
}
