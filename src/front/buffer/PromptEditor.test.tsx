import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { EditorView } from "@codemirror/view";
import { getCM } from "@replit/codemirror-vim";
import { Layout } from "./Layout";
import { Frame } from "./Frame";
import { Buffer } from "./Buffer";
import { BufferController, type PromptSpec } from "./controller";
import { createBrowserController } from "../lib/browser";
function mount(text: string, extra: Partial<PromptSpec> = {}) {
  const controller = new BufferController();
  const submit = vi.fn();
  const close = vi.fn();
  controller.openPrompt({
    label: "指示",
    target: "会話",
    verb: "送る",
    initialText: text,
    submit,
    close,
    ...extra,
  });
  const result = render(
    <StrictMode>
      <Layout controller={controller} main={<div>会話</div>} />
    </StrictMode>,
  );
  const editor = result.container.querySelector<HTMLElement>(".cm-editor")!;
  const view = EditorView.findFromDOM(editor)!;
  return { controller, submit, close, view };
}
function key(view: EditorView, key: string, ctrlKey = false, extra = {}) {
  act(() => {
    fireEvent.keyDown(view.contentDOM, { key, ctrlKey, ...extra });
  });
}

describe("入力欄", () => {
  it.each([
    ["Escape", false],
    ["[", true],
  ])("Insert から %s で Normal、Normal の Esc で閉じて書きかけを渡す", (escape, ctrl) => {
    const { view, controller, close } = mount("書きかけ");
    expect(getCM(view)?.state.vim?.insertMode).toBe(true);
    expect(view.state.selection.main.head).toBe(4);
    key(view, escape, ctrl);
    expect(getCM(view)?.state.vim?.insertMode).toBe(false);
    key(view, escape, ctrl);
    expect(controller.snapshot().prompt).toBeNull();
    expect(close.mock.calls).toEqual([["書きかけ"]]);
  });
  it("Normal の Enter で送る処理を呼び、Insert の Enter では改行する", async () => {
    const { view, submit, controller } = mount("本文");
    key(view, "Enter");
    expect(view.state.doc.toString()).toBe("本文\n");
    expect(submit.mock.calls).toEqual([]);
    key(view, "Escape");
    key(view, "Enter");
    await act(async () => {});
    expect(submit.mock.calls).toEqual([["本文\n"]]);
    expect(controller.snapshot().prompt).toBeNull();
  });
  it("空白だけなら欄を保ち、エラーを知らせる", async () => {
    const { view, submit, controller } = mount("  ");
    key(view, "Escape");
    key(view, "Enter");
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toBe("内容が空です。書いてから送ってください");
    expect(controller.snapshot().prompt?.label).toBe("指示");
    expect(submit.mock.calls).toEqual([]);
  });
  it("送信に失敗しても本文を残し、IME の Enter では送らない", async () => {
    const submit = vi.fn(async () => {
      throw new Error("送信できません");
    });
    const { view, controller } = mount("残す本文", { submit });
    key(view, "Escape");
    key(view, "Enter", false, { isComposing: true });
    expect(submit.mock.calls).toEqual([]);
    key(view, "Enter");
    await act(async () => {});
    expect(view.state.doc.toString()).toBe("残す本文");
    expect(controller.snapshot().prompt?.label).toBe("指示");
    expect(screen.getByRole("alert").textContent).toBe("送信できません");
  });
  it("/ で始まる一語は Tab で候補を順に入れ、ほかの本文では補完しない", () => {
    const { view } = mount("/de", { candidates: ["/dev-impl", "/dev-spec"] });
    key(view, "Tab");
    expect(view.state.doc.toString()).toBe("/dev-impl ");
    key(view, "Tab");
    expect(view.state.doc.toString()).toBe("/dev-spec ");
    key(view, "Tab");
    expect(view.state.doc.toString()).toBe("/dev-impl ");
    act(() =>
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "本文 /de" } }),
    );
    key(view, "Tab");
    expect(view.state.doc.toString()).toBe("本文 /de");
  });
});

