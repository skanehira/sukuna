export type ChapterStart = { position: number; startSeq: number };
export function canMoveChapterStart(
  chapters: ChapterStart[],
  position: number,
  startSeq: number,
): boolean {
  const index = chapters.findIndex((chapter) => chapter.position === position);
  if (index === -1) return false;
  if (position === 1) return startSeq === chapters[index].startSeq;
  return (
    startSeq > chapters[index - 1].startSeq &&
    (chapters[index + 1] === undefined || startSeq < chapters[index + 1].startSeq)
  );
}
