import {
  finishThreadResponseSchema,
  finishThreadWithStockResponseSchema,
  stockItemResponseSchema,
  stockResponseSchema,
  stockSendResponseSchema,
  threadsResponseSchema,
  threadProposalSequenceHeader,
  type AddStockInput,
  type StockSendInput,
} from "../../../shared/stock";
import { createConversationRequest } from "../conversation/api";

export function createStockApi(fetcher: typeof fetch) {
  const request = createConversationRequest(fetcher);
  const collection = (id: string) => `/conversations/${encodeURIComponent(id)}/stock`;
  const item = (id: string) => `/stock/${encodeURIComponent(id)}`;
  const thread = (id: string) => `/threads/${encodeURIComponent(id)}/finish`;
  return {
    list: async (id: string) => stockResponseSchema.parse(await request(collection(id))).items,
    add: async (id: string, input: AddStockInput) =>
      stockItemResponseSchema.parse(await request(collection(id), "POST", input)).item,
    edit: async (id: string, text: string) =>
      stockItemResponseSchema.parse(await request(item(id), "PATCH", { text })).item,
    cancel: async (id: string) =>
      stockItemResponseSchema.parse(await request(item(id), "DELETE")).item,
    restore: async (id: string) =>
      stockItemResponseSchema.parse(await request(item(id), "PATCH", { state: "stocked" })).item,
    send: async (id: string, input: StockSendInput) =>
      stockSendResponseSchema.parse(await request(`${collection(id)}/send`, "POST", input)),
    threads: async (id: string) =>
      threadsResponseSchema.parse(await request(`/conversations/${encodeURIComponent(id)}/threads`))
        .threads,
    propose: (id: string) =>
      request(thread(id), "POST", { action: "propose" }, (response) => {
        const seq = Number(response.headers.get(threadProposalSequenceHeader));
        return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
      }),
    close: async (id: string) =>
      finishThreadResponseSchema.parse(await request(thread(id), "POST", { action: "close" }))
        .thread,
    finish: async (id: string, text: string) =>
      finishThreadWithStockResponseSchema.parse(
        await request(thread(id), "POST", { action: "stock", text }),
      ),
  };
}

export type StockApi = ReturnType<typeof createStockApi>;
