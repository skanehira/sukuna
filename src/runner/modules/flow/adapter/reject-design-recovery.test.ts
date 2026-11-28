import { expect, it, vi } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { rejectionFixture } from "../reject-design-test-support";
import { ScriptedAgent } from "../../conversation/adapter/scripted-agent";
import { drafts, issues, stockItems } from "../../../../shared/db/schema";
import { hasUnlocatedEdits, queueDraftContent } from "../../../../shared/progress/draft";
import { SqliteConversationStore } from "../../conversation/adapter/sqlite-conversation-store";
import { openMigratedDatabase } from "../../../../shared/db/test-helpers";
import type { ConversationSnapshot } from "../../../../shared/conversation/api";

const f = rejectionFixture();
const clientMessageId = "01J00000000000000000000001";
const message = (text: string) =>
  f.request("/api/conversations/design/messages", "POST", {
    text,
    images: [],
    mode: "send",
    clientMessageId,
  });
const prefix =
  "設計レビューで差し戻されました。次の指摘に沿って設計を直し、コミットしてから report_design で報告してください";
const start = async (agent: ScriptedAgent) => {
  f.runner.runtime.options.agent = agent;
  expect((await f.worktree()).isOk()).toBe(true);
  expect(
    (
      await f.runner.runtime.send("design", { text: "設計を書く", images: [], origin: "flow" })
    ).isOk(),
  ).toBe(true);
  await expect.poll(() => f.runner.runtime.store.get("design")?.runState).toBe("working");
};
const state = (id: string) => {
  const stock = f.item(id);
  return { state: stock?.state, seq: stock?.sentSeq };
};

it.each(["menu", "stock"] as const)(
  "%s の差し戻しを受理して割込に失敗し、再送した発言に全ストックを結びつける",
  async (entry) => {
    const agent = new ScriptedAgent({ rules: [], fallback: [{ hold: true }] });
    await start(agent);
    expect((await f.submit()).isOk()).toBe(true);
    f.stock("instruction1", "instruction");
    f.stock("instruction2", "instruction");
    const { session } = f.runner.runtime.executions.get("design")!;
    vi.spyOn(session, "interrupt").mockRejectedValue(new Error("test SDK interrupt failed"));
    const response =
      entry === "menu"
        ? await f.request("/api/issues/issue/design/reject", "POST", { text: "追記" })
        : await f.request("/api/conversations/design/stock/send", "POST", {
            kinds: "instructions",
          });
    expect(response.status).toBe(entry === "menu" ? 202 : 200);
    await f.runner.design.drain();
    expect(f.runner.runtime.store.get("design")?.runState).toBe("failed");
    expect(f.messages()).toHaveLength(1);
    const [queued] = f.runner.runtime.store.queue("design");
    expect(queued?.text.startsWith(prefix)).toBe(true);
    expect(f.runner.runtime.store.queue("design")).toHaveLength(1);
    expect((await message("")).status).toBe(202);
    await expect.poll(() => agent.sent.length).toBe(2);
    const sent = f.messages().at(-1)!;
    expect(sent.payload).toMatchObject({ text: queued!.text });
    expect([state("instruction1"), state("instruction2")]).toEqual([
      { state: "sent", seq: sent.seq },
      { state: "sent", seq: sent.seq },
    ]);
  },
);

it("発言前に失敗して預かりに戻った差し戻しを取り消すと指示の印も戻る", async () => {
  const agent = new ScriptedAgent({ rules: [], fallback: [{ hold: true }] });
  await start(agent);
  expect((await f.submit()).isOk()).toBe(true);
  f.stock("instruction1", "instruction");
  f.stock("instruction2", "instruction");
  vi.spyOn(f.runner.runtime.executions.get("design")!.session, "interrupt").mockRejectedValue(
    new Error("test SDK interrupt failed"),
  );
  expect(
    (await f.request("/api/conversations/design/stock/send", "POST", { kinds: "instructions" }))
      .status,
  ).toBe(200);
  await f.runner.design.drain();
  const [queued] = f.runner.runtime.store.queue("design");
  const response = await f.request(`/api/conversations/design/queue/${queued!.id}`, "DELETE");
  expect(response.status).toBe(204);
  expect([
    state("instruction1"),
    state("instruction2"),
    f.runner.runtime.store.draft("design")?.text,
  ]).toEqual([{ state: "stocked", seq: null }, { state: "stocked", seq: null }, undefined]);
});

