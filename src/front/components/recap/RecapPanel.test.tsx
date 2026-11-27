import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { expect, it, vi } from "vite-plus/test";
import { BufferController } from "../../buffer/controller";
import { Layout } from "../../buffer/Layout";
import { ConversationSession } from "../../lib/conversation/session";
import { createConversationApi, ConversationApiError } from "../../lib/conversation/api";
import { RecapSession } from "../../lib/recap/session";
import type { RecapApi } from "../../lib/recap/api";
import type { Event, Snapshot } from "../../lib/conversation/types";
import type { DecisionsResponse, RecapResponse, TocResponse } from "../../../shared/recap/api";
import { ConversationPage } from "../../pages/conversation/ConversationPage";
import { RecapPanel } from "./RecapPanel";

const state = { reflectedSeq: 5, failedAt: null, updating: false };
const events: Event[] = [
  {
    seq: 1,
    createdAt: 1,
    type: "user_message",
    payload: { text: "前の指示", images: [], origin: "developer" },
  },
  {
    seq: 2,
    createdAt: 2,
    type: "assistant_text",
    payload: { text: "前の回答", parent_tool_use_id: null },
  },
  {
    seq: 3,
    createdAt: 3,
    type: "user_message",
    payload: { text: "最後の指示", images: [], origin: "developer" },
  },
  {
    seq: 4,
    createdAt: 4,
    type: "assistant_text",
    payload: { text: "APIを使います。\nどうしますか?", parent_tool_use_id: null },
  },
  {
    seq: 5,
    createdAt: 5,
    type: "assistant_text",
    payload: { text: "保留の根拠", parent_tool_use_id: null },
  },
];
const snapshot: Snapshot = {
  conversation: {
    id: "c",
    projectId: "p",
    projectName: "p",
    title: "再開",
    kind: "chat",
    issueId: null,
    parentConversationId: null,
    cwd: "/p",
    worktree: null,
    runState: "idle",
    stopReason: null,
    resetsAt: null,
    lastSeq: 5,
    lastReadSeq: 3,
    lastPosition: 2,
    closedAt: null,
  },
  draft: null,
  queue: [],
  pendingAnswers: null,
  pendingPermission: null,
  commands: [],
};
const recent: RecapResponse = {
  lastUserMessage: { seq: 3, text: "最後の指示" },
  questions: [{ id: "q", seq: 4, kind: "text", text: "どうしますか?" }],
  pendingPermission: null,
  draft: { exists: true },
  counts: { stock: 2, threads: 1, activeThreads: 1, queue: 1 },
  lastReadSeq: 3,
  lastPosition: 2,
  state,
};
const toc: TocResponse = {
  chapters: [
    {
      position: 1,
      title: "APIの整理",
      startSeq: 1,
      endSeq: 3,
      decisions: [{ id: "D1", text: "APIを使う" }],
    },
    { position: 2, title: "実装", startSeq: 4, endSeq: null, decisions: [] },
  ],
  state,
};
const decisions: DecisionsResponse = {
  exists: true,
  path: "docs/decisions/c.md",
  hash: "h",
  state,
  items: [
    { id: "D1", kind: "decision", text: "APIを使う", reason: null, seq: 4, changedTo: null },
    { id: "D2", kind: "rejected", text: "新規認証", reason: "既存を使う", seq: 2, changedTo: null },
    { id: "D3", kind: "pending", text: "期限", reason: null, seq: 5, changedTo: null },
  ],
};
async function flush() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}
function editor(name: string) {
  return EditorView.findFromDOM(screen.getByRole("region", { name }).querySelector(".cm-editor")!)!;
}
function selected(view: EditorView) {
  return view.state.doc.lineAt(view.state.selection.main.head).text;
}
function key(view: EditorView, key: string, extra = {}) {
  act(() => {
    fireEvent.keyDown(view.contentDOM, { key, ...extra });
  });
}
function select(view: EditorView, text: string) {
  const line = Array.from({ length: view.state.doc.lines }, (_, i) =>
    view.state.doc.line(i + 1),
  ).find((line) => line.text === text)!;
  act(() => {
    view.focus();
    view.dispatch({ selection: { anchor: line.from } });
  });
}
async function mount(
  options: {
    lastReadSeq?: number;
    working?: boolean;
    fail?: boolean;
    memory?: Map<string, string>;
    api?: Partial<RecapApi>;
    events?: Event[];
    pendingPermission?: Snapshot["pendingPermission"];
    schedule?: (fn: () => void, ms: number) => () => void;
  } = {},
) {
  const data = structuredClone(snapshot);
  const loadedEvents = options.events ?? events;
  data.conversation.lastSeq = loadedEvents.at(-1)?.seq ?? 0;
  data.conversation.lastReadSeq = options.lastReadSeq ?? 3;
  data.conversation.runState = options.working ? "working" : "idle";
  if (options.pendingPermission) {
    data.pendingPermission = options.pendingPermission;
    data.conversation.runState = "waiting_permission";
  }
  const requests: unknown[] = [];
  const api: RecapApi = {
    recent: async () => recent,
    toc: async () => toc,
    decisions: async () => decisions,
    read: async (id, body, keepalive) => {
      requests.push({ id, body, keepalive });
    },
    patchToc: async (id, position, body) => {
      requests.push({ id, position, body });
      if (options.fail) throw new ConversationApiError(409, "conflict", "別の変更があります");
      return toc;
    },
    putDecisions: async (id, body) => {
      requests.push({ id, body });
      if (options.fail) throw new ConversationApiError(409, "conflict", "別の変更があります");
      return { ...decisions, items: body.items };
    },
    rebuild: async () => ({ state }),
    ...options.api,
  };
  const controller = new BufferController({ url: "/conversations/c" });
  const session = new ConversationSession(
    "c",
    createConversationApi(async (url) =>
      Response.json(
        (typeof url === "string" ? url : url instanceof URL ? url.href : url.url).includes(
          "/events",
        )
          ? { events: loadedEvents, hasMore: false, lastSeq: data.conversation.lastSeq }
          : data,
      ),
    ),
    controller,
    { clientId: "tab", id: () => "id", now: () => 1, schedule: () => () => {} },
  );
  const memory = options.memory ?? new Map<string, string>();
  const recap = new RecapSession(
    session,
    api,
    {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        memory.set(key, value);
      },
      removeItem: (key) => {
        memory.delete(key);
      },
    },
    options.schedule ?? (() => () => {}),
  );
  session.recap = recap;
  await session.load();
  const rendered = render(
    <StrictMode>
      <Layout
        controller={controller}
        main={<ConversationPage session={session} openAtTail />}
        renderRight={(view) => <RecapPanel key={view.view} recap={recap} view={view.view} />}
      />
    </StrictMode>,
  );
  await flush();
  return { controller, session, recap, requests, api, memory, data, unmount: rendered.unmount };
}
it.each([
  { lastReadSeq: 3, working: false, text: "APIを使います。", marker: true },
  { lastReadSeq: 5, working: false, text: "最後の指示", marker: false },
  { lastReadSeq: 3, working: true, text: "保留の根拠", marker: true },
  { lastReadSeq: 5, working: true, text: "保留の根拠", marker: false },
])(
  "開く条件を実Bufferのカーソルで確かめる $lastReadSeq/$working",
  async ({ lastReadSeq, working, text, marker }) => {
    const { controller } = await mount({ lastReadSeq, working });
    const view = editor("会話: 再開");
    expect(selected(view)).toBe(text);
    expect(
      view.state.doc
        .toString()
        .split("\n")
        .filter((line) => line === "ここから未読"),
    ).toEqual(marker ? ["ここから未読"] : []);
    await act(() => controller.jumpBack());
    expect(selected(view)).toBe("前の回答");
  },
);
it("質問を原文で並べ、質問・章・決定から本文へ移り、表示とジャンプの履歴で戻れる", async () => {
  const { controller } = await mount();
  expect(editor("直近").state.doc.toString()).toBe(
    "判断すること 1\nどうしますか?\n自分の最後の発言\n最後の指示\n書きかけ\n入力の書きかけ (i で続きを書く)\nストック 2 件\nスレッド 1 件 (動いているもの 1 件)\n届く前の指示 1 件\n遡る\n未読の先頭へ\n前回読んでいた位置へ\n目次\n決まったこと",
  );
  select(editor("直近"), "どうしますか?");
  key(editor("直近"), "Enter");
  await flush();
  expect(selected(editor("会話: 再開"))).toBe("どうしますか?");
  await act(() => controller.run("recap.toc"));
  await flush();
  expect(editor("目次").state.doc.toString()).toBe(
    "1 APIの整理\n決定: APIを使う\n2 実装  いまここ\n章の名前は AI が付けます。/ で検索できます。",
  );
  select(editor("目次"), "1 APIの整理");
  key(editor("目次"), "Enter");
  await flush();
  expect(selected(editor("会話: 再開"))).toBe("前の指示");
  await act(() => controller.run("recap.decisions"));
  await flush();
  expect(editor("決まったこと").state.doc.toString()).toBe(
    "決定: APIを使う\n採らなかった案: 新規認証 — 既存を使う\n保留: 期限\nリポジトリの docs/decisions/c.md に保存しています。",
  );
  select(editor("決まったこと"), "保留: 期限");
  key(editor("決まったこと"), "Enter");
  await flush();
  expect(selected(editor("会話: 再開"))).toBe("保留の根拠");
  await act(() => controller.jumpBack());
  expect(selected(editor("会話: 再開"))).toBe("前の指示");
});
it.each([false, true])(
  "ccはtoc PATCHとdecisions PUTを送り、409でも編集した入力を残す conflict=%s",
  async (fail) => {
    const { controller, requests } = await mount({ fail });
    await act(() => controller.run("recap.toc"));
    await flush();
    select(editor("目次"), "1 APIの整理");
    key(editor("目次"), "c");
    key(editor("目次"), "c");
    expect(controller.snapshot().prompt?.initialText).toBe("APIの整理");
    act(() => controller.setPromptDraft("新しい章"));
    await act(() => controller.submitPrompt("新しい章"));
    await flush();
    expect(requests.at(-1)).toEqual({
      id: "c",
      position: 1,
      body: { title: "新しい章", base: { title: "APIの整理", startSeq: 1 } },
    });
    expect(controller.snapshot().prompt?.label ?? null).toBe(fail ? "章の名前" : null);
    if (fail) {
      expect(controller.promptText()).toBe("新しい章");
      act(() => controller.closePrompt());
    }
    await act(() => controller.run("recap.decisions"));
    await flush();
    select(editor("決まったこと"), "保留: 期限");
    key(editor("決まったこと"), "c");
    key(editor("決まったこと"), "c");
    act(() => controller.setPromptDraft("決定: 明日"));
    await act(() => controller.submitPrompt("決定: 明日"));
    await flush();
    expect(requests.at(-1)).toEqual({
      id: "c",
      body: {
        baseHash: "h",
        items: [
          ...decisions.items.slice(0, 2),
          { ...decisions.items[2], kind: "decision", text: "明日" },
        ],
      },
    });
    if (fail) {
      expect(controller.promptText()).toBe("決定: 明日");
      act(() => controller.closePrompt());
    }
    act(() => controller.focus("right"));
    select(editor("決まったこと"), fail ? "保留: 期限" : "決定: 明日");
    key(editor("決まったこと"), "d");
    key(editor("決まったこと"), "d");
    await flush();
    expect(requests.at(-1)).toEqual({
      id: "c",
      body: { baseHash: "h", items: decisions.items.slice(0, 2) },
    });
  },
);

