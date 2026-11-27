import type { RecapDependencies } from "../domain/ports";
import { getContext } from "./context";
export function getRecap(id: string, deps: RecapDependencies) {
  return getContext(id, deps).map((context) => context.recap);
}
