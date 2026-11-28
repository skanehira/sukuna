import { afterEach, describe, expect, it } from "vite-plus/test";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdownPreview } from "./markdown-decorations";
import { findMermaid, mermaidRenderer } from "./markdown-mermaid";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Mermaid のコードブロックを探す", () => {
  it("閉じた mermaid のブロックだけを、コードと閉じの行の末尾の位置で返す", () => {
    const lines = [
      "前置き",
      "```mermaid",
      "graph TD",
      "  A-->B",
      "```",
      "~~~~ Mermaid",
      "sequenceDiagram",
      "~~~~",
      "```ts",
      "const a = 1;",
      "```",
      "```mermaid",
      "graph LR",
    ];
    const doc = Text.of(lines);

    expect(findMermaid(doc, 1, doc.lines)).toEqual([
      { code: "graph TD\n  A-->B", end: doc.line(5).to },
      { code: "sequenceDiagram", end: doc.line(8).to },
    ]);
  });

  it("引用の中と、字下げの深いリストの中のブロックも、印と字下げを除いたコードで返す", () => {
    const doc = Text.of([
      "> ```mermaid",
      "> graph LR",
      "> A-->B",
      "> ```",
      "",
      "1. x",
      "",
      "    ```mermaid",
      "    graph TB",
      "    ```",
    ]);

    expect(findMermaid(doc, 1, doc.lines)).toEqual([
      { code: "graph LR\nA-->B", end: doc.line(4).to },
      { code: "graph TB", end: doc.line(10).to },
    ]);
  });

  it("ほかの言語のコードブロックの中にある mermaid のフェンスは、図にしない", () => {
    const doc = Text.of(["````md", "```mermaid", "graph TD", "```", "````"]);

    expect(findMermaid(doc, 1, doc.lines)).toEqual([]);
  });

  it("指定した行の範囲の外へ閉じがはみ出すブロックは返さない", () => {
    const doc = Text.of(["```mermaid", "graph TD", "```"]);

    expect(findMermaid(doc, 1, 2)).toEqual([]);
  });
});

describe("Markdown のファイルのプレビューの Mermaid", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });
  const open = (doc: string, render: (code: string) => Promise<string>) => {
    const parent = document.createElement("div");
    document.body.append(parent);
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [markdownPreview, mermaidRenderer.of(render)],
      }),
    });
    return view;
  };

  it("閉じのフェンスの次に図を描き、ソースの行はそのまま残す", async () => {
    const codes: string[] = [];
    const editor = open("# 図\n```mermaid\ngraph TD\nA-->B\n```\n後", async (code) => {
      codes.push(code);
      return '<svg data-diagram="1"></svg>';
    });
    await flush();

    expect(codes).toEqual(["graph TD\nA-->B"]);
    expect(editor.dom.querySelector(".cm-mermaid svg[data-diagram='1']")).not.toBeNull();
    expect(editor.state.doc.lines).toBe(6);
  });

  it("描けなかった図は、理由を図の場所に出す", async () => {
    const editor = open("```mermaid\ngraph ??\n```", async () => {
      throw new Error("Parse error on line 1");
    });
    await flush();

    expect(editor.dom.querySelector(".cm-mermaid")?.textContent).toBe(
      "Mermaid の図を描けませんでした: Parse error on line 1",
    );
  });
});
