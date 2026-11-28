import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import { SWRConfig } from "swr";
import type { IssueView } from "../../../shared/issue/schema";
import { BufferController } from "../../buffer/controller";
import { Layout } from "../../buffer/Layout";
import type { LifecycleFeed } from "../../components/lifecycle/use-lifecycle";
import { IssueApiError, type IssueApi } from "./issue-api";
import { IssueForm } from "./issue-form";
import { createIssueDraft, type IssueDraft, type IssueTabStorage } from "./issue-draft";
import { issueApi, issueView, tabStorage } from "./issue.test-support";

const noFeed = () => () => {};

function mount(
  issue: IssueView | null,
  overrides: Partial<IssueApi> = {},
  subscribe: LifecycleFeed = noFeed,
  shared?: { draft: IssueDraft; storage: IssueTabStorage },
) {
  const api = { ...issueApi(issue ?? issueView()), ...overrides };
  const storage = shared?.storage ?? tabStorage();
  const draft =
    shared?.draft ??
    (issue
      ? undefined
      : createIssueDraft(storage, "p", "issue-form", (input) => api.create("p", input)));
  let version = 0;
  const notify = vi.fn();
  const navigate = vi.fn();
  const controller = new BufferController({ notify, navigate, url: "/issues/i/edit" });
  const ui = render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <Layout
        controller={controller}
        main={
          <IssueForm
            api={api}
            controller={controller}
            initial={issue}
            positionKey="issue-form"
            project={{ id: "p", name: "reservation-api", confirmBeforeMergeDefault: true }}
            storage={storage}
            subscribe={subscribe}
            draft={draft}
            nextVersion={() => String(++version)}
            refreshListings={() => {}}
          />
        }
      />
    </SWRConfig>,
  );
  const editor = () =>
    EditorView.findFromDOM(ui.container.querySelector<HTMLElement>(".cm-editor")!)!;
  return { controller, notify, navigate, editor, draft, unmount: ui.unmount };
}

it("空の下書きに対する title_required を示して題名へ移る", async () => {
  const confirm = vi.fn(async () => {
    throw new IssueApiError("title_required", "題名を書いてから確定してください");
  });
  const { controller, notify, navigate } = mount(issueView({ title: "", state: "draft" }), {
    confirm,
  });
  await act(() => controller.run("issue.confirm"));
  expect(confirm).toHaveBeenCalledExactlyOnceWith("i");
  expect(notify).toHaveBeenCalledExactlyOnceWith("題名を書いてから確定してください", "error");
  expect(controller.currentLine()?.id).toBe("title");
  expect(navigate).not.toHaveBeenCalled();
});

it("確定済みの題名と本文は案内を添え、入力を開かない", async () => {
  const { controller } = mount(issueView());
  const guide = " (会話で AI に頼んで直します)";
  await screen.findByText("予約を確保する" + guide, { exact: true });
  expect(screen.getByText("在庫がある場合に確保する" + guide, { exact: true })).toBeVisible();
  act(() => controller.place("main", 1, 0));
  await act(() => controller.run("prompt.open"));
  expect(controller.snapshot().prompt).toBeNull();
  act(() => controller.place("main", 2, 0));
  await act(() => controller.run("prompt.open"));
  expect(controller.snapshot().prompt).toBeNull();
});

it("閉じた issue は全項目の代わりに再開を案内し、優先度の入力を開かない", async () => {
  const { controller } = mount(issueView({ state: "done", closedAt: 50 }));
  await waitFor(() => {
    expect(screen.getByText("閉じた issue は直せません。再開してから直します。")).toBeVisible();
  });
  act(() => controller.place("main", 5, 0));
  await act(() => controller.run("prompt.open"));
  expect(controller.snapshot().prompt).toBeNull();
});

it.each([
  { index: 3, label: "親", text: "親 issue", message: "親は issue の番号で書いてください" },
  {
    index: 5,
    label: "優先度",
    text: "大",
    message: "優先度は高・中・低のいずれかで書いてください",
  },
])("無効な $label をサーバーへ送らず入力欄に残す", async ({ index, label, text, message }) => {
  const issue = issueView({ state: "draft" });
  const update = vi.fn(async () => issue);
  const { controller, notify } = mount(issue, { update });
  act(() => controller.place("main", index, 0));
  await act(() => controller.run("prompt.open"));
  const input = await screen.findByRole("textbox", { name: label });
  act(() => {
    controller.replacePromptText(text);
  });
  await act(() => controller.submitPrompt(text));
  expect(update).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledExactlyOnceWith(message, "error");
  expect(input).toBeInTheDocument();
  expect(controller.promptText()).toBe(text);
});

