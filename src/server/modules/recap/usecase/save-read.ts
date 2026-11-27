import { err, ok } from "neverthrow";
import type { RecapDependencies } from "../domain/ports";
import { notFound } from "./context";
export function saveRead(
  id: string,
  input: { readSeq?: number; position?: number },
  deps: RecapDependencies,
) {
  return deps.repository.saveRead(id, input).andThen((saved) => {
    if (!saved) return err(notFound);
    deps.changed(id);
    return ok(undefined);
  });
}