it("目次の/はステータス行で3種類を検索し、Ctrl+hで元の目次へ戻る", async () => {
  const { controller } = await mount();
  await act(() => controller.run("recap.toc"));
  await flush();
  const view = editor("目次");
  act(() => view.focus());
  key(view, "/");
  const search = screen.getByRole("textbox", { name: "検索" });
  fireEvent.change(search, { target: { value: "api" } });
  fireEvent.keyDown(search, { key: "Enter" });
  await flush();
  expect(editor("検索結果").state.doc.toString()).toBe(
    "章 1\nAPIの整理\n決まったこと 1\n決定: APIを使う\n本文 1\nAPIを使います。",
  );
  key(editor("検索結果"), "h", { ctrlKey: true });
  await flush();
  expect(editor("目次").state.doc.toString()).toBe(
    "1 APIの整理\n決定: APIを使う\n2 実装  いまここ\n章の名前は AI が付けます。/ で検索できます。",
  );
});

it("更新の配信を受けても、操作中の右のウィンドウからフォーカスを奪わない", async () => {
  const { controller, recap } = await mount();
  await act(() => controller.run("recap.toc"));
  await flush();
  act(() => editor("目次").focus());
  act(() => recap.changed());
  await flush();
  expect(controller.snapshot().active).toBe("right");
  expect(selected(editor("目次"))).toBe("1 APIの整理");
});
it("再読込は区切りを保ち、画面から離れてから開き直すと最後の発言に移り区切りが消える", async () => {
  const first = await mount();
  const memory = first.memory;
  first.unmount();
  const reload = await mount({ lastReadSeq: 5, memory });
  expect(selected(editor("会話: 再開"))).toBe("APIを使います。");
  expect(
    editor("会話: 再開")
      .state.doc.toString()
      .split("\n")
      .filter((line) => line === "ここから未読"),
  ).toEqual(["ここから未読"]);
  act(() => reload.recap.leave());
  reload.unmount();
  await mount({ lastReadSeq: 5, memory });
  expect(selected(editor("会話: 再開"))).toBe("最後の指示");
  expect(
    editor("会話: 再開")
      .state.doc.toString()
      .split("\n")
      .filter((line) => line === "ここから未読"),
  ).toEqual([]);
});

