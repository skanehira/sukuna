import { err, ok, type Result } from "neverthrow";
import { publishCommentsSchema, type PublishResponse } from "../../../../shared/api/pr";
import { canCommentOnLine } from "../domain/pr-view";
import {
  prConflict,
  type PrDependencies,
  type PrError,
  type PublishStock,
  type ReviewComment,
} from "../domain/pr-ports";
const bodyOf = (stock: PublishStock) =>
  stock.quote
    ? `${stock.quote.text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n${stock.text}`
    : stock.text;
export async function publishComments(
  id: string,
  input: unknown,
  deps: PrDependencies,
): Promise<Result<PublishResponse, PrError>> {
  const parsed = publishCommentsSchema.safeParse(input);
  if (!parsed.success)
    return err({ code: "invalid_input", message: "投稿する指示を 1〜50 件選んでください。" });
  const ctx = deps.repository.context(id);
  if (!ctx)
    return err({ code: "not_found", message: "issue が見つかりません。開き直してください。" });
  const url = ctx.issue.prUrl;
  if (!ctx.project.usesGithub || !url) return err(prConflict);
  const ids = [...new Set(parsed.data.stockIds)];
  if (ids.some((s) => deps.publishing.has(s))) return err(prConflict);
  const stocks = deps.repository.stocks(ids);
  const skipped: PublishResponse["skipped"] = [];
  const selected: PublishStock[] = [];
  for (const stockId of ids) {
    const s = stocks.find((s) => s.id === stockId);
    if (!s || s.conversationId !== ctx.implConversationId)
      skipped.push({ stockId, reason: "not_in_conversation" });
    else if (s.kind === "question") skipped.push({ stockId, reason: "question" });
    else if (s.githubCommentUrl) skipped.push({ stockId, reason: "already_published" });
    else selected.push(s);
  }
  if (!selected.length)
    return err({ code: "invalid_input", message: "投稿できる指示を選んでください。" });
  for (const s of selected) deps.publishing.add(s.id);
  try {
    const current = await deps.github.read(url, ctx.project.path);
    if (current.isErr()) return err(current.error);
    if (current.value.pr.state !== "open") return err(prConflict);
    const sha = current.value.pr.headSha;
    let placements = selected.map((s) =>
      canCommentOnLine(s.quote, sha, current.value.files) ? ("line" as const) : ("body" as const),
    );
    const comments: ReviewComment[] = selected.flatMap((s, i) => {
      if (placements[i] !== "line" || s.quote?.kind !== "pr_diff") return [];
      const q = s.quote;
      return [
        {
          path: q.path,
          line: q.end.line,
          side: q.end.side === "old" ? "LEFT" : "RIGHT",
          body: s.text,
          ...(q.start.line !== q.end.line || q.start.side !== q.end.side
            ? {
                start_line: q.start.line,
                start_side: q.start.side === "old" ? ("LEFT" as const) : ("RIGHT" as const),
              }
            : {}),
        },
      ];
    });
    let posted = await deps.github.review(url, ctx.project.path, {
      commit_id: sha,
      event: "COMMENT",
      body: selected
        .filter((_, i) => placements[i] === "body")
        .map(bodyOf)
        .join("\n\n---\n\n"),
      comments,
    });
    if (posted.isErr() && posted.error.lineRejected && comments.length) {
      placements = selected.map(() => "body");
      posted = await deps.github.review(url, ctx.project.path, {
        commit_id: sha,
        event: "COMMENT",
        body: selected.map(bodyOf).join("\n\n---\n\n"),
        comments: [],
      });
    }
    if (posted.isErr()) return err({ code: posted.error.code, message: posted.error.message });
    let lineIndex = 0;
    const review = posted.value;
    const published = selected.map((s, i) => ({
      stockId: s.id,
      url:
        placements[i] === "line"
          ? (review.commentUrls[lineIndex++] ?? review.reviewUrl)
          : review.reviewUrl,
      placement: placements[i],
    }));
    deps.transaction((repository) => repository.markPublished(published));
    if (ctx.implConversationId) deps.changed(ctx.implConversationId);
    return ok({ reviewUrl: review.reviewUrl, published, skipped });
  } finally {
    for (const s of selected) deps.publishing.delete(s.id);
  }
}
