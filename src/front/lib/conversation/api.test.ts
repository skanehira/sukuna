import { expect, it } from "vite-plus/test";
import { ConversationApiError, createConversationApi } from "./api";

it("会話APIがJSONでない404を返しても、画面へ見つからないことを返す", async () => {
  const api = createConversationApi(async () => new Response("404 Not Found", { status: 404 }));
  await expect(api.get("missing")).rejects.toEqual(
    new ConversationApiError(
      404,
      "not_found",
      "開いた対象が見つかりません。一覧から選び直してください。",
    ),
  );
});

it("回答の送信では確認した質問の番号と回答内容を送る", async () => {
  const requests: { path: string; method: string | undefined; body: unknown }[] = [];
  const api = createConversationApi(async (path, init) => {
    if (typeof path !== "string" || typeof init?.body !== "string")
      throw new Error("回答の送信に JSON のリクエスト本文がありません。");
    requests.push({ path, method: init.method, body: JSON.parse(init.body) });
    return Response.json({ result: "answered" }, { status: 202 });
  });

  const confirmedAnswers = { "0": { choices: ["A"], text: null } };
  expect(
    await api.sendAnswers("c1", { questionSeq: 9, confirmUnanswered: true, confirmedAnswers }),
  ).toEqual({ result: "answered" });
  expect(requests).toEqual([
    {
      path: "/api/conversations/c1/answers/send",
      method: "POST",
      body: { questionSeq: 9, confirmUnanswered: true, confirmedAnswers },
    },
  ]);
});
