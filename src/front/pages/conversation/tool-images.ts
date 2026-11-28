import { StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { ConversationLine } from "../../lib/conversation/lines";
import { bufferField } from "../../buffer/state";

class ToolResultImage extends WidgetType {
  private readonly image: NonNullable<ConversationLine["image"]>;

  constructor(image: NonNullable<ConversationLine["image"]>) {
    super();
    this.image = image;
  }

  eq(other: ToolResultImage): boolean {
    return this.image.url === other.image.url && this.image.alt === other.image.alt;
  }

  toDOM(view: EditorView): HTMLElement {
    const holder = document.createElement("div");
    const image = document.createElement("img");
    image.className = "cm-tool-result-image";
    image.alt = this.image.alt;
    image.addEventListener("load", () => view.requestMeasure(), { once: true });
    image.addEventListener(
      "error",
      () => {
        const missing = document.createElement("div");
        missing.className = "cm-tool-result-image-missing";
        missing.textContent = "画像が見つかりません";
        image.replaceWith(missing);
        view.requestMeasure();
      },
      { once: true },
    );
    image.src = this.image.url;
    holder.append(image);
    return holder;
  }
}

function images(state: EditorState) {
  return Decoration.set(
    state
      .field(bufferField)
      .lines.flatMap(({ image }: ConversationLine, index) =>
        image
          ? [
              Decoration.widget({ widget: new ToolResultImage(image), block: true, side: 1 }).range(
                state.doc.line(index + 1).to,
              ),
            ]
          : [],
      ),
  );
}

const toolResultImages = StateField.define({
  create: images,
  update: (current, { state, startState }) =>
    state.field(bufferField).lines === startState.field(bufferField).lines
      ? current
      : images(state),
  provide: (field) => EditorView.decorations.from(field),
});

export const toolImageDisplay = [
  toolResultImages,
  EditorView.theme({
    ".cm-tool-result-image": {
      display: "block",
      maxWidth: "calc(100% - 2rem)",
      maxHeight: "16rem",
      objectFit: "contain",
      margin: "4px 16px 8px",
      border: "1px solid var(--color-line)",
      borderRadius: "6px",
    },
    ".cm-tool-result-image-missing": {
      margin: "4px 16px 8px",
      fontSize: "13px",
      color: "var(--color-muted)",
    },
  }),
];
