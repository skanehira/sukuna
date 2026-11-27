import type { StockDependencies } from "../domain/ports";
import { change } from "./change";
export const cancel = (id: string, deps: StockDependencies) =>
  change(id, "cancel", undefined, deps);
