export type SearchHit = { text: string; seq: number | null; seqLine?: number };
export type SearchSource = { chapters: SearchHit[]; decisions: SearchHit[]; body: SearchHit[] };
export function searchRecap(source: SearchSource, query: string) {
  const sensitive = query !== query.toLowerCase();
  const matches = (hit: SearchHit) =>
    query !== "" && (sensitive ? hit.text : hit.text.toLowerCase()).includes(query);
  const body = source.body.filter(matches);
  return {
    chapters: source.chapters.filter(matches),
    decisions: source.decisions.filter(matches),
    body: body.slice(0, 200),
    remaining: Math.max(0, body.length - 200),
  };
}
