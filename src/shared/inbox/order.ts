export type OrderedRow = {
  id: string;
  unread: boolean;
  priority: "high" | "medium" | "low" | null;
  lastActivityAt: number;
};
const ranks = { high: 0, medium: 1, low: 2 };
export function priorityRank(priority: OrderedRow["priority"]): number {
  return ranks[priority ?? "medium"];
}
export function compareInboxRows(a: OrderedRow, b: OrderedRow): number {
  return (
    Number(b.unread) - Number(a.unread) ||
    priorityRank(a.priority) - priorityRank(b.priority) ||
    b.lastActivityAt - a.lastActivityAt ||
    (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}
