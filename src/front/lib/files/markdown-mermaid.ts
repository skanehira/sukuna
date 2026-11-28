import {
  Facet,
  StateField,
  type EditorState,
  type Range,
  type Text,
  type Transaction,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { GFM, parser } from "@lezer/markdown";
import type { Mermaid } from "mermaid";

export type MermaidRender = (code: string) => Promise<string>;
export type MermaidBlock = { code: string; end: number };

const markdown = parser.configure(GFM);
const CONTAINER = /^[ \t>]*/;

let loaded: Promise<Mermaid> | null = null;
let sequence = 0;

const renderWithMermaid: MermaidRender = async (code) => {
  loaded ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      htmlLabels: false,
      suppressErrorRendering: true,
      theme: "neutral",
    });
    return mermaid;
  });
  const mermaid = await loaded;
  sequence += 1;
  const { svg } = await mermaid.render(`sukuna-mermaid-${sequence}`, code);
  return svg;
};

export const mermaidRenderer = Facet.define<MermaidRender, MermaidRender>({
  combine: (values) => values[0] ?? renderWithMermaid,
});

const rendered = new WeakMap<MermaidRender, Map<string, Promise<string>>>();

function renderOnce(render: MermaidRender, code: string): Promise<string> {
  let cache = rendered.get(render);
  if (cache === undefined) {
    cache = new Map();
    rendered.set(render, cache);
  }
  let svg = cache.get(code);
  if (svg === undefined) {
    svg = render(code);
    cache.set(code, svg);
  }
  return svg;
}

export function findMermaid(doc: Text, first: number, last: number): MermaidBlock[] {
  const from = doc.line(first).from;
  const source = doc.sliceString(from, doc.line(last).to);
  if (!/mermaid/i.test(source)) return [];
  const blocks: MermaidBlock[] = [];
  markdown.parse(source).iterate({
    enter(ref) {
      if (ref.name !== "FencedCode") return undefined;
      const marks = ref.node.getChildren("CodeMark");
      const info = ref.node.getChild("CodeInfo");
      const language = info ? source.slice(info.from, info.to).trim().split(/\s+/)[0] : "";
      if (marks.length === 2 && language.toLowerCase() === "mermaid") {
        const opening = doc.lineAt(from + marks[0].from);
        const closing = doc.lineAt(from + marks[1].from);
        const indent = from + marks[0].from - opening.from;
        const code: string[] = [];
        for (let number = opening.number + 1; number < closing.number; number += 1) {
          const text = doc.line(number).text;
          code.push(text.slice(CONTAINER.exec(text.slice(0, indent))?.[0].length ?? 0));
        }
        blocks.push({ code: code.join("\n"), end: from + ref.to });
      }
      return false;
    },
  });
  return blocks;
}

class MermaidDiagram extends WidgetType {
  private readonly code: string;

  constructor(code: string) {
    super();
    this.code = code;
  }
  eq(other: MermaidDiagram): boolean {
    return other.code === this.code;
  }
  get estimatedHeight(): number {
    return 160;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = view.dom.ownerDocument.createElement("div");
    box.className = "cm-mermaid";
    box.textContent = "Mermaid の図を描いています";
    renderOnce(view.state.facet(mermaidRenderer), this.code).then(
      (svg) => {
        box.innerHTML = svg;
        view.requestMeasure();
      },
      (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        box.textContent = `Mermaid の図を描けませんでした: ${reason}`;
        view.requestMeasure();
      },
    );
    return box;
  }
}

export function mermaidWidget(block: MermaidBlock): Range<Decoration> {
  return Decoration.widget({ widget: new MermaidDiagram(block.code), block: true, side: 1 }).range(
    block.end,
  );
}

export function mermaidField(
  build: (state: EditorState) => Range<Decoration>[],
  changed: (tr: Transaction) => boolean = (tr) => tr.docChanged,
) {
  return StateField.define<DecorationSet>({
    create: (state) => Decoration.set(build(state), true),
    update: (value, tr) => (changed(tr) ? Decoration.set(build(tr.state), true) : value),
    provide: (field) => EditorView.decorations.from(field),
  });
}

export const mermaidPreview = mermaidField((state) =>
  findMermaid(state.doc, 1, state.doc.lines).map(mermaidWidget),
);

export const mermaidTheme = {
  ".cm-mermaid": { padding: "8px 0", overflowX: "auto", color: "var(--color-muted)" },
  ".cm-mermaid svg": { maxWidth: "100%", height: "auto" },
};