it("本文を移動した後の再検証はカーソルとジャンプの履歴を変えない", async () => {
  const { controller, session } = await mount();
  const view = editor("会話: 再開");
  select(view, "最後の指示");
  await act(() => session.load());
  await flush();
  expect(selected(view)).toBe("最後の指示");
  await act(() => controller.jumpBack());
  expect(selected(view)).toBe("前の回答");
});
it("区切りを動かすコマンドとdd/uは、APIに現在の基準値と編集後の項目を渡す", async () => {
  const { controller, requests } = await mount();
  select(editor("会話: 再開"), "保留の根拠");
  await act(() => controller.command("toc start 2"));
  await flush();
  expect(requests.at(-1)).toEqual({
    id: "c",
    position: 2,
    body: { startSeq: 5, base: { title: "実装", startSeq: 4 } },
  });
  await act(() => controller.run("recap.decisions"));
  await flush();
  select(editor("決まったこと"), "保留: 期限");
  key(editor("決まったこと"), "d");
  key(editor("決まったこと"), "d");
  await flush();
  key(editor("決まったこと"), "u");
  await flush();
  expect(requests.at(-1)).toEqual({ id: "c", body: { baseHash: "h", items: decisions.items } });
});
it("根拠のない項目は理由を知らせ、後で変わった項目は変わった先を表示する", async () => {
  const custom: DecisionsResponse = {
    ...decisions,
    items: [{ ...decisions.items[0], seq: null, changedTo: "D3" }, decisions.items[2]],
  };
  const { controller } = await mount({ api: { decisions: async () => custom } });
  await act(() => controller.run("recap.decisions"));
  await flush();
  const view = editor("決まったこと");
  expect(view.state.doc.toString()).toBe(
    "決定: APIを使う → 変わった先: 期限\n保留: 期限\nリポジトリの docs/decisions/c.md に保存しています。",
  );
  select(view, "決定: APIを使う → 変わった先: 期限");
  key(view, "Enter");
  await flush();
  expect(controller.snapshot().notice).toEqual({ message: "根拠の発言がありません", kind: "info" });
});

it("開いた直後の前回位置はStrictModeでも履歴に1回だけ積まれる", async () => {
  const { controller } = await mount();
  await act(() => controller.jumpBack());
  expect(selected(editor("会話: 再開"))).toBe("前の回答");
  expect(controller.positions.jumps()).toEqual([]);
});

it("章の名前が競合した後は、入力を保ったまま新しく読んだ基準値で再保存できる", async () => {
  const updates: unknown[] = [];
  let conflict = true;
  const latest: TocResponse = {
    ...toc,
    chapters: [{ ...toc.chapters[0], title: "別の端末の章" }, toc.chapters[1]],
  };
  const { controller } = await mount({
    api: {
      toc: async () => (conflict ? toc : latest),
      patchToc: async (_id, _position, body) => {
        updates.push(body);
        if (conflict) {
          conflict = false;
          throw new ConversationApiError(409, "conflict", "別の変更があります");
        }
        return latest;
      },
    },
  });
  await act(() => controller.run("recap.toc"));
  await flush();
  select(editor("目次"), "1 APIの整理");
  key(editor("目次"), "c");
  key(editor("目次"), "c");
  act(() => controller.setPromptDraft("保存したい章"));
  await act(() => controller.submitPrompt("保存したい章"));
  await flush();
  expect(controller.promptText()).toBe("保存したい章");
  await act(() => controller.submitPrompt("保存したい章"));
  expect(updates).toEqual([
    { title: "保存したい章", base: { title: "APIの整理", startSeq: 1 } },
    { title: "保存したい章", base: { title: "別の端末の章", startSeq: 1 } },
  ]);
});
it("改行を含む決定も各行から同じ根拠の発言へ移れる", async () => {
  const custom: DecisionsResponse = {
    ...decisions,
    items: [
      { ...decisions.items[0], text: "APIを使う\nこのまま進める" },
      ...decisions.items.slice(1),
    ],
  };
  const { controller } = await mount({ api: { decisions: async () => custom } });
  await act(() => controller.run("recap.decisions"));
  await flush();
  const view = editor("決まったこと");
  select(view, "このまま進める");
  key(view, "Enter");
  await flush();
  expect(selected(editor("会話: 再開"))).toBe("APIを使います。");
});

