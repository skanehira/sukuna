import type { StockItem } from "../../../../shared/stock";
import { isStale } from "../domain/staleness";
import type { StockDependencies, StockRecord } from "../domain/ports";
export async function present(record: StockRecord, deps: StockDependencies): Promise<StockItem> {
  let content: string | undefined;
  if (record.quote.kind === "file") {
    const file = await deps.readFile(record.conversationId, record.quote.path);
    if (file.isOk() && file.value.kind === "text") content = file.value.content;
  }
  return { ...record, stale: isStale(record.quote, content) };
}
