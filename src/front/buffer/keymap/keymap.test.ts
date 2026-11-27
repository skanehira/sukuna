import { describe, expect, it, vi } from "vite-plus/test";
import { displayKeys, parseKeys } from "./notation";
import { ActionRegistry, type ActionDef, type KeymapEntry } from "./registry";
import { resolveKeymap } from "./resolve";
import { findConflicts } from "./conflicts";
import { defaultKeymap } from "./defaults";
import { helpLines } from "../help-lines";
import { resolveHints } from "../hints";
import { CommandRegistry, executeCommand } from "../commands";

const action: ActionDef = {
  name: "stock.question",
  label: "質問",
  group: "質問と指示",
  where: "会話",
  run: () => undefined,
};

describe("キーの記法", () => {
  it.each([
    ["<Space>q", "Space q"],
    ["<C-w>h", "Ctrl+w h"],
    ["<CR>", "Enter"],
    ["<A-CR>", "Alt+Enter"],
    ["<Esc>", "Esc"],
  ])("%s を %s として表示する", (vim, label) => expect(displayKeys(vim)).toBe(label));
  it.each(["<broken>", "<C->", "<Space", ""])("読めない記法 %s を拒む", (keys) =>
    expect(parseKeys(keys)).toBeNull(),
  );
});

describe("今の割り当て", () => {
  it("設定で外したキーを取り除き、新しいキーをヒントとヘルプに出す", () => {
    const registry = new ActionRegistry();
    registry.register(action);
    const entries = resolveKeymap(defaultKeymap, [
      { keys: "<Space>q", context: "normal", to: null },
      { keys: "<Space>q", context: "visual", to: null },
      { keys: "Q", context: "normal", to: { action: action.name } },
    ]);
    expect(entries.some((entry) => entry.keys === "<Space>q" && entry.context === "normal")).toBe(
      false,
    );
    expect(resolveHints([[action.name, "質問する"]], entries, registry)).toEqual([
      ["Q", "質問する"],
    ]);
    expect(
      helpLines(entries, registry, new CommandRegistry()).filter((line) => line.kind === "pair"),
    ).toEqual([{ kind: "pair", text: "Q  質問  会話", cols: ["Q", "質問", "会話"] }]);
  });
  it("同じキー・先頭の重なり・Vim の組み込みキーを返す", () => {
    const registry = new ActionRegistry();
    registry.register(action);
    const existing: KeymapEntry = {
      keys: "<Space>sa",
      context: "normal",
      to: { action: action.name },
    };
    expect(
      findConflicts(
        [existing],
        { keys: "<Space>s", context: "normal", to: { action: action.name } },
        registry,
      ),
    ).toEqual([existing]);
    expect(findConflicts([existing], existing, registry)).toEqual([existing]);
    expect(
      findConflicts([], { keys: "j", context: "normal", to: { action: action.name } }, registry),
    ).toEqual([{ keys: "j", context: "normal", to: { keys: "j" } }]);
  });
  it("表示が重ならない動作どうしのキーは重なりに数えない", () => {
    const registry = new ActionRegistry();
    registry.register({ ...action, views: ["diff"] });
    registry.register({ ...action, name: "files.folder-open", views: ["files"] });
    expect(
      findConflicts(
        [{ keys: "zo", context: "normal", to: { action: action.name } }],
        { keys: "zo", context: "normal", to: { action: "files.folder-open" } },
        registry,
      ),
    ).toEqual([]);
  });
});

