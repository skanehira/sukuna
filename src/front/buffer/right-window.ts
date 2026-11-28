export type RightView = {
  view: string;
  target: string;
  parent?: string;
  task?: { id: string; conversationId: string };
};
export type RightState = { current: RightView | null; stack: RightView[] };
export const isThreadRight = (view: RightView) =>
  view.view === "thread" || view.view === "stock-thread";
export const isTimelineView = (view: string): view is "timeline" | "timeline-task" =>
  view === "timeline" || view === "timeline-task";
const transient = (view: RightView) =>
  view.view === "closing" || view.view === "backups" || (isThreadRight(view) && !view.parent);
const sameView = (a: RightView, b: RightView) =>
  a.view === b.view && a.target === b.target && a.parent === b.parent;
export class RightWindow {
  current: RightView | null;
  private revision = 0;
  private stack: RightView[];
  constructor(state: RightState = { current: null, stack: [] }) {
    this.current = state.current;
    this.stack = state.stack.slice(-20);
  }
  openingRevision(): number {
    return this.revision;
  }
  open(next: RightView): void {
    this.revision++;
    if (this.current && sameView(this.current, next)) return;
    this.stack = this.stack.filter((value) => !sameView(value, next));
    if (this.current) this.stack = [...this.stack, this.current].slice(-20);
    this.current = next;
  }
  back(): RightView | null {
    this.revision++;
    this.current = this.stack.pop() ?? null;
    return this.current;
  }
  close(): void {
    this.revision++;
    this.current = null;
    this.stack = [];
  }
  navigate(kind: string, target: string): void {
    this.revision++;
    const related = (view: RightView) =>
      !transient(view) &&
      (!isThreadRight(view) ||
        ((kind === "conversation" || kind === "file") && view.parent === target));
    this.stack = this.stack.filter(related);
    if (!this.current) return;
    if (
      !related(this.current) ||
      !["conversation", "issue", "file"].includes(kind) ||
      (this.current.view === "recent" && this.current.target !== target)
    ) {
      this.close();
      return;
    }
    const retarget = (view: RightView) => (isThreadRight(view) ? view : { ...view, target });
    this.current = retarget(this.current);
    this.stack = this.stack.map(retarget);
  }
  state(): RightState {
    return {
      current: this.current && !transient(this.current) ? this.current : null,
      stack: this.stack.filter((view) => !transient(view)),
    };
  }
}