describe("スキルの候補の表示", () => {
  it("Tabの循環と手入力の絞り込みで、本文と強調する候補が一致する", () => {
    const { view } = mount("/dev-", {
      commands: [
        { name: "/dev-a", description: "A" },
        { name: "/dev-b", description: "B" },
        { name: "/dev-c", description: "C" },
      ],
    });
    const highlighted = () =>
      [...screen.getByLabelText("スキルの候補").querySelectorAll(".text-accent")].map(
        (node) => node.textContent,
      );
    expect(highlighted()).toEqual(["/dev-a A"]);
    for (const name of ["a", "b", "c", "a"]) {
      key(view, "Tab");
      expect({ text: view.state.doc.toString(), selected: highlighted() }).toEqual({
        text: `/dev-${name} `,
        selected: [`/dev-${name} ${name.toUpperCase()}`],
      });
    }
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "/dev-b" } }));
    expect(highlighted()).toEqual(["/dev-b B"]);
    key(view, "Tab");
    expect({ text: view.state.doc.toString(), selected: highlighted() }).toEqual({
      text: "/dev-b ",
      selected: ["/dev-b B"],
    });
    expect(EditorView.findFromDOM(view.dom)).toBe(view);
  });
  it("普通の本文には候補を出さず、/ で始まる一語のときだけ出す", () => {
    const { view } = mount("普通の本文", { candidates: ["/dev-impl", "/dev-spec"] });
    expect(screen.queryByLabelText("スキルの候補")).toBeNull();
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "/de" } }));
    expect(screen.getByLabelText("スキルの候補").textContent).toBe("/dev-impl/dev-specTab で選ぶ");
  });
});

describe("入力欄の置き換え", () => {
  it("Normal で R を押すと REPLACE を表示し、Esc で Normal に戻る", () => {
    const { view, controller } = mount("本文");
    key(view, "Escape");
    key(view, "R");
    expect(controller.snapshot().mode).toBe("REPLACE");
    key(view, "Escape");
    expect(controller.snapshot().mode).toBe("NORMAL");
  });
});

describe("画面移動で入力欄を閉じる", () => {
  it.each(["navigate", "back", "forward", "jump"])(
    "%s は最新の本文を元の機能へ一度返す",
    async (path) => {
      window.history.replaceState({ sukunaDepth: 0 }, "", "/conversations/c1");
      window.sessionStorage.clear();
      const opened = vi.fn();
      const { controller, dispose } = createBrowserController(window, opened);
      const close = vi.fn();
      controller.openPrompt({
        label: "指示",
        target: "会話 c1",
        verb: "送る",
        initialText: "古い本文",
        submit: vi.fn(),
        close,
      });
      const result = render(
        <StrictMode>
          <Layout controller={controller} main={<div>会話</div>} />
        </StrictMode>,
      );
      const view = EditorView.findFromDOM(screen.getByRole("textbox", { name: "指示" }))!;
      act(() =>
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "最新の本文" } }),
      );
      await act(async () => {
        if (path === "navigate") await controller.navigate("/issues/i1");
        else if (path === "jump") {
          controller.jumps.push({ url: "/issues/i1", window: "main", line: 0 });
          await controller.jumpBack();
        } else {
          window.history.replaceState({ sukunaDepth: path === "back" ? 0 : 2 }, "", "/issues/i1");
          window.dispatchEvent(new PopStateEvent("popstate"));
        }
      });
      expect({
        prompt: controller.snapshot().prompt,
        closed: close.mock.calls,
        route: opened.mock.calls.at(-1),
      }).toEqual({ prompt: null, closed: [["最新の本文"]], route: [{ kind: "issue", id: "i1" }] });
      result.unmount();
      expect(close.mock.calls).toEqual([["最新の本文"]]);
      dispose();
      window.history.replaceState(null, "", "/");
      window.sessionStorage.clear();
    },
  );
  it("同じ画面のジャンプでは閉じず、送信成功後の破棄で書きかけを返さない", async () => {
    const { view, controller, close, submit } = mount("送る本文");
    controller.jumps.push({ url: "/", window: "main", line: 0 });
    await act(async () => controller.jumpBack());
    expect(controller.snapshot().prompt?.label).toBe("指示");
    expect(close.mock.calls).toEqual([]);
    key(view, "Escape");
    key(view, "Enter");
    await act(async () => {});
    expect(submit.mock.calls).toEqual([["送る本文"]]);
    expect(close.mock.calls).toEqual([]);
  });
});