it("設計レビューから届く前の指示だけを送ると差し戻す", async () => {
  const agent = new ScriptedAgent({ rules: [], fallback: [{ hold: true }] });
  await start(agent);
  const queued = await f.runner.runtime.send("design", {
    text: "見直してください",
    images: [],
    origin: "developer",
  });
  expect(queued._unsafeUnwrap().result).toBe("queued");
  expect((await f.submit()).isOk()).toBe(true);
  expect((await f.request("/api/conversations/design/stop", "POST")).status).toBe(202);
  await expect.poll(() => f.runner.runtime.store.get("design")?.runState).toBe("stopped");
  expect(f.state()).toBe("design_review");
  expect(f.runner.runtime.store.queue("design")).toHaveLength(1);
  expect((await message("")).status).toBe(202);
  await f.runner.design.drain();
  expect({
    state: f.state(),
    rejection: f.events().find(({ type }) => type === "design_rejected")?.payload,
    sent: agent.sent.at(-1)?.text,
  }).toEqual({
    state: "design",
    rejection: { via: "message" },
    sent: prefix + "\n\n見直してください",
  });
});

it("メニューの差し戻しで、古いファイル引用だと AI に伝える", async () => {
  await f.prepare();
  f.stock("instruction1", "instruction");
  f.db
    .update(stockItems)
    .set({
      quote: JSON.stringify({
        kind: "file",
        mode: "line",
        path: "design.md",
        start: { line: 2, col: 1 },
        end: { line: 2, col: 13 },
        text: "見ていた時の文言",
      }),
    })
    .where(eq(stockItems.id, "instruction1"))
    .run();
  const response = await f.request("/api/issues/issue/design/reject", "POST", { text: "" });
  expect(response.status).toBe(202);
  await f.runner.design.drain();
  expect(f.messages().at(-1)?.payload).toMatchObject({
    text:
      prefix +
      "\n\nストックした指示が 1 件あります。順に対応してください。\n\n1. design.md 2 行目 (引用した時点の内容。いまのファイルとは違います)\n> 見ていた時の文言\n在庫を確かめる",
  });
});

it("配達前に失敗したタイムライン相談の本文を、届く前の指示で別端末から編集できる", async () => {
  const agent = new ScriptedAgent({ rules: [], fallback: [{ hold: true }] });
  await start(agent);
  expect((await f.submit()).isOk()).toBe(true);
  vi.spyOn(f.runner.runtime.executions.get("design")!.session, "interrupt").mockRejectedValue(
    new Error("test SDK interrupt failed"),
  );

  const taskPrefix = "タイムラインのタスク task1「進捗」について: ";
  const text = taskPrefix + "どこまで済みましたか";
  const response = await f.request("/api/conversations/design/messages", "POST", {
    text,
    images: [],
    mode: "send",
    clientMessageId,
    timeline_comments: [{ task_id: "task1", text: "どこまで済みましたか" }],
    timeline_anchors: [{ task_id: "task1", from: 0, bodyFrom: taskPrefix.length, to: text.length }],
  });
  expect(response.status).toBe(202);
  await f.runner.design.drain();
  expect(f.runner.runtime.store.get("design")?.runState).toBe("failed");
  const [queued] = f.runner.runtime.store.queue("design");
  expect(queued?.text).toBe(prefix + "\n\n" + text);
  expect(queued?.timelineComments).toEqual([{ task_id: "task1", text: "どこまで済みましたか" }]);
  const editedText = prefix + "\n\n" + taskPrefix + "あと何が残っていますか";
  const saved = (await (
    await f.request("/api/conversations/design")
  ).json()) as ConversationSnapshot;
  const displayed = queueDraftContent(saved.queue[0]!);
  const [anchor] = displayed.timeline_anchors ?? [];
  expect(anchor && "bodyFrom" in anchor ? anchor : undefined).toEqual({
    task_id: "task1",
    from: prefix.length + 2,
    bodyFrom: prefix.length + 2 + taskPrefix.length,
    to: queued!.text.length,
  });
  const updatedAnchors = [{ ...anchor!, to: editedText.length }];
  expect(hasUnlocatedEdits({ text: editedText, timeline_anchors: updatedAnchors })).toBe(false);
  const edit = await f.request(`/api/conversations/design/queue/${queued!.id}`, "PATCH", {
    text: editedText,
    images: [],
    timeline_anchors: updatedAnchors,
  });
  expect(edit.status).toBe(200);
  const resent = await f.request("/api/conversations/design/messages", "POST", {
    text: "",
    images: [],
    mode: "send",
    clientMessageId: "01J00000000000000000000002",
  });
  expect(resent.status).toBe(202);
  expect(f.messages().at(-1)?.payload).toMatchObject({
    text: editedText,
    timeline_comments: [{ task_id: "task1", text: "あと何が残っていますか" }],
  });
});