describe("コマンド", () => {
  it("無いコマンドの名前とヘルプの案内を知らせる", async () => {
    const notify = vi.fn();
    await executeCommand("missing", {
      actions: new ActionRegistry(),
      commands: new CommandRegistry(),
      notify,
      save: vi.fn(),
      quit: vi.fn(),
    });
    expect(notify.mock.calls).toEqual([
      ["コマンド :missing はありません。:h で一覧を見られます", "error"],
    ]);
  });
  it.each([
    ["map <broken> stock.question", "キーの書き方が読めません: <broken>"],
    ["map Q missing.action", "動作がありません: missing.action"],
    ["tmap <C-x> stock.question", "動作がありません: stock.question"],
  ])("%s は保存せず理由を知らせる", async (command, message) => {
    const actions = new ActionRegistry();
    actions.register(action);
    const notify = vi.fn();
    const save = vi.fn();
    await executeCommand(command, {
      actions,
      commands: new CommandRegistry(),
      notify,
      save,
      quit: vi.fn(),
    });
    expect(notify.mock.calls).toEqual([[message, "error"]]);
    expect(save.mock.calls).toEqual([]);
  });
  it("map は動作を追加し、unmap と tmap はそれぞれの context を保存する", async () => {
    const actions = new ActionRegistry();
    actions.register(action);
    actions.register({ ...action, name: "terminal.normal" });
    const save = vi.fn();
    const env = { actions, commands: new CommandRegistry(), notify: vi.fn(), save, quit: vi.fn() };
    for (const command of [
      "map Q stock.question",
      "unmap <Space>q",
      "tmap <C-x> terminal.normal",
      "tunmap <C-]>",
      "map J 5j",
    ])
      await executeCommand(command, env);
    expect(save.mock.calls).toEqual([
      [{ keys: "Q", context: "normal", to: { action: "stock.question" } }],
      [{ keys: "<Space>q", context: "normal", to: null }],
      [{ keys: "<C-x>", context: "terminal", to: { action: "terminal.normal" } }],
      [{ keys: "<C-]>", context: "terminal", to: null }],
      [{ keys: "J", context: "normal", to: { keys: "5j" } }],
    ]);
  });
});

const builtinKeys = [
  "h",
  "j",
  "k",
  "l",
  "w",
  "b",
  "e",
  "0",
  "^",
  "$",
  "gg",
  "G",
  "{",
  "}",
  "<C-d>",
  "<C-u>",
  "/",
  "?",
  "n",
  "N",
  "*",
  "f",
  "t",
  ";",
  ",",
  "v",
  "V",
  "<C-v>",
  "y",
  "iw",
  "aw",
  'i"',
  'a"',
  "i(",
  "a(",
];

describe("Vim のモードごとの重なり", () => {
  it.each(
    ["normal", "visual", "prompt", "terminal"].flatMap((context) =>
      builtinKeys.map((keys) => ({ context: context as KeymapEntry["context"], keys })),
    ),
  )("$context の $keys の重なりを返す", ({ context, keys }) => {
    const registry = new ActionRegistry();
    registry.register(action);
    const overlaps = context === "prompt" && /^[ia][w"(]$/.test(keys) ? [keys, keys[0]] : [keys];
    expect(findConflicts([], { keys, context, to: { action: action.name } }, registry)).toEqual(
      context === "terminal"
        ? []
        : overlaps.map((key) => ({ keys: key, context, to: { keys: key } })),
    );
  });
  it.each([
    ["prompt", "R", true],
    ["visual", "o", true],
    ["normal", "R", false],
    ["terminal", "o", false],
  ] as const)("%s の %s はモードに合う組み込みだけに重なる", (context, keys, conflict) => {
    const registry = new ActionRegistry();
    registry.register(action);
    expect(findConflicts([], { keys, context, to: { action: action.name } }, registry)).toEqual(
      conflict ? [{ keys, context, to: { keys } }] : [],
    );
  });
});

describe("Vim の右辺とキーの正規化", () => {
  it.each([".", "f.", "t.", "5j"])("%s を Vim のキー列として保存する", async (target) => {
    const save = vi.fn();
    const notify = vi.fn();
    await executeCommand(`map Q ${target}`, {
      actions: new ActionRegistry(),
      commands: new CommandRegistry(),
      notify,
      save,
      quit: vi.fn(),
    });
    expect({ saved: save.mock.calls, notice: notify.mock.calls }).toEqual({
      saved: [[{ keys: "Q", context: "normal", to: { keys: target } }]],
      notice: [],
    });
  });
  it("Shift と修飾キー順を保存・設定の取り消し・競合でも同じに扱う", async () => {
    const save = vi.fn();
    const actions = new ActionRegistry();
    actions.register(action);
    await executeCommand("map <S-M-A-C-a> stock.question", {
      actions,
      commands: new CommandRegistry(),
      notify: vi.fn(),
      save,
      quit: vi.fn(),
    });
    const canonical: KeymapEntry = {
      keys: "<C-A-M-A>",
      context: "normal",
      to: { action: action.name },
    };
    expect(save.mock.calls).toEqual([[canonical]]);
    const existing: KeymapEntry = { ...canonical, keys: "<M-S-A-C-a>" };
    expect(findConflicts([existing], canonical, actions)).toEqual([existing]);
    expect(resolveKeymap([existing], [{ ...canonical, to: null }])).toEqual([]);
  });
});
