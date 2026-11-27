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