it("検索は畳んだ差分の後半も探し、開いた後にzcで畳んでも未読区切りの位置が保たれる", async () => {
  const diff: Event = {
    seq: 6,
    createdAt: 6,
    type: "diff",
    payload: {
      path: "src/api.ts",
      tool_use_id: "tool",
      truncated: false,
      change: "create",
      hunks: [],
      content: [...Array.from({ length: 30 }, (_, i) => `line${i}`), "needle"].join("\n"),
    },
  };
  const { controller } = await mount({ events: [...events, diff] });
  await act(() => controller.run("recap.toc"));
  await flush();
  act(() => editor("目次").focus());
  key(editor("目次"), "/");
  const search = screen.getByRole("textbox", { name: "検索" });
  fireEvent.change(search, { target: { value: "needle" } });
  fireEvent.keyDown(search, { key: "Enter" });
  await flush();
  expect(editor("検索結果").state.doc.toString()).toBe("章 0\n決まったこと 0\n本文 1\n31 +needle");
  select(editor("検索結果"), "31 +needle");
  key(editor("検索結果"), "Enter");
  await flush();
  const view = editor("会話: 再開");
  expect(selected(view)).toBe("31 +needle");
  key(view, "z");
  key(view, "c");
  await flush();
  expect(selected(view)).toBe("1  残り 21 行 (Enter か zo で開く)  ");
  expect(
    view.state.doc
      .toString()
      .split("\n")
      .filter((line) => line === "ここから未読"),
  ).toEqual(["ここから未読"]);
});

it.each([
  {
    beforeWorking: false,
    beforeRead: 5,
    working: true,
    lastReadSeq: 5,
    expected: "保留の根拠",
    marker: false,
  },
  {
    beforeWorking: true,
    beforeRead: 5,
    working: false,
    lastReadSeq: 3,
    expected: "APIを使います。",
    marker: true,
  },
])(
  "cached画面が最新loadより先にbindしても、最新の状態で一度だけ位置を決める $working/$lastReadSeq",
  async ({ beforeWorking, beforeRead, working, lastReadSeq, expected, marker }) => {
    const f = await mount({ working: beforeWorking, lastReadSeq: beforeRead });
    act(() => f.recap.leave());
    f.unmount();
    f.data.conversation.runState = working ? "working" : "idle";
    f.data.conversation.lastReadSeq = lastReadSeq;
    render(
      <StrictMode>
        <Layout
          controller={f.controller}
          main={<ConversationPage session={f.session} openAtTail />}
          renderRight={(view) => <RecapPanel key={view.view} recap={f.recap} view={view.view} />}
        />
      </StrictMode>,
    );
    await act(() => f.session.load());
    await flush();
    const main = editor("会話: 再開");
    expect(selected(main)).toBe(expected);
    expect(
      main.state.doc
        .toString()
        .split("\n")
        .filter((line) => line === "ここから未読"),
    ).toEqual(marker ? ["ここから未読"] : []);
    select(main, "前の回答");
    await act(() => f.session.load());
    await flush();
    expect(selected(main)).toBe("前の回答");
  },
);

const choices: Event = {
  seq: 6,
  createdAt: 6,
  type: "question",
  payload: {
    request_id: "choice",
    questions: ["どちらにしますか?", "どちらにしますか?"].map((question) => ({
      question,
      header: question,
      multi_select: false,
      options: [{ label: "はい", description: "使います" }],
    })),
  },
};

it.each([
  [0, "Q1. どちらにしますか?"],
  [1, "Q2. どちらにしますか?"],
] as const)("直近の選択式の質問%dから対応する本文へ移る", async (index, expected) => {
  await mount({
    events: [...events, choices],
    api: {
      recent: async () => ({
        ...recent,
        questions: choices.payload.questions.map((q, i) => ({
          id: "choice" + i,
          seq: choices.seq,
          kind: "choice" as const,
          text: q.question,
        })),
      }),
    },
  });
  const main = editor("会話: 再開");
  expect(main.state.doc.toString()).toContain(expected);
  const right = editor("直近");
  const row = right.state.doc.line(index + 2);
  expect(row.text).toBe(choices.payload.questions[index].question);
  act(() => {
    right.focus();
    right.dispatch({ selection: { anchor: row.from } });
  });
  key(right, "Enter");
  await flush();
  expect(selected(main)).toBe(expected);
});

it("目次を編集中に別タブから配信が届いても、元の章名との競合を検出する", async () => {
  const requests: unknown[] = [];
  let live = toc;
  const { controller, session } = await mount({
    api: {
      toc: async () => live,
      patchToc: async (_id, _position, request) => {
        requests.push(request);
        if (request.base.title !== live.chapters[0].title)
          throw new ConversationApiError(409, "conflict", "別の端末の変更があります");
        live = {
          ...live,
          chapters: [{ ...live.chapters[0], title: request.title! }, ...live.chapters.slice(1)],
        };
        return live;
      },
    },
  });
  await act(() => controller.run("recap.toc"));
  await flush();
  select(editor("目次"), "1 APIの整理");
  key(editor("目次"), "c");
  key(editor("目次"), "c");
  expect(controller.snapshot().prompt?.initialText).toBe("APIの整理");
  live = {
    ...toc,
    chapters: [{ ...toc.chapters[0], title: "別タブで改名" }, ...toc.chapters.slice(1)],
  };
  act(() =>
    session.receive({
      type: "changed",
      topic: "conversation:c",
      seq: 5,
      payload: { parts: ["recap"] },
    }),
  );
  await flush();
  expect(editor("目次").state.doc.toString()).toContain("別タブで改名");
  act(() => controller.setPromptDraft("自分の改名"));
  await act(() => controller.submitPrompt("自分の改名"));
  expect({
    requests,
    serverTitle: live.chapters[0].title,
    prompt: controller.snapshot().prompt?.label,
    input: controller.promptText(),
  }).toEqual({
    requests: [{ title: "自分の改名", base: { title: "APIの整理", startSeq: 1 } }],
    serverTitle: "別タブで改名",
    prompt: "章の名前",
    input: "自分の改名",
  });
});

