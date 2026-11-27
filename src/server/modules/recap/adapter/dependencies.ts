import { err, ok } from "neverthrow";
import type { OpenedDatabase } from "../../../../shared/db/open";
import { createDecisionFileStore } from "../../../../shared/recap/decision-file-store";
import { rebuildRecapResponseSchema } from "../../../../shared/ipc";
import type { RecapDependencies } from "../domain/ports";
import { runnerUnavailable } from "../../../runner-link";
import { createRecapRepository } from "./repository";
export function createRecapDependencies(
  database: () => OpenedDatabase["db"],
  runner: { forward(method: string, path: string): Promise<Response> },
  changed: (id: string) => void,
): RecapDependencies {
  return {
    repository: createRecapRepository(database),
    files: createDecisionFileStore(),
    changed,
    runner: {
      rebuild: async (id) => {
        const response = await runner.forward(
          "POST",
          `/conversations/${encodeURIComponent(id)}/recap/rebuild`,
        );
        const body: unknown = await response.json();
        if (response.ok) {
          const parsed = rebuildRecapResponseSchema.safeParse(body);
          return parsed.success
            ? ok(parsed.data)
            : err({
                code: "internal",
                message: "作り直しの結果を読み取れませんでした。もう一度操作してください。",
              });
        }
        if (response.status === 503) return err(runnerUnavailable);
        if (response.status === 409)
          return err({
            code: "conflict",
            message: "反映していない番がありません。次の応答を待ってください。",
          });
        return err({
          code: "internal",
          message: "目次を作り直せませんでした。もう一度操作してください。",
        });
      },
    },
  };
}
