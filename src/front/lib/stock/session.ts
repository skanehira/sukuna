import type { Quote, StockItem, StockSendInput, Thread } from "../../../shared/stock";
import type { BufferController } from "../../buffer/controller";
import type { LineInfo } from "../../buffer/line";
import type { BufferMarks } from "../../buffer/marks";
import type { StockApi } from "./api";
import { stockMarks, type StockMark } from "./marks";
import type { QuoteSource } from "./quote";

type StockKind = StockItem["kind"];
type ChangeArea = "stock" | "threads";
type State = {
  items: StockItem[];
  threads: Thread[];
  draft?: { quote: Quote; token: object };
  placement?: { id: string };
  loaded: { stock: boolean; threads: boolean };
  errors: { stock?: string; threads?: string };
};
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "ストックとスレッドを読み込めませんでした";

export const label = (kind: StockKind) => (kind === "question" ? "質問" : "指示");

export class StockSession {
  private state: State = {
    items: [],
    threads: [],
    loaded: { stock: false, threads: false },
    errors: {},
  };
  private readonly listeners = new Set<() => void>();
  private stockRevision = 0;
  private threadsRevision = 0;

  readonly id: string;
  readonly api: StockApi;
  private readonly controller: BufferController;

  constructor(id: string, api: StockApi, controller: BufferController) {
    this.id = id;
    this.api = api;
    this.controller = controller;
  }

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(fields: Partial<State>) {
    this.state = { ...this.state, ...fields };
    this.listeners.forEach((listener) => listener());
  }

  async load(area?: ChangeArea): Promise<void> {
    await Promise.all([
      ...(area !== "threads" ? [this.loadItems()] : []),
      ...(area !== "stock" ? [this.loadThreads()] : []),
    ]);
  }

  private async loadItems() {
    const revision = ++this.stockRevision;
    try {
      const items = await this.api.list(this.id);
      if (revision === this.stockRevision)
        this.publish({
          items,
          loaded: { ...this.state.loaded, stock: true },
          errors: { ...this.state.errors, stock: undefined },
        });
    } catch (error) {
      if (revision === this.stockRevision)
        this.publish({ errors: { ...this.state.errors, stock: errorMessage(error) } });
    }
  }

  private async loadThreads() {
    const revision = ++this.threadsRevision;
    try {
      const threads = await this.api.threads(this.id);
      if (revision === this.threadsRevision)
        this.publish({
          threads,
          loaded: { ...this.state.loaded, threads: true },
          errors: { ...this.state.errors, threads: undefined },
        });
    } catch (error) {
      if (revision === this.threadsRevision)
        this.publish({ errors: { ...this.state.errors, threads: errorMessage(error) } });
    }
  }

  setPlacement(id: string) {
    this.publish({ placement: { id } });
  }

  marks(
    source: (lines: readonly LineInfo[]) => QuoteSource,
    lines: readonly LineInfo[],
  ): ReadonlyMap<number, StockMark> {
    if (this.state.items.length === 0 && !this.state.draft) return new Map();
    return stockMarks(
      source(lines),
      lines.map((line) => line.text),
      this.state.items,
      this.state.draft?.quote,
    );
  }

  bufferMarks(source: (lines: readonly LineInfo[]) => QuoteSource): BufferMarks {
    return {
      read: (lines) =>
        new Map([...this.marks(source, lines)].map(([index, mark]) => [index, mark.symbol])),
      subscribe: this.subscribe,
    };
  }

  private adopt(item: StockItem) {
    this.stockRevision++;
    const items = this.state.items.filter(({ id }) => id !== item.id);
    if (item.state !== "cancelled") items.push(item);
    items.sort((a, b) => a.id.localeCompare(b.id));
    this.publish({ items });
    void this.load("stock");
  }

  compose(kind: StockKind, title: string, quote: Quote, original?: StockItem) {
    const token = {};
    let editing = original;
    let pending = false;
    const name = label(kind);
    const clear = () => {
      if (this.state.draft?.token === token) this.publish({ draft: undefined });
    };
    this.controller.openPrompt({
      label: name,
      target: `会話: ${title}`,
      verb: "ストックする",
      initialText: original?.text,
      quote: quote.text.split("\n"),
      discardOnClose: true,
      allowEmpty: true,
      submit: async (text) => {
        if (pending) return false;
        if (!text.trim()) throw new Error("内容が空です。書いてからストックしてください");
        const prompt = this.controller.snapshot().promptId;
        const wasEditing = editing !== undefined;
        pending = true;
        try {
          const saved = editing
            ? await this.api.edit(editing.id, text)
            : await this.api.add(this.id, { kind, text, quote });
          editing = saved;
          this.adopt(saved);
          const current = this.controller.snapshot();
          if (
            current.promptId === prompt &&
            current.prompt &&
            this.controller.promptText() === text
          ) {
            clear();
            this.controller.notify(
              wasEditing
                ? `${name}を直しました`
                : `${name}をストックしました。続けて別の箇所にも書けます`,
            );
          }
        } finally {
          pending = false;
        }
      },
      close: (text) => {
        clear();
        if (text.trim()) this.controller.notify(`${name}の入力をやめました`);
      },
    });
    if (!original?.stale) this.publish({ draft: { token, quote } });
  }

  async cancel(item: StockItem) {
    const cancelled = await this.api.cancel(item.id);
    this.adopt(cancelled);
    this.controller.notify(`${label(item.kind)}を取り消しました。u で戻せます`);
  }

  async restore(id: string) {
    this.adopt(await this.api.restore(id));
    this.controller.notify("取り消しを戻しました");
  }

  async send(title: string, kinds: StockSendInput["kinds"]) {
    const result = await this.api.send(this.id, { kinds });
    await this.load();
    const opened = result.questions.filter((question) => question.ok).length;
    const failed = result.questions.filter((question) => !question.ok);
    const { count, delivery } = result.instructions;
    const sent = [
      ...(opened ? [`質問 ${opened} 件 (質問ごとにスレッドが始まります)`] : []),
      ...(count
        ? [
            `指示 ${count} 件 (${delivery === "queued" ? "今の作業が終わると届きます" : "1 通にまとめて"})`,
          ]
        : []),
    ];
    if (sent.length) this.controller.notify(`${title} に送りました: ${sent.join("、")}`);
    if (failed.length) {
      const reasons = [...new Set(failed.map(({ error }) => error.message))].join("、");
      this.controller.notify(
        `質問 ${failed.length} 件はスレッドを始められませんでした。ストックに残しています: ${reasons}`,
        "error",
      );
    }
    if (!sent.length && !failed.length)
      this.controller.notify(
        kinds === "questions"
          ? "送る質問がありません"
          : kinds === "instructions"
            ? "送る指示がありません"
            : "この会話のストックはありません",
      );
  }

  finished(item?: StockItem) {
    if (item) this.adopt(item);
    void this.load();
  }
}