it("決定を編集中に配信が届いても、元のファイルとの競合を検出する", async () => {
  const requests: unknown[] = [];
  let live = decisions;
  const { controller, session } = await mount({
    api: {
      decisions: async () => live,
      putDecisions: async (_id, request) => {
        requests.push(request);
        if (request.baseHash !== live.hash)
          throw new ConversationApiError(409, "conflict", "別の端末の変更があります");
        live = { ...live, hash: "mine", items: request.items };
        return live;
      },
    },
  });
  await act(() => controller.run("recap.decisions"));
  await flush();
  select(editor("決まったこと"), "保留: 期限");
  key(editor("決まったこと"), "c");
  key(editor("決まったこと"), "c");
  expect(controller.snapshot().prompt?.initialText).toBe("保留: 期限");
  live = {
    ...decisions,
    hash: "remote",
    items: [...decisions.items.slice(0, 2), { ...decisions.items[2], text: "別タブ更新" }],
  };
  act(() =>
    session.receive({
      type: "changed",
      topic: "conversation:c",
      seq: 5,
      payload: { parts: ["recap"] },
    }),
  );
  await flush();
  expect(editor("決まったこと").state.doc.toString()).toContain("別タブ更新");
  act(() => controller.setPromptDraft("決定: 自分の更新"));
  await act(() => controller.submitPrompt("決定: 自分の更新"));
  expect({
    requests,
    serverText: live.items[2].text,
    prompt: controller.snapshot().prompt?.label,
    input: controller.promptText(),
  }).toEqual({
    requests: [
      {
        baseHash: "h",
        items: [
          ...decisions.items.slice(0, 2),
          { ...decisions.items[2], kind: "decision", text: "自分の更新" },
        ],
      },
    ],
    serverText: "別タブ更新",
    prompt: "決まったこと",
    input: "決定: 自分の更新",
  });
});

it.each([false, true])("uは削除した項目だけを戻す 別タブから変更あり=%s", async (concurrent) => {
  let live = decisions;
  const { controller, session } = await mount({
    api: {
      decisions: async () => live,
      putDecisions: async (_id, request) => {
        if (request.baseHash !== live.hash)
          throw new ConversationApiError(409, "conflict", "別の端末の変更があります");
        live = { ...live, hash: request.baseHash + "next", items: request.items };
        return live;
      },
    },
  });
  await act(() => controller.run("recap.decisions"));
  await flush();
  select(editor("決まったこと"), "保留: 期限");
  key(editor("決まったこと"), "d");
  key(editor("決まったこと"), "d");
  await flush();
  expect(live.items.map((item) => item.id)).toEqual(["D1", "D2"]);
  const remoteFirst = { ...decisions.items[0], text: "別タブで直した決定" };
  const remoteFourth = { ...decisions.items[0], id: "D4", text: "別タブで足した決定" };
  if (concurrent) {
    live = { ...live, hash: "remote", items: [remoteFirst, live.items[1], remoteFourth] };
    act(() =>
      session.receive({
        type: "changed",
        topic: "conversation:c",
        seq: 5,
        payload: { parts: ["recap"] },
      }),
    );
    await flush();
    expect(editor("決まったこと").state.doc.toString()).toContain("別タブで足した決定");
  }
  key(editor("決まったこと"), "u");
  await flush();
  expect(live.items.find((item) => item.id === "D3")).toEqual(decisions.items[2]);
  expect(live.items.filter((item) => item.id !== "D3")).toEqual(
    concurrent ? [remoteFirst, decisions.items[1], remoteFourth] : decisions.items.slice(0, 2),
  );
});

it.each([false, true])("検索中に閉じた右ウィンドウは開き直さない 閉じる=%s", async (closeRight) => {
  let postpone = false;
  let finish!: (data: DecisionsResponse) => void;
  const { controller } = await mount({
    api: {
      decisions: async () =>
        postpone
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : decisions,
    },
  });
  await act(() => controller.run("recap.toc"));
  await flush();
  act(() => editor("目次").focus());
  key(editor("目次"), "/");
  const search = screen.getByRole("textbox", { name: "検索" });
  fireEvent.change(search, { target: { value: "api" } });
  postpone = true;
  fireEvent.keyDown(search, { key: "Enter" });
  expect(finish).toBeTypeOf("function");
  if (closeRight) key(editor("目次"), "q");
  if (closeRight) expect(screen.queryByRole("region", { name: "目次" })).toBeNull();
  act(() => finish(decisions));
  await flush();
  expect(controller.right.current).toEqual(
    closeRight ? null : { view: "recap-search", target: "c" },
  );
});