it("混合差し戻しを取り消し、元の文と指定した指示だけを1回の受付で復帰する", async () => {
  const agent = new ScriptedAgent({ rules: [], fallback: [{ hold: true }] });
  await start(agent);
  expect((await f.submit()).isOk()).toBe(true);
  f.stock("instruction1", "instruction");
  f.stock("instruction2", "instruction");
  vi.spyOn(f.runner.runtime.executions.get("design")!.session, "interrupt").mockRejectedValue(
    new Error("SDK interruption failed"),
  );
  expect(
    (await f.request("/api/issues/issue/design/reject", "POST", { text: "元の本文" })).status,
  ).toBe(202);
  await f.runner.design.drain();
  const [waiting] = f.runner.runtime.store.queue("design");
  expect((await f.request(`/api/conversations/design/queue/${waiting.id}`, "DELETE")).status).toBe(
    204,
  );
  const draft = f.runner.runtime.store.draft("design")!;
  expect(draft.text).toBe("元の本文");
  expect([state("instruction1"), state("instruction2")]).toEqual([
    { state: "stocked", seq: null },
    { state: "stocked", seq: null },
  ]);
  f.stock("unrelated", "instruction");
  const restore = {
    text: draft.text,
    images: [],
    mode: "send",
    clientMessageId,
    stockIds: ["instruction1", "instruction2"],
    preserveDraft: true,
    restoreDraft: {
      expected: draft,
      replacement: { ...draft, text: "", updatedAt: draft.updatedAt + 1 },
    },
  };
  expect(
    (
      await f.request("/api/conversations/design/messages", "POST", {
        ...restore,
        stockIds: [...restore.stockIds, "unknown"],
      })
    ).status,
  ).toBe(409);
  expect(f.runner.runtime.store.draft("design")).toEqual(draft);
  expect(state("instruction1")).toEqual({ state: "stocked", seq: null });

  const stockNotices = () =>
    f.changes.filter(
      (event) =>
        event.kind === "conversation_parts" &&
        event.conversation_id === "design" &&
        event.parts.includes("stock"),
    );
  const existingNotices = stockNotices().length;
  expect((await f.request("/api/conversations/design/messages", "POST", restore)).status).toBe(202);
  await expect.poll(() => stockNotices().length).toBe(existingNotices + 1);
  const sent = f.messages().at(-1)!;
  expect(sent.payload).toMatchObject({
    text: expect.stringMatching(/^ストックした指示が 2 件あります。[\s\S]+\n\n元の本文$/),
  });
  expect([state("instruction1"), state("instruction2"), state("unrelated")]).toEqual([
    { state: "sent", seq: sent.seq },
    { state: "sent", seq: sent.seq },
    { state: "stocked", seq: null },
  ]);
  expect(f.runner.runtime.store.draft("design")?.text).toBe("");
});

it("ランナーの再起動と同じ SQLite の開き直しから、受理した複数ストックを預かりへ移す", async () => {
  await f.prepare();
  f.stock("instruction1", "instruction");
  f.stock("instruction2", "instruction");
  f.db.update(stockItems).set({ state: "sent", sentAt: 10 }).run();
  f.db.update(issues).set({ state: "design" }).where(eq(issues.id, "issue")).run();
  const deliveryContext = {
    stockIds: ["instruction1", "instruction2"],
    original: { text: "元の本文", images: [] },
  };
  f.runner.runtime.store.stageAccepted({
    id: "staged",
    conversationId: "design",
    text: prefix + "\n\n元の本文",
    images: [],
    createdAt: 10,
    clientId: null,
    deliveryContext,
  });
  const reopened = openMigratedDatabase(f.home);
  try {
    const store = new SqliteConversationStore(reopened.sqlite);
    expect(store.recoverAccepted()).toBe(true);
    expect(store.recoverAccepted()).toBe(false);
  } finally {
    reopened.close();
  }
  const [waiting] = f.runner.runtime.store.queue("design");
  expect(waiting).toMatchObject({ id: "staged", deliveryContext });
  expect((await message("")).status).toBe(202);
  await f.runner.design.drain();
  const seq = f.messages().at(-1)!.seq;
  expect([state("instruction1"), state("instruction2")]).toEqual([
    { state: "sent", seq },
    { state: "sent", seq },
  ]);
});

