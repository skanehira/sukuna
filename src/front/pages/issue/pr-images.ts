import { StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { PrLine } from "./pr-lines";
import { bufferField } from "../../buffer/state";

class EvidenceImage extends WidgetType {
  private readonly image: NonNullable<PrLine["image"]>;

  constructor(image: NonNullable<PrLine["image"]>) {
    super();
    this.image = image;
  }

  eq(other: EvidenceImage): boolean {
    return this.image.url === other.image.url && this.image.alt === other.image.alt;
  }

  toDOM(view: EditorView): HTMLElement {
    const holder = document.createElement("div");
    const image = document.createElement("img");
    image.className = "cm-pr-evidence-image";
    image.alt = this.image.alt;
    image.referrerPolicy = "no-referrer";
    image.addEventListener("load", () => view.requestMeasure(), { once: true });
    image.addEventListener(
      "error",
      () => {
        image.remove();
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
      .lines.flatMap(({ image }: PrLine, index) =>
        image
          ? [
              Decoration.widget({ widget: new EvidenceImage(image), block: true, side: 1 }).range(
                state.doc.line(index + 1).to,
              ),
            ]
          : [],
      ),
  );
}

const evidenceImages = StateField.define({
  create: images,
  update: (current, { state, startState }) =>
    state.field(bufferField).lines === startState.field(bufferField).lines
      ? current
      : images(state),
  provide: (field) => EditorView.decorations.from(field),
});

export const prImageDisplay = [
  evidenceImages,
  EditorView.theme({
    ".cm-pr-evidence-image": {
      display: "block",
      maxWidth: "calc(100% - 2rem)",
      maxHeight: "24rem",
      objectFit: "contain",
      margin: "4px 16px 8px",
      border: "1px solid var(--color-line)",
      borderRadius: "6px",
    },
  }),
];
