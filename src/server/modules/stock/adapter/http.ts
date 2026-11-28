import { sendStock } from "../usecase/send-stock";
import { Hono, type Context } from "hono";
import type { Result } from "neverthrow";
import {
  addStockSchema,
  finishThreadSchema,
  patchStockSchema,
  stockSendSchema,
  threadProposalSequenceHeader,
} from "../../../../shared/stock";
import type { StockDependencies, StockError } from "../domain/ports";
import { add } from "../usecase/add";
import { list } from "../usecase/list";
import { edit } from "../usecase/edit";
import { cancel } from "../usecase/cancel";
import { restore } from "../usecase/restore";
import { listThreads } from "../usecase/list-threads";
import { finishThread } from "../usecase/finish-thread";
function response<T>(c: Context, result: Result<T, StockError>, success: 200 | 201 | 202 = 200) {
  const statuses = {
    invalid_input: 400,
    not_found: 404,
    conflict: 409,
    internal: 500,
    worktree_failed: 500,
    runner_unavailable: 503,
  } as const;
  return result.isErr()
    ? c.json({ error: result.error }, statuses[result.error.code])
    : c.json(result.value, success);
}
const invalid = (c: Context) =>
  c.json(
    { error: { code: "invalid_input", message: "質問・指示と引用の入力を確認してください" } },
    400,
  );
export function createStockRoutes(deps: StockDependencies): Hono {
  const app = new Hono();
  app.get("/conversations/:id/stock", async (c) =>
    response(c, await list(c.req.param("id"), deps)),
  );
  app.post("/conversations/:id/stock", async (c) => {
    const input = addStockSchema.safeParse(await c.req.json().catch(() => null));
    return input.success
      ? response(c, await add(c.req.param("id"), input.data, deps), 201)
      : invalid(c);
  });
  app.patch("/stock/:id", async (c) => {
    const input = patchStockSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalid(c);
    return response(
      c,
      await ("text" in input.data
        ? edit(c.req.param("id"), input.data.text, deps)
        : restore(c.req.param("id"), deps)),
    );
  });
  app.delete("/stock/:id", async (c) => response(c, await cancel(c.req.param("id"), deps)));
  app.post("/conversations/:id/stock/send", async (c) => {
    const input = stockSendSchema.safeParse(await c.req.json().catch(() => null));
    return input.success
      ? response(c, await sendStock(c.req.param("id"), input.data, deps))
      : invalid(c);
  });
  app.get("/conversations/:id/threads", (c) => response(c, listThreads(c.req.param("id"), deps)));
  app.post("/threads/:id/finish", async (c) => {
    const input = finishThreadSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalid(c);
    const result = await finishThread(c.req.param("id"), input.data, deps);
    if (result.isOk() && "runState" in result.value) {
      const { runState, proposalSeq } = result.value;
      if (proposalSeq !== undefined) c.header(threadProposalSequenceHeader, String(proposalSeq));
      return c.json({ runState }, 202);
    }
    return response<unknown>(c, result);
  });
  return app;
}
