import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, render } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCM } from "@replit/codemirror-vim";
import { Buffer, type BufferHandle, type BufferProps } from "./Buffer";
import { bufferField } from "./state";
import { mermaidRenderer } from "../lib/files/markdown-mermaid";
import type { ColumnDef, LineInfo } from "./line";

function text(value: string, extra: Partial<LineInfo> = {}): LineInfo {
  return { kind: "text", text: value, ...extra };
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

type Mounted = { handle: BufferHandle; view: EditorView };

function mount(props: Partial<BufferProps> & { lines: LineInfo[] }): Mounted {
  const holder: { handle: BufferHandle | null } = { handle: null };
  const { container } = render(
    <Buffer
      side="main"
      {...props}
      onReady={(value) => {
        holder.handle = value;
      }}
    />,
  );
  const editor = container.querySelector<HTMLElement>(".cm-editor");
  if (editor === null) throw new Error("エディターが描画されていない");
  const view = EditorView.findFromDOM(editor);
  if (view === null) throw new Error("EditorView が見つからない");
  if (holder.handle === null) throw new Error("操作が受け取れていない");
  return { handle: holder.handle, view };
}

function decorations(state: EditorState): { from: number; to: number; class: string }[] {
  const found: { from: number; to: number; class: string }[] = [];
  const cursor = state.field(bufferField).decorations.iter();
  while (cursor.value !== null) {
    found.push({ from: cursor.from, to: cursor.to, class: cursor.value.spec.class ?? "" });
    cursor.next();
  }
  return found;
}

function lineClasses(state: EditorState, index: number): string[] {
  const from = state.doc.line(index + 1).from;
  return decorations(state)
    .filter((item) => item.from === from && item.to === from)
    .flatMap((item) => item.class.split(" "))
    .filter((name) => name !== "");
}

function speakerTags(state: EditorState): string[] {
  return decorations(state)
    .filter((item) => item.from !== item.to && item.class.includes("cm-speaker-tag"))
    .map((item) => item.class);
}

function cursorLine(view: EditorView): number {
  return view.state.doc.lineAt(view.state.selection.main.head).number - 1;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("回数の入力・ビジュアルモード・検索の入力の途中で追記しても、カーソルとその状態が保たれる", () => {
  it("行の書き換えの直後のジャンプは、新しい行の末尾へ移る", () => {
    const { handle, view } = mount({ lines: [text("読み込み中")] });
    handle.replaceAll([text("最初"), text("途中"), text("末尾")]);
    handle.jumpTo(Number.MAX_SAFE_INTEGER);
    expect(view.state.doc.toString()).toBe("最初\n途中\n末尾");
    expect(cursorLine(view)).toBe(2);
  });
  it("回数を打ちかけのまま追記しても、カーソルと回数が残る", async () => {
    const { handle, view } = mount({ lines: [text("一"), text("二")], followTail: true });
    handle.jumpTo(1);
    view.focus();
    fireEvent.keyDown(view.contentDOM, { key: "3" });
    expect(getCM(view)?.state.vim?.status).toBe("3");
    const head = view.state.selection.main.head;

    handle.append([text("追記")]);
    await nextFrame();

    expect(getCM(view)?.state.vim?.status).toBe("3");
    expect(view.state.selection.main.head).toBe(head);
    expect(view.state.doc.line(view.state.doc.lines).text).toBe("追記");
  });

  it("ビジュアルモードのまま追記しても、選んだ範囲が残る", async () => {
    const { handle, view } = mount({
      lines: [text("あいうえお"), text("かきくけこ")],
      followTail: true,
    });
    handle.jumpTo(1);
    view.focus();
    fireEvent.keyDown(view.contentDOM, { key: "v" });
    fireEvent.keyDown(view.contentDOM, { key: "w" });
    const selection = view.state.selection;
    expect(getCM(view)?.state.vim?.visualMode).toBe(true);
    expect(selection.main.empty).toBe(false);

    handle.append([text("追記")]);
    await nextFrame();

    expect(getCM(view)?.state.vim?.visualMode).toBe(true);
    expect(view.state.selection.main.anchor).toBe(selection.main.anchor);
    expect(view.state.selection.main.head).toBe(selection.main.head);
  });

  it("検索の入力をしている途中に追記しても、検索の語とカーソルが残る", async () => {
    const { handle, view } = mount({
      lines: [text("テストの行"), text("ほかの行")],
      followTail: true,
    });
    handle.jumpTo(1);
    view.focus();
    fireEvent.keyDown(view.contentDOM, { key: "/" });
    const input = view.dom.querySelector<HTMLInputElement>(".cm-vim-panel input");
    if (input === null) throw new Error("検索の入力欄が開いていない");
    input.value = "テスト";
    fireEvent.keyUp(input, { key: "ト" });
    expect(getCM(view)?.state.vim?.status).toBe("/");
    const head = view.state.selection.main.head;

    handle.append([text("追記")]);
    await nextFrame();

    expect(getCM(view)?.state.vim?.status).toBe("/");
    expect(view.dom.querySelector(".cm-vim-panel input")).toBe(input);
    expect(input.value).toBe("テスト");
    expect(view.state.selection.main.head).toBe(head);
  });
});

describe("読み取り専用のバッファ", () => {
  it("編集のキーを押しても文字は変わらない", () => {
    const { view } = mount({ lines: [text("そのまま"), text("残る")] });
    view.focus();
    const before = view.state.doc.toString();

    for (const key of ["x", "d", "d", "i", "o", "p"]) {
      fireEvent.keyDown(view.contentDOM, { key });
    }

    expect(view.state.doc.toString()).toBe(before);
  });
});

describe("途中の行の書き換え", () => {
  it("範囲の中のカーソルは同じ行番号に残る", async () => {
    const lines = Array.from({ length: 8 }, (_, index) => text(`行${index}`));
    const { handle, view } = mount({ lines });
    handle.jumpTo(5);

    handle.replace(4, 7, [text("差し替え1"), text("差し替え2")]);
    await nextFrame();

    expect(cursorLine(view)).toBe(5);
  });

  it("範囲の新しい最後の行までに詰める", async () => {
    const lines = Array.from({ length: 8 }, (_, index) => text(`行${index}`));
    const { handle, view } = mount({ lines });
    handle.jumpTo(6);

    handle.replace(4, 7, [text("差し替え")]);
    await nextFrame();

    expect(cursorLine(view)).toBe(4);
  });

  it("範囲の後のカーソルは変更に合わせて動く", async () => {
    const lines = Array.from({ length: 8 }, (_, index) => text(`行${index}`));
    const { handle, view } = mount({ lines });
    handle.jumpTo(7);

    handle.replace(4, 6, [text("差し替え")]);
    await nextFrame();

    expect(cursorLine(view)).toBe(6);
    expect(view.state.doc.line(7).text).toBe("行7");
  });
});

describe("並べ替え", () => {
  it("同じ識別子の行へ移る", async () => {
    const lines = [text("A", { id: "a" }), text("B", { id: "b" }), text("C", { id: "c" })];
    const { handle, view } = mount({ lines });
    handle.jumpTo(1);

    handle.replaceAll([text("B", { id: "b" }), text("C", { id: "c" }), text("A", { id: "a" })]);
    await nextFrame();

    expect(cursorLine(view)).toBe(0);
    expect(view.state.doc.line(1).text).toBe("B");
  });

  it("同じ識別子が無ければ同じ行番号に詰めて置く", async () => {
    const lines = [text("A", { id: "a" }), text("B", { id: "b" }), text("C", { id: "c" })];
    const { handle, view } = mount({ lines });
    handle.jumpTo(2);

    handle.replaceAll([text("X"), text("Y")]);
    await nextFrame();

    expect(cursorLine(view)).toBe(1);
  });
});

describe("末尾について行く", () => {
  it("最後の行にいるときだけ、追記で新しい最後の行へ移る", async () => {
    const { handle, view } = mount({ lines: [text("一"), text("二")], followTail: true });
    handle.jumpTo(1);

    handle.append([text("追記1"), text("追記2")]);
    await nextFrame();

    expect(cursorLine(view)).toBe(3);
  });

  it("最後の行にいないときは動かない", async () => {
    const { handle, view } = mount({ lines: [text("一"), text("二")], followTail: true });
    handle.jumpTo(0);
    const head = view.state.selection.main.head;

    handle.append([text("追記")]);
    await nextFrame();

    expect(view.state.selection.main.head).toBe(head);
  });

  it("ビジュアルモードのあいだは、末尾について行かない", async () => {
    const { handle, view } = mount({ lines: [text("一"), text("二")], followTail: true });
    handle.jumpTo(1);
    view.focus();
    fireEvent.keyDown(view.contentDOM, { key: "v" });
    expect(getCM(view)?.state.vim?.visualMode).toBe(true);
    const head = view.state.selection.main.head;

    handle.append([text("追記")]);
    await nextFrame();

    expect(view.state.selection.main.head).toBe(head);
  });

  it("末尾について行く指定が無ければ動かない", async () => {
    const { handle, view } = mount({ lines: [text("一"), text("二")] });
    handle.jumpTo(1);
    const head = view.state.selection.main.head;

    handle.append([text("追記")]);
    await nextFrame();

    expect(view.state.selection.main.head).toBe(head);
  });
});

describe("ツールの行", () => {
  it("結果の行の ⎿ だけを 1 マス幅の印で囲み、続きの行と字の頭を揃える", () => {
    const { view } = mount({
      lines: [
        { kind: "tool", text: "● Bash(rg ⎿)" },
        { kind: "tool", text: "  ⎿  一" },
        { kind: "tool", text: "     二" },
      ],
    });
    const from = view.state.doc.line(2).from;

    expect(decorations(view.state).filter((item) => item.from !== item.to)).toEqual([
      { from: from + 2, to: from + 3, class: "cm-tool-elbow" },
    ]);
  });
});

describe("発言の帯と札", () => {
  it("追記で発言が続いても、前の最終行から作り直されて途切れない", async () => {
    const { handle, view } = mount({
      lines: [{ kind: "speaker", text: "あなた" }, text("一"), text("二")],
    });

    handle.append([text("三"), text("四")]);
    await nextFrame();

    expect(lineClasses(view.state, 2)).toContain("cm-band-you");
    expect(lineClasses(view.state, 2)).not.toContain("cm-band-last");
    expect(lineClasses(view.state, 3)).toContain("cm-band-you");
    expect(lineClasses(view.state, 3)).not.toContain("cm-band-last");
    expect(lineClasses(view.state, 4)).toContain("cm-band-you");
    expect(lineClasses(view.state, 4)).toContain("cm-band-last");
    expect(speakerTags(view.state)).toHaveLength(1);
    expect(speakerTags(view.state)[0]).toContain("cm-speaker-you");
  });

  it.each(["separator", "heading", "section", "row", "note", "queued"] as const)(
    "%s の後の行には、前の発言の帯を付けない",
    (kind) => {
      const boundary: LineInfo = {
        kind,
        text: "境目",
        ...(kind === "heading" ? { target: { url: "/x" } } : {}),
      };
      const { view } = mount({
        lines: [{ kind: "speaker", text: "あなた" }, text("一"), boundary, text("二")],
      });

      expect(lineClasses(view.state, 1)).toContain("cm-band-you");
      expect(lineClasses(view.state, 3)).not.toContain("cm-band-you");
      expect(lineClasses(view.state, 3)).not.toContain("cm-band-ai");
    },
  );

  it("区切りのすぐ後から書き換えても、前の発言の帯を付けない", async () => {
    const { handle, view } = mount({
      lines: [
        { kind: "speaker", text: "あなた" },
        { kind: "separator", text: "ここから" },
        text("一"),
        text("二"),
      ],
    });

    handle.replace(3, 4, [text("差し替え")]);
    await nextFrame();

    expect(lineClasses(view.state, 2)).not.toContain("cm-band-you");
    expect(lineClasses(view.state, 3)).not.toContain("cm-band-you");
  });
});

describe("カーソルを置けない行の飛ばし", () => {
  it("区切りの行に乗ると、同じ向きの次の置ける行へ移る", () => {
    const { view } = mount({
      lines: [text("一"), { kind: "separator", text: "ここから" }, text("二")],
    });
    view.focus();

    fireEvent.keyDown(view.contentDOM, { key: "j" });

    expect(cursorLine(view)).toBe(2);
  });

  it("端では逆の向きの置ける行に置かれる", () => {
    const { view } = mount({
      lines: [text("一"), { kind: "separator", text: "ここから" }],
    });
    view.focus();

    fireEvent.keyDown(view.contentDOM, { key: "j" });

    expect(cursorLine(view)).toBe(0);
  });
});

describe("末尾の区画", () => {
  it("保存した発言が届くと、書きかけが消えて 1 回だけ出て、届く前の指示が最後に残る", async () => {
    const { handle, view } = mount({ lines: [text("一"), text("二")] });
    handle.setTail("reply", [text("書きかけ")]);
    handle.setTail("queue", [{ kind: "queued", text: "届く前の指示" }]);
    await nextFrame();
    expect(view.state.doc.toString()).toBe("一\n二\n書きかけ\n届く前の指示");

    handle.append([text("保存した発言")], ["reply"]);
    await nextFrame();

    expect(view.state.doc.toString()).toBe("一\n二\n保存した発言\n届く前の指示");
    expect(view.state.doc.toString().split("保存した発言")).toHaveLength(2);
    expect(view.state.doc.line(view.state.doc.lines).text).toBe("届く前の指示");
  });
});

describe("追記のまとめ", () => {
  it("1 回の描画の間に届いた 100 件の追記を 1 つの transaction にまとめる", async () => {
    const { handle, view } = mount({ lines: [text("最初")] });
    const dispatch = vi.spyOn(view, "dispatch");

    for (let index = 0; index < 100; index += 1) {
      handle.append([text(`追記${index}`)]);
    }
    await nextFrame();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(view.state.doc.lines).toBe(101);
  });

  it("1 万行のバッファに追記しても、状態を作り直さない", async () => {
    const create = vi.spyOn(EditorState, "create");
    const lines = Array.from({ length: 10_000 }, (_, index) => text(`行${index}`));
    const { handle, view } = mount({ lines });
    expect(create).toHaveBeenCalledTimes(1);
    const setState = vi.spyOn(view, "setState");

    handle.append([text("追記")]);
    await nextFrame();

    expect(create).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledTimes(0);
    expect(view.state.doc.lines).toBe(10_001);
  });
});

describe("同じ描画までに追記と操作が重なったとき", () => {
  it("複数の追記をまとめても、新しい最後の行について行く", async () => {
    const { handle, view } = mount({ lines: [text("一"), text("二")], followTail: true });
    handle.jumpTo(1);

    handle.append([text("三")]);
    handle.append([text("四")]);
    handle.append([text("五")]);
    await nextFrame();

    expect(view.state.doc.toString()).toBe("一\n二\n三\n四\n五");
    expect(cursorLine(view)).toBe(4);
  });

  it("追記を予約した後に前の行へ移ったら、その位置を保つ", async () => {
    const { handle, view } = mount({ lines: [text("一"), text("二")], followTail: true });
    handle.jumpTo(1);
    view.focus();

    handle.append([text("三")]);
    fireEvent.keyDown(view.contentDOM, { key: "k" });
    await nextFrame();

    expect(cursorLine(view)).toBe(0);
    expect(view.state.doc.toString()).toBe("一\n二\n三");
  });

  it("追記を予約した後に回数を打ちかけたら、位置と入力を保つ", async () => {
    const { handle, view } = mount({ lines: [text("一"), text("二")], followTail: true });
    handle.jumpTo(1);
    view.focus();

    handle.append([text("三")]);
    fireEvent.keyDown(view.contentDOM, { key: "3" });
    await nextFrame();

    expect(cursorLine(view)).toBe(1);
    expect(getCM(view)?.state.vim?.status).toBe("3");
    expect(view.state.doc.toString()).toBe("一\n二\n三");
  });

  it("追記の後の書き換えでも、範囲の中の行番号と桁を保つ", async () => {
    const { handle, view } = mount({ lines: [text("一番"), text("二番"), text("三番")] });
    view.dispatch({ selection: { anchor: view.state.doc.line(2).from + 1 } });

    handle.append([text("四番")]);
    handle.replace(0, 3, [text("変更一"), text("変更二"), text("変更三")]);
    await nextFrame();

    expect(cursorLine(view)).toBe(1);
    expect(view.state.selection.main.head - view.state.doc.line(2).from).toBe(1);
    expect(view.state.doc.toString()).toBe("変更一\n変更二\n変更三\n四番");
  });
});

describe("末尾の区画のカーソル", () => {
  it("区画を縮めても、範囲の中のカーソルを新しい最後の行と桁に詰める", async () => {
    const { handle, view } = mount({ lines: [text("確定")] });
    handle.setTail("reply", [text("途中一"), text("途中二"), text("途中三")]);
    await nextFrame();
    view.dispatch({ selection: { anchor: view.state.doc.line(3).from + 1 } });

    handle.setTail("reply", [text("新しい本文")]);
    await nextFrame();

    expect(cursorLine(view)).toBe(1);
    expect(view.state.selection.main.head - view.state.doc.line(2).from).toBe(1);
    expect(view.state.doc.toString()).toBe("確定\n新しい本文");
  });
});

describe("桁の装飾", () => {
  it.each([
    ["", "本文", "最後"],
    ["番号", "", "最後"],
    ["番号", "本文", ""],
  ])("空欄を含む桁 %s/%s/%s は、描画と更新で文字と列の対応を保つ", async (...cols) => {
    const classes = ["first-column", "second-column", "third-column"];
    const columns: ColumnDef[] = [
      {
        name: "empty-columns",
        widths: [3, 5, 7],
        align: ["left", "right", "left"],
        classes,
      },
    ];
    const row: LineInfo = { kind: "row", text: cols.join("  "), cols, colDef: "empty-columns" };
    const { handle, view } = mount({ lines: [row], columns });
    const readColumns = () =>
      [...view.dom.querySelectorAll<HTMLElement>(".cm-column")].map((element) => ({
        text: element.textContent,
        class: element.className,
        align: element.style.textAlign,
      }));
    const expected = cols.map((value, index) => ({
      text: value,
      class: `cm-column ${classes[index]}`,
      align: index === 1 ? "right" : "",
    }));

    expect(view.state.doc.toString()).toBe(row.text);
    expect(readColumns()).toEqual(expected);

    handle.append([row]);
    await nextFrame();
    expect(view.state.doc.toString()).toBe(`${row.text}\n${row.text}`);
    expect(readColumns()).toEqual([...expected, ...expected]);

    handle.replace(0, 1, [row]);
    handle.setTail("reply", [row]);
    await nextFrame();
    expect(view.state.doc.toString()).toBe([row.text, row.text, row.text].join("\n"));
    expect(readColumns()).toEqual([...expected, ...expected, ...expected]);
  });

  it("メニューの番号と名前に、桁をつなぐ空白を混ぜない", () => {
    const { view } = mount({
      lines: [{ kind: "menu", text: "1  続ける  実行する", cols: ["1", "続ける", "実行する"] }],
    });

    expect([...view.dom.querySelectorAll(".cm-column")].map((el) => el.textContent)).toEqual([
      "1",
      "続ける",
      "実行する",
    ]);
    expect(view.state.doc.toString()).toBe("1  続ける  実行する");
  });

  it("途中を書き換えても、範囲の外の行の装飾は残る", async () => {
    const { handle, view } = mount({
      lines: [text("一"), text("二"), text("三"), { kind: "tool", text: "残すコマンド" }],
    });
    handle.replace(1, 2, [text("変更")]);
    await nextFrame();

    expect(lineClasses(view.state, 3)).toEqual(["cm-kind-tool"]);
    expect(view.state.doc.line(4).text).toBe("残すコマンド");
  });
});

describe("AI の発言の Markdown の表示", () => {
  const ai = (value: string, seq: number, extra: Partial<LineInfo> = {}): LineInfo =>
    text(value, { seq, markdown: true, ...extra });
  const texts = (view: EditorView, selector: string): string[] =>
    [...view.contentDOM.querySelectorAll(selector)].map((el) => el.textContent ?? "");

  it("印の付いた行だけ、記号を隠して強調とコードと見出しを整える", () => {
    const { view } = mount({
      lines: [
        { kind: "speaker", text: "AI" },
        ai("前置き", 1),
        ai("## なぜ止めたか", 1),
        ai("**太字** と `origin/main`", 1),
        text("**あなたの発言** はそのまま"),
      ],
    });

    expect(texts(view, ".cm-file-strong")).toEqual(["太字"]);
    expect(texts(view, ".cm-file-inline-code")).toEqual(["origin/main"]);
    expect(view.contentDOM.querySelector(".cm-file-heading-2")?.textContent).toBe("なぜ止めたか");
    expect(view.contentDOM.textContent).toContain("**あなたの発言** はそのまま");
    expect(view.contentDOM.textContent).not.toContain("**太字**");
    expect(view.state.doc.line(4).text).toBe("**太字** と `origin/main`");
  });

  it("カーソルの行では記号を出す", () => {
    const { view } = mount({ lines: [ai("**太字**", 1), ai("次の行", 1)] });

    expect(view.contentDOM.textContent).toContain("**太字**");
    expect(texts(view, ".cm-file-strong")).toEqual(["**太字**"]);
  });

  it("発言ごとに分けて読み、閉じていないコードの囲みが次の発言へ及ばない", () => {
    const { view } = mount({
      lines: [ai("前置き", 1), ai("```ts", 1), ai("const a = 1;", 1), ai("**次の発言**", 2)],
    });

    expect(texts(view, ".cm-file-code-line")).toEqual(["const a = 1;"]);
    expect(texts(view, ".cm-file-strong")).toEqual(["次の発言"]);
  });

  describe("表", () => {
    const table = [
      ai("前置き", 1),
      ai("| 列 | 値 |", 1),
      ai("| --- | ---: |", 1),
      ai("| とても長いセル | **1** |", 1),
      ai("| | 空のあと |", 1),
    ];
    const rows = (view: EditorView) =>
      [...view.contentDOM.querySelectorAll(".cm-line")]
        .map((line) => [...line.querySelectorAll<HTMLElement>(".cm-file-table-cell")])
        .filter((cells) => cells.length > 0);
    const styleOf = (cell: HTMLElement) => cell.getAttribute("style") ?? "";
    const widthEm = (cell: HTMLElement) =>
      Number(/--cell-width: *([\d.]+)em/.exec(styleOf(cell))?.[1] ?? Number.NaN);

    it("縦棒と区切りの行を隠し、セルだけを出す", () => {
      const { view } = mount({ lines: table });

      expect(rows(view).map((cells) => cells.map((cell) => cell.textContent))).toEqual([
        ["列", "値"],
        ["とても長いセル", "1"],
        ["", "空のあと"],
      ]);
      expect(view.contentDOM.textContent).not.toContain("|");
      expect(view.contentDOM.textContent).not.toContain("---");
      expect(view.state.doc.line(4).text).toBe("| とても長いセル | **1** |");
    });

    it("同じ列のセルは、いちばん長いセルに合わせた同じ幅で出す", () => {
      const { view } = mount({ lines: table });
      const widths = rows(view).map((cells) => cells.map(widthEm));

      expect(new Set(widths.map((row) => row[0])).size).toBe(1);
      expect(new Set(widths.map((row) => row[1])).size).toBe(1);
      expect(widths[0][0]).toBeGreaterThan(widths[0][1]);
    });

    it("URL のセルは、画面に出る URL の文字の幅で測る", () => {
      const url = "https://example.com/bbbbbbbb";
      const { view } = mount({
        lines: [
          ai("前置き", 1),
          ai("| a | b |", 1),
          ai("| --- | --- |", 1),
          ai(`| <${url}> | x |`, 1),
          ai("| 短 | y |", 1),
        ],
      });
      const [, autolink, short] = rows(view);

      expect(autolink[0].textContent).toBe(url);
      expect(widthEm(short[0])).toBeGreaterThanOrEqual(url.length * 0.6);
    });

    it("ウィンドウより広い表は、短い列の幅を保って、長い列だけをウィンドウに収まるまで縮める", async () => {
      const { view } = mount({
        lines: [
          ai("前置き", 1),
          ai("| a | b |", 1),
          ai("| --- | --- |", 1),
          ai(`| 短 | ${"長".repeat(80)} |`, 1),
        ],
      });
      Object.defineProperty(view.contentDOM, "clientWidth", { value: 300, configurable: true });
      await nextFrame();
      await nextFrame();
      const [, body] = rows(view);
      const line = body[0].closest<HTMLElement>(".cm-line") ?? view.contentDOM;
      const size = Number.parseFloat(getComputedStyle(line).fontSize) || 16;

      expect(widthEm(body[0])).toBeCloseTo(1 + 1.1, 6);
      expect(widthEm(body[0]) + widthEm(body[1])).toBeCloseTo(300 / size - 2, 6);
    });

    it("画像だけのセルと、端に画像のあるセルも、枠の中に画像の印を出して列を保つ", () => {
      const { view } = mount({
        lines: [
          ai("前置き", 1),
          ai("| a | b |", 1),
          ai("| --- | --- |", 1),
          ai("| ![図](a.png) | x |", 1),
          ai("| 説明 ![図](a.png) | y |", 1),
        ],
      });
      const [, only, edge] = rows(view);

      expect(only.map((cell) => cell.textContent)).toEqual(["[画像: 図]", "x"]);
      expect(edge.map((cell) => cell.textContent)).toEqual(["説明 [画像: 図]", "y"]);
    });

    it("見出しの行のセルは太字にし、区切りの行の寄せを列に当てる", () => {
      const { view } = mount({ lines: table });
      const [head, body] = rows(view);

      expect(head.map((cell) => cell.classList.contains("cm-file-table-head"))).toEqual([
        true,
        true,
      ]);
      expect(body.map((cell) => cell.classList.contains("cm-file-table-head"))).toEqual([
        false,
        false,
      ]);
      expect(body.map((cell) => cell.style.textAlign)).toEqual(["", "right"]);
    });

    it("カーソルの行は、記号を含めたソースのまま出す", () => {
      const { view } = mount({ lines: table, startLine: 3 });

      expect(rows(view)).toHaveLength(2);
      expect(view.contentDOM.textContent).toContain("| とても長いセル | **1** |");
    });
  });

  describe("Mermaid", () => {
    const diagram = ["```mermaid", "graph TD", "A-->B", "```"];

    it("発言の中の閉じた mermaid のブロックの次に図を描き、ほかの発言のフェンスとはつなげない", async () => {
      const codes: string[] = [];
      const { view } = mount({
        lines: [
          ...diagram.map((line) => ai(line, 1)),
          ai("```mermaid", 2),
          ai("graph LR", 2),
          ai("```", 3),
          text("```mermaid"),
          text("graph TD"),
          text("```"),
        ],
        display: mermaidRenderer.of(async (code) => {
          codes.push(code);
          return "<svg></svg>";
        }),
      });
      await nextFrame();

      expect(codes).toEqual(["graph TD\nA-->B"]);
      expect(view.dom.querySelectorAll(".cm-mermaid svg")).toHaveLength(1);
      expect(view.state.doc.lines).toBe(10);
    });

    it("書きかけの発言でフェンスが閉じると図を描く", async () => {
      const codes: string[] = [];
      const { handle, view } = mount({
        lines: [text("先頭")],
        display: mermaidRenderer.of(async (code) => {
          codes.push(code);
          return "<svg></svg>";
        }),
      });
      handle.setTail(
        "reply",
        diagram.slice(0, 3).map((line) => text(line, { markdown: true })),
      );
      await nextFrame();
      expect(view.dom.querySelector(".cm-mermaid")).toBeNull();

      handle.setTail(
        "reply",
        diagram.map((line) => text(line, { markdown: true })),
      );
      await nextFrame();
      expect(codes).toEqual(["graph TD\nA-->B"]);
    });
  });

  it("追記した発言の行も整える", async () => {
    const { handle, view } = mount({ lines: [text("先頭")] });
    handle.append([ai("**届いた**", 3)]);
    await nextFrame();

    expect(texts(view, ".cm-file-strong")).toEqual(["届いた"]);
  });
});
