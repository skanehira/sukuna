import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import { expect, it } from "vite-plus/test";
import { SWRConfig } from "swr";
import type { GithubImportResponse } from "../../shared/api/github-import";
import { Layout } from "../buffer/Layout";
import { BufferController } from "../buffer/controller";
import { GithubImportPage } from "./github-import";

it("取り込み済みと上限を表示し、Vの3件を送って理由別の結果と再取得を知らせる", async () => {
  let reads = 0;
  const requests: { project: string; numbers: number[] }[] = [];
  const notices: { message: string; kind: string }[] = [];
  const controller = new BufferController({
    notify: (message, kind) => notices.push({ message, kind }),
  });
  const issues = [21, 20, 19].map((number) => ({
    number,
    title: "課題 " + number,
    labels: ["bug"],
    createdAt: 0,
    url: "https://github.com/example/repo/issues/" + number,
  }));
  const result: GithubImportResponse = {
    imported: [21, 20, 19].map((githubNumber, i) => ({
      githubNumber,
      issueNumber: i + 1,
      issueId: "i" + i,
    })),
    skipped: [
      { githubNumber: 12, reason: "already_imported" },
      { githubNumber: 13, reason: "too_long" },
    ],
  };
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <Layout
        controller={controller}
        main={
          <GithubImportPage
            controller={controller}
            projectId="p"
            formatDate={() => "11/28"}
            api={{
              async candidates() {
                ++reads;
                return {
                  truncated: true,
                  issues: [
                    ...issues.map((issue) => ({ ...issue, imported: reads > 1 })),
                    { ...issues[0], number: 12, title: "前に取り込んだもの", imported: true },
                  ],
                };
              },
              async importIssues(project, numbers) {
                requests.push({ project, numbers });
                return result;
              },
            }}
          />
        }
      />
    </SWRConfig>,
  );
  const buffer = screen.getByRole("textbox", { name: "バッファ" });
  await waitFor(() =>
    expect([...buffer.querySelectorAll(".cm-line")].map((line) => line.textContent)).toEqual([
      "新しい 200 件だけを並べています",
      "#21 課題 21  bug  11/28  ",
      "#20 課題 20  bug  11/28  ",
      "#19 課題 19  bug  11/28  ",
      "#12 前に取り込んだもの  bug  11/28  取り込み済み",
      "1  選んだ issue を下書きとして取り込む  ",
    ]),
  );
  const view = EditorView.findFromDOM(buffer.closest(".cm-editor")!);
  expect(view).not.toBeNull();
  const cm = getCM(view!)!;
  act(() => {
    view!.dispatch({ selection: { anchor: view!.state.doc.line(2).from } });
    view!.focus();
    Vim.handleKey(cm, "V", "user");
    Vim.handleKey(cm, "4", "user");
    Vim.handleKey(cm, "G", "user");
  });
  await act(async () => fireEvent.keyDown(buffer, { key: "Enter" }));
  await waitFor(() =>
    expect({ requests, notices, reads }).toEqual({
      requests: [{ project: "p", numbers: [21, 20, 19] }],
      notices: [
        {
          message:
            "3 件を下書きとして取り込みました (取り込み済みの 1 件と上限を超えた 1 件は飛ばしました)",
          kind: "info",
        },
      ],
      reads: 2,
    }),
  );
});
