import { err, ok } from "neverthrow";
import type { z } from "zod";
import type { patchTocSchema } from "../../../../shared/recap/api";
import type { RecapDependencies, RecapError } from "../domain/ports";
import { canMoveChapterStart } from "../domain/toc";
import { getContext, notFound } from "./context";
export function getToc(id: string, deps: RecapDependencies) {
  return getContext(id, deps).andThen((context) =>
    deps.repository.chapters(id).andThen((chapters) =>
      deps.files.read(context.projectPath, id).map((file) => ({
        chapters: chapters.map((chapter, index) => {
          const endSeq = chapters[index + 1] ? chapters[index + 1].startSeq - 1 : null;
          return {
            ...chapter,
            endSeq,
            decisions: file.items
              .filter(
                (item) =>
                  item.kind === "decision" &&
                  item.changedTo === null &&
                  item.seq !== null &&
                  item.seq >= chapter.startSeq &&
                  (endSeq === null || item.seq <= endSeq),
              )
              .map((item) => ({ id: item.id, text: item.text })),
          };
        }),
        state: context.recap.state,
      })),
    ),
  );
}
export function patchToc(
  id: string,
  position: number,
  patch: z.infer<typeof patchTocSchema>,
  deps: RecapDependencies,
) {
  const result = deps.repository.transaction((repository) =>
    getContext(id, { repository }).andThen(() =>
      repository.chapters(id).andThen((chapters) => {
        const current = chapters.find((chapter) => chapter.position === position);
        if (!current) return err(notFound);
        const conflict: RecapError = {
          code: "conflict",
          message: "目次が変わりました。読み直して、もう一度保存してください。",
        };
        if (current.title !== patch.base.title || current.startSeq !== patch.base.startSeq)
          return err(conflict);
        if (
          patch.startSeq !== undefined &&
          !canMoveChapterStart(chapters, position, patch.startSeq)
        )
          return err({
            code: "invalid_input" as const,
            message: "章の始まりは前後の章の間にしてください。1 章の始まりは動かせません。",
          });
        return repository
          .patchChapter(id, position, patch)
          .andThen((saved) => (saved ? ok(undefined) : err(conflict)));
      }),
    ),
  );
  return result.andThen(() => {
    deps.changed(id);
    return getToc(id, deps);
  });
}
