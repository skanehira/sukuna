import type { z } from "zod";
import type { putDecisionsSchema } from "../../../../shared/recap/api";
import { replaceDecisionItems } from "../../../../shared/recap/decision-file";
import type { RecapDependencies } from "../domain/ports";
import { getContext } from "./context";
export function getDecisions(id: string, deps: RecapDependencies) {
  return getContext(id, deps).andThen((context) =>
    deps.files.read(context.projectPath, id).map((file) => ({
      path: file.path,
      exists: file.exists,
      hash: file.hash,
      items: file.items,
      state: context.recap.state,
    })),
  );
}
export function putDecisions(
  id: string,
  input: z.infer<typeof putDecisionsSchema>,
  deps: RecapDependencies,
) {
  return getContext(id, deps).andThen((context) =>
    deps.files
      .update(
        context.projectPath,
        id,
        context.title,
        (content) => replaceDecisionItems(content, input.items),
        input.baseHash,
      )
      .map((file) => {
        deps.changed(id);
        return {
          path: file.path,
          exists: file.exists,
          hash: file.hash,
          items: file.items,
          state: context.recap.state,
        };
      }),
  );
}
