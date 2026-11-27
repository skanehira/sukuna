export type RightView = { view: string; target: string };
export type RightState = { current: RightView | null; stack: RightView[] };
export class RightWindow {
  current: RightView | null;
  private stack: RightView[];
  constructor(state: RightState = { current: null, stack: [] }) {
    this.current = state.current;
    this.stack = state.stack.slice(-20);
  }
  open(next: RightView): void {
    if (this.current?.view === next.view && this.current.target === next.target) return;
    this.stack = this.stack.filter(
      (value) => value.view !== next.view || value.target !== next.target,
    );
    if (this.current) this.stack = [...this.stack, this.current].slice(-20);
    this.current = next;
  }
  back(): RightView | null {
    this.current = this.stack.pop() ?? null;
    return this.current;
  }
  close(): void {
    this.current = null;
    this.stack = [];
  }
  navigate(kind: string, target: string): void {
    if (!this.current) return;
    if (
      !["conversation", "issue", "file"].includes(kind) ||
      (this.current.view === "recent" && this.current.target !== target)
    )
      this.close();
    else {
      this.current = { ...this.current, target };
      this.stack = this.stack.map((value) => ({ ...value, target }));
    }
  }
  state(): RightState {
    return { current: this.current, stack: [...this.stack] };
  }
}
