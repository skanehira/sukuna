import { conflict, type OperationError } from "../../conversation/usecase/runtime";

export const stockChanged = conflict(
  "質問・指示の状態が変わりました。一覧を読み直してから、もう一度操作してください。",
);
export const cancelledStockSend: OperationError = {
  code: "runner_unavailable",
  message: "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
};

export class StockSendRefused extends Error {
  readonly error: OperationError;
  constructor(error: OperationError) {
    super(error.message);
    this.error = error;
  }
}
