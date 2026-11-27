import { expect, it } from "vite-plus/test";
import { createRecapApi } from "./api";
it("既読と位置の送信はタブを閉じる際だけkeepaliveを指定する", async () => {
  const requests: unknown[] = [];
  const api = createRecapApi(async (url, init) => {
    requests.push({ url, init });
    return new Response(null, { status: 204 });
  });
  await api.read("c/1", { readSeq: 5 }, false);
  await api.read("c/1", { position: 3 }, true);
  expect(requests).toEqual([
    {
      url: "/api/conversations/c%2F1/read",
      init: {
        method: "POST",
        keepalive: false,
        headers: { "Content-Type": "application/json" },
        body: '{"readSeq":5}',
      },
    },
    {
      url: "/api/conversations/c%2F1/read",
      init: {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: '{"position":3}',
      },
    },
  ]);
});