it("toc startが競合後の再試行にも失敗したら入力と元の対象の行を残す", async () => {
  const requests: Parameters<RecapApi["patchToc"]>[2][] = [];
  let reads = 0;
  let reject!: (error: Error) => void;
  const remote = { ...toc.chapters[1], title: "別タブの実装" };
  const { controller } = await mount({
    api: {
      toc: async () => {
        reads++;
        return reads === 1 ? toc : { ...toc, chapters: [toc.chapters[0], remote] };
      },
      patchToc: async (_id, _position, body) => {
        requests.push(body);
        if (requests.length === 1)
          return new Promise<TocResponse>((_resolve, fail) => {
            reject = fail;
          });
        if (requests.length === 2)
          throw new ConversationApiError(500, "internal", "目次を保存できませんでした");
        return toc;
      },
    },
  });
  const main = editor("会話: 再開");
  select(main, "保留の根拠");
  act(() => controller.openCommand());
  const command = screen.getByRole("textbox", { name: "コマンド" });
  fireEvent.change(command, { target: { value: "toc start 2" } });
  fireEvent.keyDown(command, { key: "Enter" });
  await flush();
  select(main, "最後の指示");
  act(() => reject(new ConversationApiError(409, "conflict", "別の端末の変更があります")));
  await flush();
  const retry = screen.getByRole<HTMLInputElement>("textbox", { name: "コマンド" });
  expect(retry.value).toBe("toc start 2");
  expect(reads).toBe(2);
  expect(controller.snapshot().notice).toEqual({
    message: "別の端末の変更があります",
    kind: "error",
  });
  fireEvent.keyDown(retry, { key: "Enter" });
  await flush();
  const remaining = screen.getByRole<HTMLInputElement>("textbox", { name: "コマンド" });
  expect(remaining.value).toBe("toc start 2");
  expect(controller.snapshot().notice).toEqual({
    message: "目次を保存できませんでした",
    kind: "error",
  });
  fireEvent.keyDown(remaining, { key: "Enter" });
  await flush();
  expect(reads).toBe(2);
  expect(requests).toEqual([
    { startSeq: 5, base: { title: "実装", startSeq: 4 } },
    { startSeq: 5, base: { title: "別タブの実装", startSeq: 4 } },
    { startSeq: 5, base: { title: "別タブの実装", startSeq: 4 } },
  ]);
  expect(screen.queryByRole("textbox", { name: "コマンド" })).toBeNull();
});

it("toc startの競合応答が届いても、後から開いたコマンドを保つ", async () => {
  let reject!: (error: Error) => void;
  let reads = 0;
  const { controller } = await mount({
    api: {
      toc: async () => {
        reads++;
        return toc;
      },
      patchToc: async () =>
        new Promise<TocResponse>((_resolve, fail) => {
          reject = fail;
        }),
    },
  });
  select(editor("会話: 再開"), "保留の根拠");
  let saving!: Promise<void>;
  act(() => {
    saving = controller.command("toc start 2");
  });
  await flush();
  act(() => controller.openCommand("stop"));
  act(() => reject(new ConversationApiError(409, "conflict", "別の端末の変更があります")));
  await act(async () => saving);
  expect({
    input: screen.getByRole<HTMLInputElement>("textbox", { name: "コマンド" }).value,
    reads,
  }).toEqual({ input: "stop", reads: 2 });
});

it("保存に失敗したtoc startを取り消すと、次の同じコマンドは新しく選んだ行を使う", async () => {
  const starts: number[] = [];
  const { controller } = await mount({
    api: {
      patchToc: async (_id, _position, body) => {
        if (body.startSeq !== undefined) starts.push(body.startSeq);
        if (starts.length === 1) throw new Error("目次を保存できませんでした");
        return toc;
      },
    },
  });
  const main = editor("会話: 再開");
  select(main, "保留の根拠");
  act(() => controller.openCommand("toc start 2"));
  fireEvent.keyDown(screen.getByRole("textbox", { name: "コマンド" }), { key: "Enter" });
  await flush();
  const draft = screen.getByRole<HTMLInputElement>("textbox", { name: "コマンド" });
  expect(draft.value).toBe("toc start 2");
  fireEvent.keyDown(draft, { key: "Escape" });
  expect(screen.queryByRole("textbox", { name: "コマンド" })).toBeNull();

  select(main, "APIを使います。");
  act(() => controller.openCommand("toc start 2"));
  fireEvent.keyDown(screen.getByRole("textbox", { name: "コマンド" }), { key: "Enter" });
  await flush();
  expect(starts).toEqual([5, 4]);
  expect(screen.queryByRole("textbox", { name: "コマンド" })).toBeNull();
});

it("最初の目次取得に失敗しても、再試行で最初に選んだ行を章の始まりにする", async () => {
  const writes: unknown[] = [];
  let reads = 0;
  const chapter = { ...toc.chapters[1], title: "読み直した章" };
  const next = { ...toc, chapters: [toc.chapters[0], chapter] };
  const { controller } = await mount({
    api: {
      toc: async () => {
        reads++;
        if (reads === 1)
          throw new ConversationApiError(500, "internal", "目次を読み込めませんでした");
        return next;
      },
      patchToc: async (_id, position, body) => {
        writes.push({ position, body });
        return next;
      },
    },
  });
  const main = editor("会話: 再開");
  select(main, "保留の根拠");
  key(main, ":");
  const command = screen.getByRole("textbox", { name: "コマンド" });
  fireEvent.change(command, { target: { value: "toc start 2" } });
  fireEvent.keyDown(command, { key: "Enter" });
  await flush();
  expect(reads).toBe(1);
  expect(writes).toEqual([]);
  expect(controller.snapshot().notice).toEqual({
    message: "目次を読み込めませんでした",
    kind: "error",
  });
  const retry = screen.getByRole<HTMLInputElement>("textbox", { name: "コマンド" });
  expect(retry.value).toBe("toc start 2");

  select(main, "APIを使います。");
  expect(selected(main)).toBe("APIを使います。");
  fireEvent.keyDown(retry, { key: "Enter" });
  await flush();
  expect(reads).toBe(2);
  expect(writes).toEqual([
    { position: 2, body: { startSeq: 5, base: { title: "読み直した章", startSeq: 4 } } },
  ]);
  expect(screen.queryByRole("textbox", { name: "コマンド" })).toBeNull();
});

it.each([
  { input: "toc start no", reads: 0, message: "使い方: :toc start <章の番号>" },
  { input: "toc start 0", reads: 0, message: "章か本文の行を選んでください" },
  { input: "toc start 9", reads: 1, message: "章か本文の行を選んでください" },
])("$input は書き込まず、再試行の入力を出さない", async ({ input, reads, message }) => {
  const readToc = vi.fn(async () => toc);
  const writeChapter = vi.fn(async () => toc);
  const { controller } = await mount({ api: { toc: readToc, patchToc: writeChapter } });
  select(editor("会話: 再開"), "保留の根拠");
  act(() => controller.openCommand(input));
  fireEvent.keyDown(screen.getByRole("textbox", { name: "コマンド" }), { key: "Enter" });
  await flush();
  expect(readToc).toHaveBeenCalledTimes(reads);
  expect(writeChapter).not.toHaveBeenCalled();
  expect(controller.snapshot().notice).toEqual({ message, kind: "error" });
  expect(screen.queryByRole("textbox", { name: "コマンド" })).toBeNull();
});

