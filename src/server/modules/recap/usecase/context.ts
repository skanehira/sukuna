import { err, ok } from "neverthrow";
import type { RecapDependencies, RecapError } from "../domain/ports";
export const notFound: RecapError = {
  code: "not_found",
  message: "会話または章が見つかりません。会話を開き直してください。",
};
export function getContext(id: string, deps: Pick<RecapDependencies, "repository">) {
  return deps.repository.context(id).andThen((context) => (context ? ok(context) : err(notFound)));
}