it("保存せず閉じた本文を同じ項目で開き直すと、書きかけが戻る", async () => {
  const issue = issueView({ state: "draft" });
  const update = vi.fn(async () => issue);
  const { controller, editor } = mount(issue, { update });
  act(() => controller.place("main", 2, 0));
  fireEvent.keyDown(editor().contentDOM, { key: "Enter" });
  await screen.findByRole("textbox", { name: "本文" });
  act(() => controller.closePrompt("保存していない本文"));
  await act(() => controller.run("prompt.open"));
  expect(controller.snapshot().prompt?.initialText).toBe("保存していない本文");
  expect(update).not.toHaveBeenCalled();
});

it("最初の保存の応答を待つあいだの編集を残し、続けて保存しても下書きを増やさない", async () => {
  let finishCreate!: (issue: IssueView) => void;
  const created = new Promise<IssueView>((resolve) => {
    finishCreate = resolve;
  });
  const create = vi.fn(() => created);
  const update = vi.fn(async () => issueView({ title: "あとで続き", state: "draft" }));
  const { controller, navigate } = mount(null, { create, update });
  act(() => controller.place("main", 1, 0));
  await act(() => controller.run("prompt.open"));
  act(() => controller.replacePromptText("先に保存"));
  let saving: Promise<boolean> | undefined;
  act(() => {
    saving = controller.submitPrompt("先に保存");
  });
  act(() => controller.replacePromptText("あとで続き"));
  await act(async () => {
    finishCreate(issueView({ title: "先に保存", state: "draft" }));
    await saving;
  });
  expect(navigate).not.toHaveBeenCalled();
  expect(controller.snapshot().prompt?.label).toBe("題名");
  expect(controller.promptText()).toBe("あとで続き");
  await act(() => controller.submitPrompt("あとで続き"));
  expect(create).toHaveBeenCalledExactlyOnceWith("p", { title: "先に保存" });
  expect(update).toHaveBeenCalledExactlyOnceWith("i", { title: "あとで続き" });
});

it("最初の保存を待つ間に入力欄を閉じても、その下書きの編集 URL を使う", async () => {
  let finishCreate!: (issue: IssueView) => void;
  const created = new Promise<IssueView>((resolve) => {
    finishCreate = resolve;
  });
  const create = vi.fn(() => created);
  const { controller, navigate } = mount(null, { create });
  act(() => controller.place("main", 1, 0));
  await act(() => controller.run("prompt.open"));
  act(() => controller.replacePromptText("保存する題名"));
  let saving: Promise<boolean> | undefined;
  act(() => {
    saving = controller.submitPrompt("保存する題名");
  });
  act(() => controller.closePrompt());
  await act(async () => {
    finishCreate(issueView({ title: "保存する題名", state: "draft" }));
    await saving;
  });
  expect(navigate).toHaveBeenCalledExactlyOnceWith("/issues/i/edit", undefined, true);
  expect(create).toHaveBeenCalledExactlyOnceWith("p", { title: "保存する題名" });
});

it("先の PATCH の遅い応答で、別タブの保存と入力中の文章を上書きしない", async () => {
  let server = issueView({ title: "編集前の題名", state: "draft" });
  let finishUpdate!: (issue: IssueView) => void;
  const updated = new Promise<IssueView>((resolve) => {
    finishUpdate = resolve;
  });
  const update = vi.fn(() => updated);
  const get = vi.fn(async () => server);
  let receive: Parameters<LifecycleFeed>[1] | undefined;
  const { controller } = mount(server, { get, update }, (_topic, callback) => {
    receive = callback;
    return () => {
      receive = undefined;
    };
  });
  await screen.findByText("編集前の題名", { exact: true });
  act(() => controller.place("main", 1, 0));
  await act(() => controller.run("prompt.open"));
  act(() => controller.replacePromptText("先に保存した題名"));
  let saving: Promise<boolean> | undefined;
  act(() => {
    saving = controller.submitPrompt("先に保存した題名");
  });
  act(() => controller.replacePromptText("自分の書きかけ"));
  server = issueView({ title: "後で保存した別タブの題名", state: "draft" });
  act(() => receive?.());
  await screen.findByText("後で保存した別タブの題名", { exact: true });
  await act(async () => {
    finishUpdate(issueView({ title: "先に保存した題名", state: "draft" }));
    await saving;
  });
  expect(await screen.findByText("後で保存した別タブの題名", { exact: true })).toBeVisible();
  expect(controller.promptText()).toBe("自分の書きかけ");
  expect(update).toHaveBeenCalledExactlyOnceWith("i", { title: "先に保存した題名" });
});

