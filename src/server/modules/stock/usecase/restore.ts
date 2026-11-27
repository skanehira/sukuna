import type { StockDependencies } from "../domain/ports";
import { change } from "./change";
export const restore = (id: string, deps: StockDependencies) =>
  change(id, "restore", undefined, deps);