describe("入力欄へ戻る操作", () => {
  it.each(
    ["tree", "main", "right"].flatMap((side) =>
      ["INSERT", "NORMAL", "VISUAL"].flatMap((mode) =>
        ["mouse", "keyboard"].map((via) => ({ side, mode, via })),
      ),
    ),
  )(
    "$side から $via で戻っても $mode を保ち、選択表示と復帰先を同期する",
    ({ side, mode, via }) => {
      const controller = new BufferController();
      const panel = (id: "tree" | "main" | "right") => (
        <Frame title={id} side={id}>
          <Buffer side={id} lines={[{ kind: "text", text: "本文" }]} onReady={() => {}} />
        </Frame>
      );
      render(
        <Layout
          controller={controller}
          tree={panel("tree")}
          main={panel("main")}
          right={panel("right")}
        />,
      );
      act(() =>
        controller.openPrompt({
          label: "指示",
          target: "会話",
          verb: "送る",
          initialText: "入力する本文",
          submit: vi.fn(),
          close: vi.fn(),
        }),
      );
      const view = EditorView.findFromDOM(screen.getByRole("textbox", { name: "指示" }))!;
      if (mode !== "INSERT") key(view, "Escape");
      if (mode === "VISUAL") key(view, "v");
      const frame = view.dom.closest(".rounded-lg")!;
      expect(frame.classList.contains("border-accent")).toBe(true);
      act(() => controller.focus(side));
      expect(frame.classList.contains("border-line")).toBe(true);
      act(() => {
        if (via === "mouse") view.focus();
        else controller.focus("prompt");
      });
      expect({
        focus: view.hasFocus,
        active: controller.snapshot().active,
        saved: controller.positions.active(),
        mode: controller.snapshot().mode,
      }).toEqual({ focus: true, active: "prompt", saved: "prompt", mode });
      expect(frame.classList.contains("border-accent")).toBe(true);
      if (mode === "INSERT" || mode === "VISUAL") key(view, "Escape");
      key(view, ":");
      fireEvent.keyDown(screen.getByRole("textbox", { name: "コマンド" }), { key: "Escape" });
      expect({
        focus: view.hasFocus,
        active: controller.snapshot().active,
        mode: controller.snapshot().mode,
      }).toEqual({ focus: true, active: "prompt", mode: "NORMAL" });
      expect(EditorView.findFromDOM(view.dom)).toBe(view);
    },
  );
});