it("同じ本文でも別端末が保存した版は差し戻しで消さない", async () => {
  await f.prepare();
  const draft = { text: "同じ文", images: [], updatedAt: 10, updatedBy: "tab" };
  f.db
    .insert(drafts)
    .values({ conversationId: "design", ...draft, updatedBy: "another-tab" })
    .run();
  const response = await f.request("/api/issues/issue/design/reject", "POST", {
    text: draft.text,
    draft,
  });
  expect(response.status).toBe(202);
  expect(f.runner.runtime.store.draft("design")).toEqual({ ...draft, updatedBy: "another-tab" });
});

it("受付の clientId を持たない元のストックの預かり ID も、復旧後の発言に残す", async () => {
  const agent = new ScriptedAgent({ rules: [], fallback: [{ hold: true }] });
  await start(agent);
  f.stock("original-stock", "instruction");
  expect(
    (await f.request("/api/conversations/design/stock/send", "POST", { kinds: "instructions" }))
      .status,
  ).toBe(200);
  const [originalQueue] = f.runner.runtime.store.queue("design");
  expect(originalQueue).toMatchObject({ stockItemId: "original-stock", clientId: null });
  expect((await f.submit()).isOk()).toBe(true);
  vi.spyOn(f.runner.runtime.executions.get("design")!.session, "interrupt").mockRejectedValue(
    new Error("SDK interruption failed"),
  );

  expect((await message("")).status).toBe(202);
  await f.runner.design.drain();
  const [restored] = f.runner.runtime.store.queue("design");
  expect(restored.deliveryContext?.queuedIds).toEqual([originalQueue.id]);
  const resent = await f.request("/api/conversations/design/messages", "POST", {
    text: "",
    images: [],
    mode: "send",
    clientMessageId: "01J00000000000000000000004",
  });
  expect(resent.status).toBe(202);
  const sent = f.messages().at(-1)!;
  expect(sent.payload.queued_ids).toEqual([restored.id, originalQueue.id]);
  expect(sent.payload.text).toContain("在庫を確かめる");
  expect(state("original-stock")).toEqual({ state: "sent", seq: sent.seq });
});

it.each(["差し戻し", "通常"] as const)(
  "%s の本文付きストックを配達前に編集して取り消すと、最新の本文・画像・相談を復元する",
  async (entry) => {
    const agent = new ScriptedAgent({ rules: [], fallback: [{ hold: true }] });
    await start(agent);
    f.stock("stock-to-restore", "instruction");
    if (entry === "差し戻し") {
      expect((await f.submit()).isOk()).toBe(true);
      vi.spyOn(f.runner.runtime.executions.get("design")!.session, "interrupt").mockRejectedValue(
        new Error("SDK interruption failed"),
      );
    }
    const task = "タイムラインのタスク review「進捗」について: ";
    const original = task + "最初の質問";
    const sent = await f.request("/api/conversations/design/messages", "POST", {
      text: original,
      images: [],
      mode: "send",
      clientMessageId,
      stockIds: ["stock-to-restore"],
      timeline_anchors: [
        { task_id: "review", from: 0, bodyFrom: task.length, to: original.length },
      ],
      timeline_comments: [{ task_id: "review", text: "最初の質問" }],
    });
    expect(sent.status).toBe(202);
    if (entry === "差し戻し") await f.runner.design.drain();
    const [waiting] = f.runner.runtime.store.queue("design");
    const offset = waiting.text.length - original.length;
    const latest = task + "最後に保存した質問";
    const suffix = waiting.text.slice(0, offset);
    const path = `/api/conversations/design/queue/${waiting.id}`;
    const patch = {
      text: suffix + latest,
      images: ["new-image"],
      timeline_anchors: [
        {
          task_id: "review",
          from: offset,
          bodyFrom: offset + task.length,
          to: offset + latest.length,
        },
      ],
    };
    expect(
      (await f.request(path, "PATCH", { ...patch, text: "X" + patch.text.slice(1) })).status,
    ).toBe(409);
    const edit = await f.request(path, "PATCH", patch);
    expect(edit.status).toBe(200);
    const result = (await edit.json()) as { queueItem: ConversationSnapshot["queue"][number] };
    const originalInput = {
      text: latest,
      images: ["new-image"],
      timeline_anchors: [{ task_id: "review", from: 0, bodyFrom: task.length, to: latest.length }],
    };
    expect(result.queueItem.deliveryContext?.original).toEqual(originalInput);
    expect((await f.request(path, "DELETE")).status).toBe(204);
    expect(f.runner.runtime.store.draft("design")).toMatchObject(originalInput);
    expect(state("stock-to-restore")).toEqual({ state: "stocked", seq: null });
  },
);

