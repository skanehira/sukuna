import { describe, expect, it } from "vite-plus/test";
import { rejectionFixture } from "../reject-design-test-support";

const prefix =
  "設計レビューで差し戻されました。次の指摘に沿って設計を直し、コミットしてから report_design で報告してください";

describe("設計レビューの差し戻しを既存の送信口から届ける", () => {
  const f = rejectionFixture();
  const formatted =
    "ストックした指示が 1 件あります。順に対応してください。\n\n1. ターミナルの出力から\n> ログの内容\n在庫を確かめる";

  it("会話から送った指摘を差し戻し、同じ設計の会話から報告して戻れる", async () => {
    await f.prepare();
    f.reportAfterSignal();
    const send = () =>
      f.request("/api/conversations/design/messages", "POST", {
        text: "期限を見直してください",
        images: [],
        mode: "send",
        clientMessageId: "01J00000000000000000000001",
      });
    const response = await send();
    expect(response.status).toBe(202);
    const receipt: unknown = await response.json();
    expect(receipt).toEqual({ result: "queued", queueItem: null });
    expect(f.state()).toBe("design");
    expect(f.events().find((event) => event.type === "design_rejected")?.payload).toEqual({
      via: "message",
    });
    await expect.poll(f.messages).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          text: prefix + "\n\n期限を見直してください",
          origin: "developer",
        }),
      }),
    ]);
    f.report();
    await expect.poll(f.state).toBe("design_review");
    const retry = await send();
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual(receipt);
    expect(f.events().filter((event) => event.type === "design_rejected")).toHaveLength(1);
  });

  it("ストックから送った指示を差し戻し、送った件を記録する", async () => {
    await f.prepare();
    f.stock("指示", "instruction");
    f.stock("質問", "question");
    const response = await f.request("/api/conversations/design/stock/send", "POST", {
      kinds: "instructions",
    });
    expect(response.status).toBe(200);
    expect(f.state()).toBe("design");
    expect(f.events().find((event) => event.type === "design_rejected")?.payload).toEqual({
      via: "stock",
    });
    await expect.poll(f.messages).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ text: prefix + "\n\n" + formatted, origin: "stock" }),
      }),
    ]);
    expect(f.item("指示")).toMatchObject({
      state: "sent",
      sentSeq: f.messages()[0].seq,
    });
    expect(f.item("質問")?.state).toBe("stocked");
  });

  it.each(["  期限も見直す  ", ""])(
    "メニューからストックの指示と書いた文 %s を一通にして届ける",
    async (text) => {
      await f.prepare();
      f.stock("指示", "instruction");
      f.stock("質問", "question");
      const response = await f.request("/api/issues/issue/design/reject", "POST", { text });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ deliveredStockIds: ["指示"] });
      await expect.poll(f.messages).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            text: [prefix, formatted, text].filter(Boolean).join("\n\n"),
            origin: "developer",
          }),
        }),
      ]);
      expect(f.item("指示")).toMatchObject({
        state: "sent",
        sentSeq: f.messages()[0].seq,
      });
      expect(f.item("質問")?.state).toBe("stocked");
    },
  );
});