describe("入力欄の所有と StrictMode", () => {
  function panels(controller: BufferController) {
    return (
      <StrictMode>
        <Layout
          controller={controller}
          main={
            <Frame title="会話" side="main">
              <Buffer side="main" lines={[{ kind: "text", text: "会話" }]} onReady={() => {}} />
            </Frame>
          }
          right={
            <Frame title="目次" side="right">
              <Buffer side="right" lines={[{ kind: "text", text: "目次" }]} onReady={() => {}} />
            </Frame>
          }
        />
      </StrictMode>
    );
  }
  it.each(["submit", "close"])("開いた欄を保持し、編集後に %s できる", async (finish) => {
    const controller = new BufferController();
    const submit = vi.fn();
    const close = vi.fn();
    const result = render(panels(controller));
    act(() => {
      controller.focus("main");
      controller.openPrompt({
        label: "指示",
        target: "会話",
        verb: "送る",
        initialText: "本文",
        submit,
        close,
      });
    });
    const view = EditorView.findFromDOM(screen.getByRole("textbox", { name: "指示" }))!;
    expect({
      text: view.state.doc.toString(),
      cursor: view.state.selection.main.head,
      insert: getCM(view)?.state.vim?.insertMode,
      closed: close.mock.calls,
    }).toEqual({ text: "本文", cursor: 2, insert: true, closed: [] });
    act(() =>
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "編集した本文" } }),
    );
    key(view, "Escape");
    key(view, finish === "submit" ? "Enter" : "Escape");
    await act(async () => {});
    expect({
      submitted: submit.mock.calls,
      closed: close.mock.calls,
      prompt: controller.snapshot().prompt,
      active: controller.snapshot().active,
      focus: screen.getByRole("region", { name: "会話" }).contains(document.activeElement),
    }).toEqual({
      submitted: finish === "submit" ? [["編集した本文"]] : [],
      closed: finish === "close" ? [["編集した本文"]] : [],
      prompt: null,
      active: "main",
      focus: true,
    });
    result.unmount();
    expect(close.mock.calls).toEqual(finish === "close" ? [["編集した本文"]] : []);
  });
  it("差し替え前に最新の本文を返し、新しい欄の本文・候補・モード・復帰先を初期化する", () => {
    const controller = new BufferController();
    const oldClose = vi.fn();
    const newClose = vi.fn();
    render(panels(controller));
    act(() => {
      controller.focus("main");
      controller.openPrompt({
        label: "旧欄",
        target: "会話",
        verb: "送る",
        initialText: "/old",
        candidates: ["/old-command"],
        submit: vi.fn(),
        close: oldClose,
      });
    });
    const oldView = EditorView.findFromDOM(screen.getByRole("textbox", { name: "旧欄" }))!;
    key(oldView, "Tab");
    act(() =>
      oldView.dispatch({
        changes: { from: 0, to: oldView.state.doc.length, insert: "最新の旧欄" },
      }),
    );
    key(oldView, "Escape");
    act(() => {
      controller.focus("right");
      controller.openPrompt({
        label: "新欄",
        target: "目次",
        verb: "決める",
        initialText: "/new",
        candidates: ["/new-command"],
        submit: vi.fn(),
        close: newClose,
      });
    });
    const newView = EditorView.findFromDOM(screen.getByRole("textbox", { name: "新欄" }))!;
    expect({
      oldClosed: oldClose.mock.calls,
      newClosed: newClose.mock.calls,
      text: newView.state.doc.toString(),
      cursor: newView.state.selection.main.head,
      insert: getCM(newView)?.state.vim?.insertMode,
      candidates: screen.getByLabelText("スキルの候補").textContent,
    }).toEqual({
      oldClosed: [["最新の旧欄"]],
      newClosed: [],
      text: "/new",
      cursor: 4,
      insert: true,
      candidates: "/new-commandTab で選ぶ",
    });
    key(newView, "Escape");
    key(newView, "Escape");
    expect({
      oldClosed: oldClose.mock.calls,
      newClosed: newClose.mock.calls,
      active: controller.snapshot().active,
      focus: screen.getByRole("region", { name: "目次" }).contains(document.activeElement),
    }).toEqual({
      oldClosed: [["最新の旧欄"]],
      newClosed: [["/new"]],
      active: "right",
      focus: true,
    });
  });
  it("入力欄から別の欄へ差し替えても元のウィンドウに戻る", () => {
    const controller = new BufferController();
    const oldClose = vi.fn();
    const newClose = vi.fn();
    render(panels(controller));
    act(() => {
      controller.focus("right");
      controller.openPrompt({
        label: "旧欄",
        target: "目次",
        verb: "送る",
        initialText: "旧本文",
        submit: vi.fn(),
        close: oldClose,
      });
    });
    act(() =>
      controller.openPrompt({
        label: "新欄",
        target: "目次",
        verb: "送る",
        initialText: "新本文",
        submit: vi.fn(),
        close: newClose,
      }),
    );
    const view = EditorView.findFromDOM(screen.getByRole("textbox", { name: "新欄" }))!;
    key(view, "Escape");
    key(view, "Escape");
    expect({
      oldClosed: oldClose.mock.calls,
      newClosed: newClose.mock.calls,
      active: controller.snapshot().active,
      focus: screen.getByRole("region", { name: "目次" }).contains(document.activeElement),
    }).toEqual({ oldClosed: [["旧本文"]], newClosed: [["新本文"]], active: "right", focus: true });
  });
  it("エディターを再生成しても欄の最新本文を維持する", () => {
    const controller = new BufferController();
    const close = vi.fn();
    const result = render(panels(controller));
    act(() => {
      controller.focus("main");
      controller.openPrompt({
        label: "指示",
        target: "会話",
        verb: "送る",
        initialText: "古い本文",
        submit: vi.fn(),
        close,
      });
    });
    const view = EditorView.findFromDOM(screen.getByRole("textbox", { name: "指示" }))!;
    act(() =>
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "最新の本文" } }),
    );
    result.unmount();
    render(panels(controller));
    const restored = EditorView.findFromDOM(screen.getByRole("textbox", { name: "指示" }))!;
    expect({ text: restored.state.doc.toString(), closed: close.mock.calls }).toEqual({
      text: "最新の本文",
      closed: [],
    });
    key(restored, "Escape");
    key(restored, "Escape");
    expect(close.mock.calls).toEqual([["最新の本文"]]);
  });
  it.each([false, true])(
    "旧欄の送信完了は差し替え後の欄を閉じない (同じspecの再利用: %s)",
    async (reuse) => {
      const controller = new BufferController();
      let resolve = () => {};
      const pending = new Promise<void>((done) => {
        resolve = done;
      });
      const submit = vi.fn(() => pending);
      const close = vi.fn();
      const spec = {
        label: "指示",
        target: "会話",
        verb: "送る",
        initialText: "送る本文",
        submit,
        close,
      };
      render(panels(controller));
      act(() => {
        controller.focus("main");
        controller.openPrompt(spec);
      });
      const oldView = EditorView.findFromDOM(screen.getByRole("textbox", { name: "指示" }))!;
      key(oldView, "Escape");
      key(oldView, "Enter");
      act(() => controller.openPrompt(reuse ? spec : { ...spec, initialText: "次の本文" }));
      const view = EditorView.findFromDOM(screen.getByRole("textbox", { name: "指示" }))!;
      act(() =>
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: "新しく編集した本文" },
        }),
      );
      await act(async () => resolve());
      expect({
        submitted: submit.mock.calls,
        closed: close.mock.calls,
        label: controller.snapshot().prompt?.label,
        text: screen.getByRole("textbox", { name: "指示" }).textContent,
      }).toEqual({
        submitted: [["送る本文"]],
        closed: [["送る本文"]],
        label: "指示",
        text: "新しく編集した本文",
      });
      key(view, "Escape");
      key(view, "Escape");
      expect(close.mock.calls).toEqual([["送る本文"], ["新しく編集した本文"]]);
    },
  );
});
