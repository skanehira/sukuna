import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, render } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCM } from "@replit/codemirror-vim";
import { Buffer, type BufferHandle, type BufferProps } from "./Buffer";
import { bufferField } from "./state";
import type { LineInfo } from "./line";

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

    handle.replaceAll([text("C", { id: "c" }), text("B", { id: "b" }), text("A", { id: "a" })]);
    await nextFrame();

    expect(cursorLine(view)).toBe(1);
    expect(view.state.doc.line(2).text).toBe("B");
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
