import { afterEach, describe, expect, it } from "vite-plus/test";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdownPreview, markdownRanges } from "./markdown-decorations";
import type { TextWidth } from "./markdown-table";

function measured(lines: string[]): [string, { bold: boolean; mono: boolean }][] {
  const calls: [string, { bold: boolean; mono: boolean }][] = [];
  const width: TextWidth = (text, font) => {
    calls.push([text, font]);
    return text.length;
  };
  const doc = Text.of(lines);
  markdownRanges(doc, 0, 0, doc.length, { width });
  return calls;
}

describe("表のセルの幅の測り方", () => {
  it("画面に出る文字を、描くときと同じ太さと書体で測る", () => {
    const calls = measured([
      "| 見出し | b |",
      "| --- | --- |",
      "| `code` と **太字** | [リンク](https://example.test) |",
    ]);

    expect(calls).toEqual(
      expect.arrayContaining([
        ["見出し", { bold: true, mono: false }],
        ["code", { bold: false, mono: true }],
        [" と ", { bold: false, mono: false }],
        ["太字", { bold: true, mono: false }],
        ["リンク", { bold: false, mono: false }],
      ]),
    );
    expect(calls.map(([text]) => text).join("")).not.toMatch(/[`*[\]()]|example\.test/);
  });

  it("使える幅より広い表は、短い列の幅を保ち、長い列だけを縮める", () => {
    const doc = Text.of(["| a | b |", "| --- | --- |", `| 短 | ${"長".repeat(40)} |`]);
    const ranges = markdownRanges(doc, 0, 0, doc.length, {
      width: (text) => text.length,
      available: 20,
    });
    const widths = ranges
      .map((range) => String(range.value.spec.attributes?.style ?? ""))
      .map((style) => Number(/--cell-width:([\d.]+)em/.exec(style)?.[1] ?? Number.NaN))
      .filter((width) => !Number.isNaN(width));

    expect(widths.slice(0, 2)).toEqual([widths[2], widths[3]]);
    expect(widths[2]).toBeLessThan(3);
    expect(widths[2] + widths[3]).toBeCloseTo(20, 6);
  });

  it("URL と自動リンクは URL を、画像は画像の印を測る", () => {
    const calls = measured([
      "| a |",
      "| --- |",
      "| https://example.test/x |",
      "| <https://example.test/y> |",
      "| ![図](a.png) |",
    ]);
    const texts = calls.map(([text]) => text);

    expect(texts).toEqual(
      expect.arrayContaining(["https://example.test/x", "https://example.test/y", "[画像: 図]"]),
    );
    expect(texts.join("")).not.toMatch(/[<>]|a\.png/);
  });
});

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

describe("ファイルのプレビューの表の幅", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });

  it("表の行の文字の大きさで使える幅を測り、収まる表は縮めない", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: `| a | ${"b".repeat(25)} |\n| --- | --- |\n| c | d |`,
        extensions: [
          markdownPreview,
          EditorView.theme({ "&": { fontSize: "20px" }, ".cm-line": { fontSize: "10px" } }),
        ],
      }),
    });
    Object.defineProperty(view.contentDOM, "clientWidth", { value: 300, configurable: true });
    await nextFrame();
    await nextFrame();
    const widths = [...view.dom.querySelectorAll<HTMLElement>(".cm-file-table-cell")].map((cell) =>
      Number(/--cell-width: *([\d.]+)em/.exec(cell.getAttribute("style") ?? "")?.[1]),
    );

    expect(widths[1]).toBeCloseTo(25 * 0.6 * 1.05 + 1.1, 6);
  });
});