it("最初の目次取得が遅れて失敗しても、次の会話にコマンドを出さない", async () => {
  let reject!: (error: Error) => void;
  const { controller } = await mount({
    api: {
      toc: () =>
        new Promise<TocResponse>((_resolve, fail) => {
          reject = fail;
        }),
    },
  });
  select(editor("会話: 再開"), "保留の根拠");
  let command!: Promise<void>;
  act(() => {
    command = controller.command("toc start 2");
  });
  expect(reject).toBeTypeOf("function");
  act(() => controller.changeScreen("/conversations/other"));
  await act(async () => {
    reject(new ConversationApiError(500, "internal", "目次を読み込めませんでした"));
    await command;
  });
  expect(controller.snapshot()).toMatchObject({ command: null, notice: null });
});

it("目次を読み直せない間は送信を保留し、読み直せた章で元の行を保存する", async () => {
  const requests: Parameters<RecapApi["patchToc"]>[2][] = [];
  let reads = 0;
  const current = { ...toc.chapters[1], title: "更新済みの章" };
  const { controller } = await mount({
    api: {
      toc: async () => {
        reads++;
        if (reads === 1) return toc;
        if (reads <= 3) throw new Error("目次を読み直せませんでした");
        return { ...toc, chapters: [toc.chapters[0], current] };
      },
      patchToc: async (_id, _position, body) => {
        requests.push(body);
        if (requests.length === 1)
          throw new ConversationApiError(409, "conflict", "別の端末の変更があります");
        return toc;
      },
    },
  });
  select(editor("会話: 再開"), "保留の根拠");
  act(() => controller.openCommand("toc start 2"));
  fireEvent.keyDown(screen.getByRole("textbox", { name: "コマンド" }), { key: "Enter" });
  await flush();
  select(editor("会話: 再開"), "APIを使います。");
  fireEvent.keyDown(screen.getByRole("textbox", { name: "コマンド" }), { key: "Enter" });
  await flush();
  expect(requests).toEqual([{ startSeq: 5, base: { title: "実装", startSeq: 4 } }]);
  const draft = screen.getByRole<HTMLInputElement>("textbox", { name: "コマンド" });
  expect(draft.value).toBe("toc start 2");
  fireEvent.keyDown(draft, { key: "Enter" });
  await flush();
  expect(requests).toEqual([
    { startSeq: 5, base: { title: "実装", startSeq: 4 } },
    { startSeq: 5, base: { title: "更新済みの章", startSeq: 4 } },
  ]);
  expect(screen.queryByRole("textbox", { name: "コマンド" })).toBeNull();
});

const pending: NonNullable<Snapshot["pendingPermission"]> = {
  requestId: "permission",
  seq: 6,
  toolName: "Write",
  summary: "docs/a.md",
};
const permission: Event = {
  seq: pending.seq,
  createdAt: 6,
  type: "permission_request",
  payload: {
    request_id: pending.requestId,
    tool_name: pending.toolName,
    input: {},
    title: pending.summary,
  },
};
it("直近の許可の確認から本文の対応する行へ移る", async () => {
  const { controller } = await mount({
    events: [...events, permission],
    pendingPermission: pending,
    api: { recent: async () => ({ ...recent, pendingPermission: pending }) },
  });
  const expected = "許可の確認: Write(docs/a.md)";
  const right = editor("直近");
  const main = editor("会話: 再開");
  expect(main.state.doc.toString()).toContain(expected);
  expect(selected(main)).toBe("APIを使います。");
  select(right, expected);
  key(right, "Enter");
  await flush();
  expect({ position: selected(main), focused: controller.snapshot().active }).toEqual({
    position: expected,
    focused: "main",
  });
});
it("未読の許可の確認から開き、右に直近を表示する", async () => {
  const { controller } = await mount({
    lastReadSeq: 5,
    events: [...events, permission],
    pendingPermission: pending,
    api: { recent: async () => ({ ...recent, pendingPermission: pending }) },
  });
  const main = editor("会話: 再開");
  const expected = "許可の確認: Write(docs/a.md)";
  expect(main.state.doc.toString()).toContain(expected);
  expect({
    selected: selected(main),
    marker: main.state.doc.toString().includes("ここから未読"),
    right: controller.right.current,
  }).toEqual({ selected: expected, marker: true, right: { view: "recent", target: "c" } });
});

it.each(["表示切替", "目次の再作成"])(
  "%sの応答待ちにqで閉じた右ウィンドウは開き直さない",
  async (operation) => {
    let finish!: () => void;
    const { controller } = await mount({
      api: {
        toc: async () =>
          operation === "目次の再作成" ? { ...toc, state: { ...state, failedAt: 10 } } : toc,
        decisions: async () =>
          new Promise((resolve) => {
            finish = () => resolve(decisions);
          }),
        rebuild: async () =>
          new Promise((resolve) => {
            finish = () => resolve({ state });
          }),
      },
    });
    await act(() => controller.run("recap.toc"));
    await flush();
    const view = editor("目次");
    act(() => view.focus());
    if (operation === "目次の再作成") {
      expect(view.state.doc.toString()).toContain("1  目次を作り直す");
      key(view, "1");
      key(view, "Enter");
    } else {
      key(view, " ");
      key(view, "d");
    }
    expect(finish).toBeTypeOf("function");
    key(view, "q");
    expect(controller.right.current).toBeNull();
    act(() => finish());
    await flush();
    expect(controller.right.current).toBeNull();
  },
);

