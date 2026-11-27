import { err, ok, type Result } from "neverthrow";
import type { StockState } from "../../../../shared/stock";

export const stockConflict = {
  code: "conflict" as const,
  message: "この質問・指示の状態が変わっています。一覧を読み直して、もう一度操作してください",
};
export function transitionStock(
  state: StockState,
  action: "edit" | "cancel" | "restore" | "send",
): Result<StockState, typeof stockConflict> {
  if (action === "restore") return state === "cancelled" ? ok("stocked") : err(stockConflict);
  if (state !== "stocked") return err(stockConflict);
  return ok(action === "cancel" ? "cancelled" : action === "send" ? "sent" : "stocked");
}
