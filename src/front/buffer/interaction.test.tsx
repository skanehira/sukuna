import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { getCM } from "@replit/codemirror-vim";
import { EditorView } from "@codemirror/view";
import { Buffer, type BufferHandle } from "./Buffer";
import { Layout } from "./Layout";
import { Frame } from "./Frame";
import { BufferController } from "./controller";
import type { KeymapConfig } from "./keymap/registry";
import type { LineInfo } from "./line";

const lines: LineInfo[] = [
  { kind: "text", text: "本文" },
  { kind: "menu", text: "保存  内容を保存する", action: "save" },
  { kind: "menu", text: "削除  内容を削除する", action: "delete" },
];
function mount(
  controller: BufferController,
  value = lines,
  props: { right?: boolean; view?: string; side?: "main" | "list" | "table" } = {},
) {
  const handles: BufferHandle[] = [];
  const result = render(
    <Layout
      controller={controller}
      renderRight={() => (
        <Frame title="目次" side="right">
          <Buffer
            side="right"
            lines={[{ kind: "text", text: "章" }]}
            onReady={(h) => handles.push(h)}
          />
        </Frame>
      )}
      tree={
        <Frame title="ツリー" side="tree">
          <Buffer
            side="tree"
            lines={[{ kind: "text", text: "一覧" }]}
            onReady={(h) => handles.push(h)}
          />
        </Frame>
      }
      main={
        <Frame title="会話" side={props.side ?? "main"}>
          <Buffer
            side={props.side ?? "main"}
            viewName={props.view}
            lines={value}
            onReady={(h) => handles.push(h)}
          />
        </Frame>
      }
      right={
        props.right ? (
          <Frame title="目次" side="right">
            <Buffer
              side="right"
              lines={[{ kind: "text", text: "章" }]}
              onReady={(h) => handles.push(h)}
            />
          </Frame>
        ) : undefined
      }
    />,
  );
  const views = [...result.container.querySelectorAll<HTMLElement>(".cm-editor")].map((node) =>
    EditorView.findFromDOM(node)!,
  );
  act(() => views[1].focus());
  return { ...result, views, handles };
}
function key(view: EditorView, value: string, ctrlKey = false, extra = {}) {
  act(() => {
    fireEvent.keyDown(view.contentDOM, { key: value, ctrlKey, ...extra });
  });
}
function register(controller: BufferController, name: string, run = vi.fn(), extra = {}) {
  controller.actions.register({
    name,
    label: name,
    group: "そのほか",
    where: "会話",
    run,
    ...extra,
  });
  return run;
}

