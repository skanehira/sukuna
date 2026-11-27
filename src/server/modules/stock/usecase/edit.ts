import type { StockDependencies } from "../domain/ports";
import { change } from "./change";
export const edit = (id: string, text: string, deps: StockDependencies) =>
  change(id, "edit", text, deps);