it.each(["ストック", "空白だけのメニュー"] as const)(
  "%s の差し戻しでは、生成文を開発者の原文に含めない",
  async (entry) => {
    const agent = new ScriptedAgent({ rules: [], fallback: [{ hold: true }] });
    await start(agent);
    expect((await f.submit()).isOk()).toBe(true);
    f.stock("stock-only", "instruction");
    vi.spyOn(f.runner.runtime.executions.get("design")!.session, "interrupt").mockRejectedValue(
      new Error("SDK interruption failed"),
    );
    const rejection =
      entry === "ストック"
        ? await f.request("/api/conversations/design/stock/send", "POST", { kinds: "instructions" })
        : await f.request("/api/issues/issue/design/reject", "POST", { text: "   " });
    expect(rejection.status).toBe(entry === "ストック" ? 200 : 202);
    await f.runner.design.drain();
    const [recovered] = f.runner.runtime.store.queue("design");
    expect(recovered.deliveryContext?.original).toBeUndefined();
    expect(recovered.deliveryContext?.originalRanges).toBeUndefined();
    const path = `/api/conversations/design/queue/${recovered.id}`;
    const changed = await f.request(path, "PATCH", {
      text: recovered.text + "\n\n消えてはいけない追記",
      images: [],
    });
    expect(changed.status).toBe(409);
    expect(f.runner.runtime.store.queue("design")).toEqual([recovered]);
    expect((await f.request(path, "DELETE")).status).toBe(204);
    expect(state("stock-only")).toEqual({ state: "stocked", seq: null });
    expect(f.runner.runtime.store.draft("design")).toBeNull();
  },
);

it("同じ引用が複数あっても順序で区別できれば、編集した原文だけを取り消しで復元する", async () => {
  await f.prepare();
  f.stock("repeated-stock", "instruction");
  f.db
    .update(stockItems)
    .set({ state: "sent", sentAt: 10 })
    .where(eq(stockItems.id, "repeated-stock"))
    .run();
  const separator = "\n\n同じストックの引用\n\n";
  const heading = prefix + "\n\n";
  const previousBodies = ["最初の文", "次の文", "最後の文"];
  let offset = heading.length;
  const ranges = previousBodies.map((body) => {
    const from = offset;
    offset += body.length + separator.length;
    return { from, to: from + body.length };
  });
  const oldText = heading + previousBodies.join(separator);
  f.runner.runtime.store.enqueue({
    id: "repeated-protected",
    conversationId: "design",
    position: 1,
    clientId: null,
    text: oldText,
    images: [],
    createdAt: 15,
    deliveryContext: {
      original: { text: previousBodies.join("\n\n"), images: [] },
      originalRanges: ranges,
      stockIds: ["repeated-stock"],
    },
  });
  const path = "/api/conversations/design/queue/repeated-protected";
  expect(
    (
      await f.request(path, "PATCH", {
        text: heading + ["曖昧" + separator + "な入力", "次の文", "最後の文"].join(separator),
        images: [],
      })
    ).status,
  ).toBe(409);
  expect(f.runner.runtime.store.queue("design")[0].text).toBe(oldText);
  const amended = ["最初の短い追記\n\n文", "直した中ほど", "末尾の訂正"];
  expect(
    (
      await f.request(path, "PATCH", {
        text: heading + amended.join(separator),
        images: [],
      })
    ).status,
  ).toBe(200);
  expect((await f.request(path, "DELETE")).status).toBe(204);
  expect(f.runner.runtime.store.draft("design")?.text).toBe(amended.join("\n\n"));
  expect(state("repeated-stock")).toEqual({ state: "stocked", seq: null });
});