it("作成の応答が画面離脱後に来たときも、下書きIDを記録して移動先を保つ", async () => {
  let finishCreate!: (issue: IssueView) => void;
  const created = new Promise<IssueView>((resolve) => {
    finishCreate = resolve;
  });
  const { controller, navigate, draft } = mount(null, { create: () => created });
  act(() => controller.place("main", 1, 0));
  await act(() => controller.run("prompt.open"));
  act(() => controller.replacePromptText("作成する題名"));
  let saving: Promise<boolean> | undefined;
  act(() => {
    saving = controller.submitPrompt("作成する題名");
  });
  act(() => {
    void controller.navigate("/projects/other");
  });
  await act(async () => {
    finishCreate(issueView({ title: "作成する題名", state: "draft" }));
    await saving;
  });
  expect(navigate).toHaveBeenCalledExactlyOnceWith("/projects/other");
  expect(draft?.snapshot().id).toBe("i");
  expect(controller.options.url).toBe("/projects/other");
});

it.each(["二度書く題名", "確定済みの題名"])(
  "保存待ちに前と同じ「%s」を書き直して閉じたら、新しい控えとして残す",
  async (bufferedText) => {
    let finishUpdate!: (issue: IssueView) => void;
    const original = issueView({ title: "確定済みの題名", state: "draft" });
    const updated = new Promise<IssueView>((resolve) => {
      finishUpdate = resolve;
    });
    let server = original;
    const { controller } = mount(original, { get: async () => server, update: () => updated });
    const type = (text: string) =>
      act(() => {
        controller.replacePromptText(text);
        controller.snapshot().prompt?.change?.(text);
      });
    act(() => controller.place("main", 1, 0));
    await act(() => controller.run("prompt.open"));
    type(bufferedText);
    act(() => controller.closePrompt());
    await act(() => controller.run("prompt.open"));
    type("先に送る題名");
    let saving: Promise<boolean> | undefined;
    act(() => {
      saving = controller.submitPrompt("先に送る題名");
    });
    type(bufferedText);
    act(() => controller.closePrompt());
    await act(async () => {
      server = { ...original, title: "先に送る題名" };
      finishUpdate(server);
      await saving;
    });
    await act(() => controller.run("prompt.open"));
    expect(controller.snapshot().prompt?.initialText).toBe(bufferedText);
  },
);

it("同じ作成画面を開き直して先の保存を待ちながら、次の保存を同じIDへ送る", async () => {
  let finishCreate!: (issue: IssueView) => void;
  const created = new Promise<IssueView>((resolve) => {
    finishCreate = resolve;
  });
  const create = vi.fn(() => created);
  const update = vi.fn(async () => issueView({ title: "次の編集", state: "draft" }));
  const storage = tabStorage();
  const draft = createIssueDraft(storage, "p", "issue-form", create);
  const first = mount(null, { create, update }, noFeed, { draft, storage });
  const start = async (controller: BufferController, text: string) => {
    act(() => controller.place("main", 1, 0));
    await act(() => controller.run("prompt.open"));
    act(() => controller.replacePromptText(text));
  };
  await start(first.controller, "最初の編集");
  let firstSave: Promise<boolean> | undefined;
  act(() => {
    firstSave = first.controller.submitPrompt("最初の編集");
  });
  act(() => {
    void first.controller.navigate("/projects/other");
  });
  first.unmount();
  const second = mount(null, { create, update }, noFeed, { draft, storage });
  await start(second.controller, "次の編集");
  let secondSave: Promise<boolean> | undefined;
  act(() => {
    secondSave = second.controller.submitPrompt("次の編集");
  });
  expect(update).not.toHaveBeenCalled();
  await act(async () => {
    finishCreate(issueView({ title: "最初の編集", state: "draft" }));
    await Promise.all([firstSave, secondSave]);
  });
  expect(create).toHaveBeenCalledExactlyOnceWith({ title: "最初の編集" });
  expect(update).toHaveBeenCalledExactlyOnceWith("i", { title: "次の編集" });
  expect(first.navigate).toHaveBeenCalledExactlyOnceWith("/projects/other");
  expect(second.navigate).toHaveBeenCalledExactlyOnceWith("/issues/i/edit", undefined, true);
});

it("初回保存が失敗したときは下書きIDを残さず、同じ入力から保存し直せる", async () => {
  const saved = issueView({ title: "保存し直す題名", state: "draft" });
  const create = vi
    .fn(async () => saved)
    .mockRejectedValueOnce(new Error("一時的に保存できません"));
  const { controller, draft, navigate, notify } = mount(null, { create });
  act(() => controller.place("main", 1, 0));
  await act(() => controller.run("prompt.open"));
  act(() => controller.replacePromptText(saved.title));
  await act(() => controller.submitPrompt(saved.title));
  expect(draft?.snapshot().id).toBeNull();
  expect(controller.promptText()).toBe(saved.title);
  expect(navigate).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith("一時的に保存できません", "error");
  await act(() => controller.submitPrompt(saved.title));
  expect(create.mock.calls).toEqual([
    ["p", { title: saved.title }],
    ["p", { title: saved.title }],
  ]);
  expect(navigate).toHaveBeenCalledExactlyOnceWith("/issues/i/edit", undefined, true);
});