it.each([
  { operation: "同じ発言内の改行", row: 3, column: 0, text: "2行目" },
  { operation: "同じ行の1文字先", row: 2, column: 1, text: "1行目" },
])("$operation に移動してから2秒止まって位置を保存する", async ({ row, column, text }) => {
  const { requests } = await mount({
    lastReadSeq: 1,
    events: [
      {
        seq: 1,
        createdAt: 1,
        type: "user_message",
        payload: { text: "1行目\n2行目", images: [], origin: "developer" },
      },
    ],
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
  });
  vi.useFakeTimers();
  try {
    const main = editor("会話: 再開");
    act(() => {
      main.dispatch({ selection: { anchor: main.state.doc.line(2).from + 2 } });
    });
    act(() => {
      vi.advanceTimersByTime(1800);
    });
    const line = main.state.doc.line(row);
    act(() => {
      main.dispatch({ selection: { anchor: line.from + column } });
    });
    expect(selected(main)).toBe(text);
    expect(main.state.selection.main.head - line.from).toBe(column);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const positions = () =>
      requests.filter(
        (request) =>
          request &&
          typeof request === "object" &&
          "body" in request &&
          request.body &&
          typeof request.body === "object" &&
          "position" in request.body,
      );
    expect(positions()).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(1800);
    });
    expect(positions()).toEqual([{ id: "c", body: { position: 1 }, keepalive: false }]);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  { heading: "許可の確認: Write(docs/a.md)", target: "許可する", event: permission },
  { heading: "許可の確認: Write(docs/a.md)", target: "拒否する", event: permission },
  {
    heading: "Q1. どちらにしますか?",
    target: "回答をまとめて送る",
    event: choices,
  },
])("$target に移動してから2秒で、対応するイベントの位置を保存する", async (item) => {
  const positions: unknown[] = [];
  await mount({
    events: [...events, item.event],
    pendingPermission: item.event.type === "permission_request" ? pending : undefined,
    api: {
      read: async (_id, body, keepalive) => {
        if (body.position !== undefined) positions.push({ position: body.position, keepalive });
      },
    },
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
  });
  vi.useFakeTimers();
  try {
    const main = editor("会話: 再開");
    select(main, "最後の指示");
    select(main, item.heading);
    act(() => {
      vi.advanceTimersByTime(1800);
    });
    const menu = main.state.doc
      .toString()
      .split("\n")
      .find((line) => line.includes(item.target))!;
    select(main, menu);
    expect(selected(main)).toContain(item.target);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(positions).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(1800);
    });
    expect(positions).toEqual([{ position: item.event.seq, keepalive: false }]);
  } finally {
    vi.useRealTimers();
  }
});

it("未記録の応答に移動したら位置送信を止め、記録の行に戻ると再開する", async () => {
  const positions: unknown[] = [];
  const { recap, session } = await mount({
    api: {
      read: async (_id, body, keepalive) => {
        if (body.position !== undefined) positions.push({ position: body.position, keepalive });
      },
    },
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
  });
  vi.useFakeTimers();
  try {
    const main = editor("会話: 再開");
    act(() => session.delta("入力中の回答"));
    select(main, "保留の根拠");
    act(() => {
      vi.advanceTimersByTime(1800);
    });
    select(main, "入力中の回答");
    expect(selected(main)).toBe("入力中の回答");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(positions).toEqual([]);

    select(main, "最後の指示");
    act(() => {
      vi.advanceTimersByTime(1800);
    });
    act(() => session.delta("の続き"));
    expect(selected(main)).toBe("最後の指示");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    select(main, "保留の根拠");
    act(() => recap.leave());
    expect(positions).toEqual([
      { position: 3, keepalive: false },
      { position: 5, keepalive: true },
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("再取得を待つ間に選んだ行と列を、未読区切りが挿入されても保つ", async () => {
  const f = await mount({ lastReadSeq: 5 });
  act(() => f.recap.leave());
  f.unmount();
  f.data.conversation.lastReadSeq = 3;
  render(
    <Layout
      controller={f.controller}
      main={<ConversationPage session={f.session} openAtTail />}
      renderRight={(view) => <RecapPanel key={view.view} recap={f.recap} view={view.view} />}
    />,
  );
  await flush();
  const main = editor("会話: 再開");
  select(main, "保留の根拠");
  act(() => {
    main.dispatch({ selection: { anchor: main.state.selection.main.head + 1 } });
  });
  await act(() => f.session.load());
  await flush();
  const selection = main.state.selection.main.head;
  const line = main.state.doc.lineAt(selection);
  const lines = main.state.doc.toString().split("\n");
  expect({
    text: line.text,
    column: selection - line.from,
    unread: lines[lines.indexOf("ここから未読") + 1],
  }).toEqual({ text: "保留の根拠", column: 1, unread: "APIを使います。" });
});

it("削除を戻すときは削除で外したリンクだけを戻し、別タブで書き換えたリンクを保つ", async () => {
  const [first, second, removed] = decisions.items;
  const last = { ...first, id: "D4", text: "別の決定" };
  const original = [
    { ...first, changedTo: removed.id },
    { ...second, changedTo: removed.id },
    { ...removed, changedTo: last.id },
    last,
  ];
  let current: DecisionsResponse = { ...decisions, items: original };
  const { controller, session } = await mount({
    api: {
      decisions: async () => current,
      putDecisions: async (_id, body) => {
        current = { ...current, items: body.items, hash: current.hash + "次" };
        return current;
      },
    },
  });
  await act(() => controller.run("recap.decisions"));
  await flush();
  const right = editor("決まったこと");
  select(right, "保留: 期限 → 変わった先: 別の決定");
  key(right, "d");
  key(right, "d");
  await flush();
  expect(current.items).toEqual([first, second, last]);
  const updated = { ...second, text: "別タブで直した案", changedTo: last.id };
  current = { ...current, hash: "remote", items: [first, updated, last] };
  act(() =>
    session.receive({
      type: "changed",
      topic: "conversation:c",
      seq: 5,
      payload: { parts: ["recap"] },
    }),
  );
  await flush();
  key(right, "u");
  await flush();
  expect(current.items).toEqual([original[0], updated, original[2], last]);
});
