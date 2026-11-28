import type { Extension, Range, Text } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { GFM, parser } from "@lezer/markdown";
import {
  estimateWidth,
  imageLabel,
  TableLayout,
  tableRanges,
  tableTheme,
  type TextWidth,
} from "./markdown-table";
import { mermaidPreview, mermaidTheme } from "./markdown-mermaid";

const markdown = parser.configure(GFM);
type MarkdownTree = ReturnType<typeof markdown.parse>;
const format: Record<string, string> = {
  StrongEmphasis: "cm-file-strong",
  Emphasis: "cm-file-emphasis",
  InlineCode: "cm-file-inline-code",
};
const linkClass = "cm-file-link";
const linkParents = new Set(["Link", "Image", "Autolink", "LinkReference"]);
class ImageLabel extends WidgetType {
  private readonly alt: string;

  constructor(alt: string) {
    super();
    this.alt = alt;
  }
  eq(other: ImageLabel): boolean {
    return this.alt === other.alt;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.textContent = imageLabel(this.alt);
    span.className = "cm-file-link";
    return span;
  }
}

export function markdownRanges(
  doc: Text,
  active: number,
  from: number,
  to: number,
  {
    tree = markdown.parse(doc.sliceString(from, to)),
    width = estimateWidth,
    available = Number.POSITIVE_INFINITY,
  }: { tree?: MarkdownTree; width?: TextWidth; available?: number } = {},
): Range<Decoration>[] {
  const ranges: Range<Decoration>[] = [];
  const hide = (from: number, to: number, widget?: WidgetType) => {
    for (let number = doc.lineAt(from).number; number <= doc.lineAt(to).number; number++) {
      const line = doc.line(number);
      const start = Math.max(line.from, from);
      const end = Math.min(line.to, to);
      if (number !== active && start < end) {
        ranges.push(Decoration.replace({ widget }).range(start, end));
        widget = undefined;
      }
    }
  };
  const mark = (from: number, to: number, className: string) => {
    if (from < to) ranges.push(Decoration.mark({ class: className }).range(from, to));
  };

  const offset = from;
  tree.iterate({
    enter(ref) {
      const name = ref.name;
      const from = ref.from + offset;
      const to = ref.to + offset;
      if (name === "HTMLBlock" || name === "HTMLTag") return false;
      if (name === "Table")
        ranges.push(...tableRanges(doc, ref.node, offset, active, width, available));
      if (/^(ATX|Setext)Heading[1-6]$/.test(name)) {
        ranges.push(
          Decoration.line({ class: `cm-file-heading cm-file-heading-${name.at(-1)}` }).range(
            doc.lineAt(from).from,
          ),
        );
      } else if (name === "HeaderMark") {
        const line = doc.lineAt(from);
        const space = /^[ \t]*/.exec(doc.sliceString(to, line.to))?.[0].length ?? 0;
        hide(from, to + space);
      } else if (name === "Autolink") {
        for (const marker of ref.node.getChildren("LinkMark"))
          hide(marker.from + offset, marker.to + offset);
        const url = ref.node.getChild("URL");
        if (url) mark(url.from + offset, url.to + offset, linkClass);
        return false;
      } else if (name === "URL") {
        if (!linkParents.has(ref.node.parent?.name ?? "")) mark(from, to, linkClass);
      } else if (name === "Link" || name === "Image") {
        const [opening, closing] = ref.node
          .getChildren("LinkMark")
          .map((marker) => ({ from: marker.from + offset, to: marker.to + offset }));
        if (opening && closing) {
          if (name === "Image") {
            hide(from, to, new ImageLabel(doc.sliceString(opening.to, closing.from)));
            return false;
          }
          hide(from, opening.to);
          hide(closing.from, to);
          mark(opening.to, closing.from, linkClass);
        }
      } else if (["EmphasisMark", "CodeMark", "CodeInfo"].includes(name)) {
        hide(from, to);
      } else if (name === "CodeText") {
        for (let number = doc.lineAt(from).number; number <= doc.lineAt(to).number; number++) {
          ranges.push(Decoration.line({ class: "cm-file-code-line" }).range(doc.line(number).from));
        }
      } else if (Object.hasOwn(format, name)) {
        mark(from, to, format[name]);
      }
      return undefined;
    },
  });
  return ranges;
}

function decorations(view: EditorView, tree: MarkdownTree, layout: TableLayout): DecorationSet {
  const { doc, selection } = view.state;
  return Decoration.set(
    markdownRanges(doc, doc.lineAt(selection.main.head).number, 0, doc.length, {
      tree,
      width: layout.width,
      available: layout.available,
    }),
    true,
  );
}

export const markdownTheme: Extension = EditorView.theme({
  ".cm-file-heading": { fontWeight: "700", fontSize: "1.12em" },
  ".cm-file-heading-1": { fontSize: "1.4em" },
  ".cm-file-heading-2": { fontSize: "1.25em" },
  ".cm-file-strong": { fontWeight: "700" },
  ".cm-file-emphasis": { fontStyle: "italic" },
  ".cm-file-inline-code, .cm-file-code-line": {
    fontFamily: "var(--font-mono)",
    backgroundColor: "var(--color-ground)",
  },
  ".cm-file-link": { color: "var(--color-accent)" },
  ...tableTheme,
  ...mermaidTheme,
});

export const markdownPreview: Extension = [
  ViewPlugin.fromClass(
    class {
      tree: MarkdownTree;
      layout: TableLayout;
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.tree = markdown.parse(view.state.doc.toString());
        this.layout = new TableLayout(view, "mono");
        this.decorations = decorations(view, this.tree, this.layout);
      }
      update(update: ViewUpdate) {
        if (update.docChanged) this.tree = markdown.parse(update.state.doc.toString());
        if (this.layout.changed(update) || update.docChanged || update.selectionSet) {
          this.decorations = decorations(update.view, this.tree, this.layout);
        }
      }
      destroy() {
        this.layout.destroy();
      }
    },
    { decorations: (plugin) => plugin.decorations },
  ),
  mermaidPreview,
  markdownTheme,
];