describe("メニューと確認", () => {
  it("カーソルの行と番号で選んだ行を実行し、無い番号は知らせる", async () => {
    const controller = new BufferController();
    const save = register(controller, "save");
    const remove = register(controller, "delete");
    const { views, handles } = mount(controller);
    const view = views[1];
    act(() => handles[1].jumpTo(1));
    key(view, "Enter");
    await act(async () => {});
    expect(save).toHaveBeenCalledTimes(1);
    key(view, "2");
    expect(screen.getByRole("status").textContent).toBe(
      "NORMAL会話2 Enter 「削除」を実行するEsc やめる:h ヘルプ",
    );
    key(view, "Enter");
    await act(async () => {});
    expect(remove).toHaveBeenCalledTimes(1);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3);
    key(view, "9");
    key(view, "Enter");
    expect(screen.getByRole("alert").textContent).toBe("9 番の操作は、この画面にありません");
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it.each(["n", "Escape", "x", "変換中"])("確認の %s は中止し、y だけ実行する", async (cancel) => {
    const controller = new BufferController();
    const remove = register(controller, "delete", vi.fn(), { confirm: "削除しますか?" });
    const { views } = mount(controller);
    const view = views[1];
    key(view, "2");
    key(view, "Enter");
    expect(screen.getByLabelText("操作の確認").textContent).toBe("削除しますか? (y / n)");
    key(view, cancel, false, { isComposing: cancel === "変換中" });
    expect(screen.getByRole("alert").textContent).toBe("やめました");
    expect(remove).toHaveBeenCalledTimes(0);
    key(view, "Enter");
    key(view, "y");
    await act(async () => {});
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it("処理中は同じウィンドウの Enter を重ねず Spinner を出す", async () => {
    let finish = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const controller = new BufferController();
    const save = register(
      controller,
      "save",
      vi.fn(() => pending),
    );
    const { views } = mount(controller);
    const view = views[1];
    key(view, "1");
    key(view, "Enter");
    key(view, "Enter");
    expect(screen.getByRole("progressbar", { name: "操作の実行中" })).toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    key(view, "Enter");
    expect(save).toHaveBeenCalledTimes(2);
  });
});

describe("キーとコマンド", () => {
  it("Space と Space s で候補が変わり、Ctrl+[ と Esc で元のウィンドウに戻る", () => {
    const controller = new BufferController();
    register(controller, "stock.send.all");
    register(controller, "stock.question");
    const { views } = mount(controller);
    const view = views[1];
    key(view, " ");
    expect(screen.getByLabelText("続けて押せるキー").textContent).toBe(
      "Spaceq stock.questions +送るp ツリーw +ウィンドウ",
    );
    key(view, "s");
    expect(screen.getByLabelText("続けて押せるキー").textContent).toBe("Space sa stock.send.all");
    key(view, "[", true);
    expect(controller.snapshot().prefix).toBe("");
    expect(view.hasFocus).toBe(true);
    key(view, " ");
    key(view, "Escape");
    expect(controller.snapshot().prefix).toBe("");
  });
  it("設定の再配信後も同じ EditorView で、新しいキーだけ動く", async () => {
    let changed = () => {};
    let config: KeymapConfig = { version: 1, entries: [] };
    const controller = new BufferController({
      keymap: {
        load: async () => config,
        subscribe: (fn) => {
          changed = fn;
          return () => {};
        },
        save: vi.fn(),
      },
    });
    const run = register(controller, "stock.question");
    const { views } = mount(controller);
    const view = views[1];
    await act(async () => {});
    key(view, " ");
    key(view, "q");
    expect(run).toHaveBeenCalledTimes(1);
    config = {
      version: 1,
      entries: [
        { keys: "<Space>q", context: "normal", to: null },
        { keys: "Q", context: "normal", to: { action: "stock.question" } },
      ],
    };
    await act(async () => changed());
    key(view, " ");
    key(view, "q");
    expect(run).toHaveBeenCalledTimes(1);
    key(view, "Q");
    expect(run).toHaveBeenCalledTimes(2);
    expect(EditorView.findFromDOM(view.dom)).toBe(view);
  });
  it.each([
    ["toc", true],
    ["decisions", true],
    ["conversation", false],
  ])("%s の / は指定した検索を選ぶ", (name, app) => {
    const controller = new BufferController();
    const run = register(controller, "recap.search", vi.fn(), { views: ["toc", "decisions"] });
    const { views } = mount(controller, lines, { view: name });
    key(views[1], "/");
    expect(run).toHaveBeenCalledTimes(app ? 1 : 0);
    if (!app) expect(views[1].dom.querySelector(".cm-vim-panel input")).toBeInTheDocument();
  });
  it("コマンド行は完全一致で引き、IME の Enter は実行しない", async () => {
    const controller = new BufferController();
    const run = vi.fn();
    controller.commands.register({ name: "help", label: "ヘルプ", run });
    const { views } = mount(controller);
    key(views[1], ":");
    expect(controller.snapshot().mode).toBe("COMMAND");
    const input = screen.getByRole("textbox", { name: "コマンド" });
    fireEvent.change(input, { target: { value: "help" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(run).toHaveBeenCalledTimes(0);
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {});
    expect(run).toHaveBeenCalledTimes(1);
    key(views[1], ":");
    fireEvent.change(screen.getByRole("textbox", { name: "コマンド" }), { target: { value: "s" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "コマンド" }), { key: "Enter" });
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toBe(
      "コマンド :s はありません。:h で一覧を見られます",
    );
  });
});

describe("ウィンドウとジャンプ", () => {
  it("Ctrl+w の左右移動は存在するウィンドウの端で止まる", () => {
    const controller = new BufferController();
    const { views } = mount(controller);
    const [tree, main] = views;
    key(main, "w", true);
    key(main, "l");
    expect(main.hasFocus).toBe(true);
    key(main, "w", true);
    key(main, "h");
    expect(tree.hasFocus).toBe(true);
    key(tree, "w", true);
    key(tree, "l");
    expect(main.hasFocus).toBe(true);
  });
  it("pushJump は動かさず、Ctrl+o で積んだ行へ移る", () => {
    const controller = new BufferController();
    const { handles, views } = mount(controller);
    const main = views[1];
    handles[1].pushJump(2);
    expect(main.state.doc.lineAt(main.state.selection.main.head).number).toBe(1);
    key(main, "o", true);
    expect(main.state.doc.lineAt(main.state.selection.main.head).number).toBe(3);
  });
  it("右の表示を開いて Ctrl+h で前へ戻り、空なら閉じる", () => {
    const controller = new BufferController();
    const { views } = mount(controller, lines, { right: true });
    act(() => {
      controller.openRight({ view: "toc", target: "c1" });
      controller.openRight({ view: "stock", target: "c1" });
    });
    key(views[2], "h", true);
    expect(controller.right.current).toEqual({ view: "toc", target: "c1" });
    key(views[2], "h", true);
    expect(controller.right.current).toBeNull();
  });
});

describe("画面の復元とコピー", () => {
  it("再表示では行の識別子でカーソルを戻し、別のタブの位置には影響しない", () => {
    const controller = new BufferController();
    const first = mount(controller, [
      { kind: "text", text: "一", id: "one" },
      { kind: "text", text: "二", id: "two" },
    ]);
    act(() => first.handles[1].jumpTo(1));
    first.unmount();
    const next = new BufferController({ positions: controller.positions });
    const restored = mount(next, [
      { kind: "text", text: "二", id: "two" },
      { kind: "text", text: "一", id: "one" },
    ]);
    expect(
      restored.views[1].state.doc.lineAt(restored.views[1].state.selection.main.head).number,
    ).toBe(1);
    expect(restored.views[1].state.doc.line(1).text).toBe("二");
    expect(new BufferController().positions.position("/:main:main")).toBeNull();
  });
  it("y で選択した文字は Vim のレジスタとコピーの手段へ渡す", async () => {
    const fallback = vi.fn(() => true);
    const controller = new BufferController({
      clipboard: { secure: false, fallback, write: vi.fn(), notify: vi.fn() },
    });
    const { views } = mount(controller, [{ kind: "text", text: "copy this" }]);
    key(views[1], "v");
    key(views[1], "l");
    key(views[1], "y");
    await act(async () => {});
    expect(fallback.mock.calls).toEqual([["co"]]);
  });
});

describe("Vim の移動を保った割り当て", () => {
  it("f の次の i は文字を探し、単独の i は入力欄の動作を呼ぶ", () => {
    const controller = new BufferController();
    const open = register(controller, "prompt.open");
    const { views } = mount(controller, [{ kind: "text", text: "find it" }]);
    key(views[1], "f");
    key(views[1], "i");
    expect(views[1].state.selection.main.head).toBe(1);
    expect(open).toHaveBeenCalledTimes(0);
    key(views[1], "i");
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("ウィンドウの表示", () => {
  it("q は右のウィンドウを閉じて主へ戻す", () => {
    const controller = new BufferController();
    const { views } = mount(controller, lines, { right: true });
    expect(screen.getByRole("region", { name: "目次" })).toBeInTheDocument();
    key(views[1], "q");
    expect(screen.queryByRole("region", { name: "目次" })).toBeNull();
    expect(views[1].hasFocus).toBe(true);
  });
});

describe("入力欄から戻る先", () => {
  it("i で開いた入力欄からコマンド行を開いて戻っても、閉じると元のウィンドウへ戻る", () => {
    const close = vi.fn();
    const controller = new BufferController({
      prompt: () => ({
        label: "指示",
        target: "会話",
        verb: "送る",
        initialText: "書きかけ",
        submit: vi.fn(),
        close,
      }),
    });
    const { views, container } = mount(controller);
    key(views[1], "i");
    const prompt = EditorView.findFromDOM(
      container.querySelectorAll<HTMLElement>(".cm-editor")[2],
    )!;
    key(prompt, "[", true);
    key(prompt, ":");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "コマンド" }), {
      key: "[",
      ctrlKey: true,
    });
    key(prompt, "[", true);
    expect(close.mock.calls).toEqual([["書きかけ"]]);
    expect(views[1].hasFocus).toBe(true);
  });
});

describe("メニューの番号", () => {
  it("初期表示・追記・削除のあとも、ウィンドウ全体で上から 1 から番号を振る", async () => {
    const controller = new BufferController();
    const { handles, views } = mount(controller);
    expect(views[1].state.doc.toString()).toBe(
      "本文\n1  保存  内容を保存する\n2  削除  内容を削除する",
    );
    act(() => handles[1].append([{ kind: "menu", text: "続ける  次へ進む", action: "save" }]));
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(views[1].state.doc.line(4).text).toBe("3  続ける  次へ進む");
    act(() => handles[1].replace(1, 2, []));
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(views[1].state.doc.toString()).toBe(
      "本文\n1  削除  内容を削除する\n2  続ける  次へ進む",
    );
  });
});

describe("別画面へのジャンプ", () => {
  it("開く処理が描画を待たなくても、新しい画面のバッファに位置を置く", async () => {
    const controller = new BufferController({ url: "/issues/i1" });
    const first = mount(controller, [{ kind: "text", text: "issue" }]);
    controller.jumps.push({ url: "/conversations/c1", window: "main", line: 2 });
    controller.options.navigate = () => {
      first.rerender(
        <Layout
          controller={controller}
          main={
            <Buffer
              key="conversation"
              side="main"
              lines={[
                { kind: "text", text: "一" },
                { kind: "text", text: "二" },
                { kind: "text", text: "三" },
              ]}
              onReady={() => {}}
            />
          }
        />,
      );
    };
    await act(async () => controller.jumpBack());
    const view = EditorView.findFromDOM(first.container.querySelector<HTMLElement>(".cm-editor")!)!;
    expect(view.state.doc.toString()).toBe("一\n二\n三");
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3);
  });
});

describe("バッファの検索から戻る", () => {
  it.each([
    ["Escape", false],
    ["[", true],
  ])("検索の入力中も %s は Esc と同じように閉じる", (escape, ctrlKey) => {
    const controller = new BufferController();
    const { views } = mount(controller);
    key(views[1], "/");
    const input = views[1].dom.querySelector<HTMLInputElement>(".cm-vim-panel input")!;
    expect(input).toBeInTheDocument();
    fireEvent.keyDown(input, { key: escape, ctrlKey });
    expect(views[1].dom.querySelector(".cm-vim-panel input")).toBeNull();
    expect(views[1].hasFocus).toBe(true);
  });
});

describe("主の表示の種類と操作対象", () => {
  it.each(["list", "table", "main"] as const)(
    "%s を論理 main として移動・復元する",
    async (side) => {
      const controller = new BufferController();
      const { views, handles } = mount(controller, lines, { side, right: true });
      const [tree, main, right] = views;
      expect(controller.context()).toEqual({ window: "main", view: side, line: 0 });
      key(main, "w", true);
      key(main, "h");
      expect(tree.hasFocus).toBe(true);
      key(tree, "w", true);
      key(tree, "l");
      expect(main.hasFocus).toBe(true);
      expect(
        screen
          .getByRole("region", { name: "会話" })
          .querySelector("h2")
          ?.parentElement?.classList.contains("font-bold"),
      ).toBe(true);
      key(main, "w", true);
      key(main, "l");
      expect(right.hasFocus).toBe(true);
      key(right, "q");
      expect({ focus: main.hasFocus, active: controller.snapshot().active }).toEqual({
        focus: true,
        active: "main",
      });
      key(main, "w", true);
      key(main, "l");
      expect(main.hasFocus).toBe(true);
      act(() => handles[1].pushJump(2));
      key(main, "o", true);
      expect(main.state.doc.lineAt(main.state.selection.main.head).number).toBe(3);
      expect(controller.positions.position(`/:main:${side}`)).toEqual({
        line: 2,
        column: 0,
        topLine: 0,
      });
      act(() =>
        controller.openPrompt({
          label: "指示",
          target: "会話",
          verb: "送る",
          submit: vi.fn(),
          close: vi.fn(),
        }),
      );
      const prompt = EditorView.findFromDOM(screen.getByRole("textbox", { name: "指示" }))!;
      key(prompt, "Escape");
      key(prompt, "w", true);
      key(prompt, "k");
      expect({ focus: main.hasFocus, active: controller.snapshot().active }).toEqual({
        focus: true,
        active: "main",
      });
      act(() => tree.focus());
      fireEvent.mouseDown(screen.getByRole("heading", { name: "会話" }));
      expect({ focus: main.hasFocus, active: controller.snapshot().active }).toEqual({
        focus: true,
        active: "main",
      });
    },
  );
  it.each(["new", "different", "same"])("右の %s 表示は実フォーカスと保存対象を揃える", (kind) => {
    const controller = new BufferController();
    const { views, container } = mount(controller, lines, { right: kind !== "new" });
    if (kind !== "new") act(() => controller.openRight({ view: "toc", target: "c1" }));
    act(() => views[1].focus());
    act(() => controller.openRight({ view: kind === "different" ? "stock" : "toc", target: "c1" }));
    const right = EditorView.findFromDOM(container.querySelectorAll<HTMLElement>(".cm-editor")[2])!;
    expect({
      focus: right.hasFocus,
      active: controller.snapshot().active,
      saved: controller.positions.active(),
      mode: controller.snapshot().mode,
    }).toEqual({ focus: true, active: "right", saved: "right", mode: "NORMAL" });
  });
});

describe("Vim が待つ文字とアプリの先頭キー", () => {
  it.each(
    ["f", "t"].flatMap((motion) =>
      ["d", "c", "[", "]", "z", "g", " "].map((target) => ({ motion, target })),
    ),
  )("$motion の次の $target を直ちに Vim に渡す", ({ motion, target }) => {
    const controller = new BufferController();
    for (const name of [
      "item.delete",
      "item.edit",
      "mark.prev",
      "mark.next",
      "diff.expand",
      "files.open-path",
    ])
      register(controller, name);
    const { views } = mount(controller, [{ kind: "text", text: `ab${target} tail` }]);
    key(views[1], motion);
    key(views[1], target);
    expect({
      cursor: views[1].state.selection.main.head,
      prefix: controller.snapshot().prefix,
    }).toEqual({ cursor: motion === "f" ? 2 : 1, prefix: "" });
  });
  it.each([
    ["d", "d", "item.delete"],
    ["c", "c", "item.edit"],
    ["[", "c", "mark.prev"],
  ])("アプリの %s%s はその動作を呼ぶ", (first, second, name) => {
    const controller = new BufferController();
    const run = register(controller, name);
    const { views } = mount(controller);
    key(views[1], first);
    key(views[1], second);
    expect(run).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().prefix).toBe("");
  });
});

const shiftedMappings = Array.from({ length: 8 }, (_, mask) => ({
  keys: `<${mask & 1 ? "C-" : ""}${mask & 2 ? "A-" : ""}${mask & 4 ? "M-" : ""}S-a>`,
  event: {
    key: "A",
    ctrlKey: Boolean(mask & 1),
    altKey: Boolean(mask & 2),
    metaKey: Boolean(mask & 4),
    shiftKey: true,
  },
}));
const lessThanMappings = Array.from({ length: 8 }, (_, mask) => ({
  keys: `<${mask & 1 ? "C-" : ""}${mask & 2 ? "A-" : ""}${mask & 4 ? "M-" : ""}lt>`,
  event: {
    key: "<",
    code: "Comma",
    ctrlKey: Boolean(mask & 1),
    altKey: Boolean(mask & 2),
    metaKey: Boolean(mask & 4),
    shiftKey: true,
  },
}));
const shiftedSpecialMappings = [
  ["CR", "Enter"],
  ["Left", "ArrowLeft"],
  ["Space", " "],
].flatMap(([name, key]) =>
  Array.from({ length: 8 }, (_, mask) => ({
    keys: `<${mask & 1 ? "C-" : ""}${mask & 2 ? "A-" : ""}${mask & 4 ? "M-" : ""}S-${name}>`,
    event: {
      key,
      ctrlKey: Boolean(mask & 1),
      altKey: Boolean(mask & 2),
      metaKey: Boolean(mask & 4),
      shiftKey: true,
    },
  })),
);
const specialMappings = [
  ["Space", " "],
  ["CR", "Enter"],
  ["Esc", "Escape"],
  ["Tab", "Tab"],
  ["BS", "Backspace"],
  ["Del", "Delete"],
  ["Up", "ArrowUp"],
  ["Down", "ArrowDown"],
  ["Left", "ArrowLeft"],
  ["Right", "ArrowRight"],
  ["Home", "Home"],
  ["End", "End"],
  ["lt", "<"],
].map(([name, key]) => ({ keys: `<${name}>`, event: { key } }));
describe("保存した記法で動作を呼ぶ", () => {
  it.each([
    ...specialMappings,
    ...shiftedMappings,
    ...lessThanMappings,
    ...lessThanMappings.map(({ keys, event }) => ({ keys: keys.replace("lt>", "S-lt>"), event })),
    ...shiftedSpecialMappings,
    {
      keys: "<S-A-M-C-a>",
      event: { key: "A", ctrlKey: true, altKey: true, metaKey: true, shiftKey: true },
    },
  ])("$keys の設定を読み直して実際のキー入力で実行する", async ({ keys, event }) => {
    const controller = new BufferController({
      keymap: {
        load: async () => ({
          version: 1,
          entries: [{ keys, context: "normal", to: { action: "test.run" } }],
        }),
        save: vi.fn(),
        subscribe: () => () => {},
      },
    });
    const run = register(controller, "test.run");
    const { views } = mount(controller);
    await act(async () => {});
    key(views[1], event.key, Boolean("ctrlKey" in event && event.ctrlKey), event);
    expect(run).toHaveBeenCalledTimes(1);
    expect(getCM(views[1])?.state.vim?.inputState.keyBuffer).toEqual([]);
  });
});
