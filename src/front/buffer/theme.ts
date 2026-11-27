import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export type BufferSide = "tree" | "list" | "table" | "main" | "right";

export type SideMetrics = {
  fontSize: number;
  lineHeight: number;
  markWidth: number;
  numbers: boolean;
};

const METRICS: Record<BufferSide, SideMetrics> = {
  tree: { fontSize: 13, lineHeight: 26, markWidth: 16, numbers: false },
  list: { fontSize: 14, lineHeight: 26, markWidth: 24, numbers: true },
  table: { fontSize: 14, lineHeight: 26, markWidth: 20, numbers: true },
  main: { fontSize: 15, lineHeight: 24, markWidth: 20, numbers: true },
  right: { fontSize: 13, lineHeight: 22, markWidth: 16, numbers: false },
};

export function sideMetrics(side: BufferSide): SideMetrics {
  return METRICS[side];
}

export const KIND_CLASS = "cm-kind-";
export const BAND_YOU = "cm-band-you";
export const BAND_AI = "cm-band-ai";
export const BAND_FIRST = "cm-band-first";
export const BAND_LAST = "cm-band-last";
export const SPEAKER_TAG = "cm-speaker-tag";
export const SPEAKER_YOU = "cm-speaker-you";
export const SPEAKER_AI = "cm-speaker-ai";
export const MENU = "cm-menu";
export const MENU_START = "cm-menu-start";
export const MENU_END = "cm-menu-end";
export const MENU_NUMBER = "cm-menu-number";
export const MENU_NAME = "cm-menu-name";
export const MENU_EFFECT = "cm-menu-effect";
export const MENU_MAIN = "cm-menu-main";
export const MENU_DANGER = "cm-menu-danger";
export const MENU_DONE = "cm-menu-done";
export const COLUMN = "cm-column";
export const COLUMN_HANG = "cm-hang";
export const TONE_CLASS = "cm-tone-";
export const STRONG = "cm-strong";
export const MARK_GUTTER = "cm-mark-gutter";
export const NUM_GUTTER = "cm-num-gutter";
export const CURSOR_NUMBER = "cm-cursor-number";

export function bufferTheme(side: BufferSide): Extension {
  const metrics = sideMetrics(side);
  return EditorView.theme({
    "&": {
      flex: "1",
      minHeight: "0",
      color: "var(--color-ink)",
      backgroundColor: "transparent",
      fontSize: `${metrics.fontSize}px`,
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: "var(--font-sans)",
      lineHeight: `${metrics.lineHeight}px`,
      padding: "4px 0 24px",
    },
    ".cm-content": {
      containerType: "inline-size",
      minWidth: "0",
      flexBasis: "0",
      maxWidth: side === "list" || side === "table" ? "64rem" : "none",
      padding: "0",
      caretColor: "transparent",
    },
    ".cm-line": {
      padding: side === "tree" ? "0 8px 0 4px" : side === "right" ? "0 12px 0 4px" : "0 16px 0 8px",
      borderRadius: "6px",
    },
    [`.cm-line.${KIND_CLASS}add, .cm-line.${KIND_CLASS}del`]: { borderRadius: "0" },
    ...(side === "tree"
      ? { [`.cm-line.${KIND_CLASS}heading`]: { color: "var(--color-muted)", fontSize: "12px" } }
      : {
          [`.cm-line.${KIND_CLASS}heading`]: {
            fontSize: "13px",
            fontWeight: "700",
            borderBottom: "1px solid var(--color-line)",
            borderRadius: "0",
            paddingBottom: "2px",
          },
        }),
    [`.cm-line.${MENU}`]: {
      whiteSpace: "pre",
      marginLeft: "8px",
      marginRight: "16px",
      padding: "0 8px",
      borderLeft: "1px solid var(--color-line)",
      borderRight: "1px solid var(--color-line)",
      borderTop: "1px solid var(--color-line)",
      borderRadius: "0",
      backgroundColor: "var(--color-surface)",
      overflow: "hidden",
      textOverflow: "ellipsis",
    },
    [`.cm-line.${MENU_START}`]: { borderTopLeftRadius: "6px", borderTopRightRadius: "6px" },
    [`.cm-line.${MENU_END}`]: {
      borderBottom: "1px solid var(--color-line)",
      borderBottomLeftRadius: "6px",
      borderBottomRightRadius: "6px",
    },
    [`.cm-line.${KIND_CLASS}colhead`]: {
      borderBottom: "1px solid var(--color-line)",
      borderRadius: "0",
    },
    [`.cm-line.${COLUMN_HANG}`]: {
      paddingLeft: "calc(4rem + 12px)",
      textIndent: "calc(-4rem - 8px)",
    },
    [`.cm-line.${COLUMN_HANG} > span`]: { textIndent: "0" },
    [`.cm-line.${BAND_YOU}, .cm-line.${BAND_AI}`]: {
      borderRadius: "0",
      paddingLeft: "12px",
      marginLeft: "8px",
    },
    [`.cm-line.${BAND_YOU}`]: {
      backgroundColor: "var(--color-raised)",
      boxShadow: "inset 3px 0 0 var(--color-accent)",
      marginRight: "16px",
    },
    [`.cm-line.${BAND_AI}`]: {
      boxShadow: "inset 3px 0 0 color-mix(in srgb, var(--color-ink) 28%, transparent)",
    },
    [`.cm-line.${BAND_YOU}.${BAND_FIRST}`]: { borderTopRightRadius: "8px" },
    [`.cm-line.${BAND_YOU}.${BAND_LAST}`]: { borderBottomRightRadius: "8px" },
    [`.cm-line.${KIND_CLASS}skeleton`]: {
      backgroundImage: "linear-gradient(var(--color-raised), var(--color-raised))",
      backgroundSize: "60% 12px",
      backgroundRepeat: "no-repeat",
      backgroundPosition: "8px center",
      animation: "buffer-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
    },
    [`.cm-line.${KIND_CLASS}text`]: { lineHeight: "inherit" },
    [`.cm-line.${KIND_CLASS}ask`]: { fontWeight: "700" },
    [`.cm-line.${KIND_CLASS}tool`]: {
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
      color: "var(--color-muted)",
    },
    [`.cm-line.${KIND_CLASS}note`]: { fontSize: "13px", color: "var(--color-muted)" },
    [`.cm-line.${KIND_CLASS}separator`]: {
      color: "var(--color-accent)",
      fontSize: "12px",
      fontWeight: "500",
    },
    [`.cm-line.${KIND_CLASS}add`]: {
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
      backgroundColor: "var(--color-add)",
    },
    [`.cm-line.${KIND_CLASS}del`]: {
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
      backgroundColor: "var(--color-del)",
    },
    [`.cm-line.${KIND_CLASS}code`]: {
      fontFamily: "var(--font-mono)",
      fontSize: "13px",
      whiteSpace: "pre",
    },
    [`.cm-line.${KIND_CLASS}tree`]: {
      fontFamily: "var(--font-mono)",
      fontSize: "13px",
      whiteSpace: "pre",
    },
    [`.cm-line.${KIND_CLASS}queued`]: { color: "var(--color-doing)" },
    [`.cm-line.${KIND_CLASS}row`]: { whiteSpace: "pre" },
    [`.cm-line.${KIND_CLASS}section`]: { whiteSpace: "pre", fontSize: "13px", fontWeight: "700" },
    [`.cm-line.${KIND_CLASS}section > span:nth-child(2)`]: {
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
      fontWeight: "400",
      color: "var(--color-muted)",
    },
    [`.cm-line.${STRONG}`]: { fontWeight: "700" },
    [`.cm-line.${TONE_CLASS}wait`]: { color: "var(--color-wait)" },
    [`.cm-line.${TONE_CLASS}doing`]: { color: "var(--color-doing)" },
    [`.cm-line.${TONE_CLASS}done`]: { color: "var(--color-done)" },
    [`.cm-line.${TONE_CLASS}muted`]: { color: "var(--color-muted)" },
    [`.${COLUMN}.${TONE_CLASS}wait`]: { color: "var(--color-wait)" },
    [`.${COLUMN}.${TONE_CLASS}doing`]: { color: "var(--color-doing)" },
    [`.${COLUMN}.${TONE_CLASS}done`]: { color: "var(--color-done)" },
    [`.${COLUMN}.${TONE_CLASS}muted`]: { color: "var(--color-muted)" },
    [`.${COLUMN}`]: {
      display: "inline-block",
      verticalAlign: "bottom",
      whiteSpace: "pre",
      overflow: "hidden",
      textOverflow: "ellipsis",
    },
    [`.${COLUMN}.${MENU_NUMBER}`]: {
      width: "1.4rem",
      boxSizing: "border-box",
      border: "1px solid var(--color-line)",
      borderRadius: "4px",
      textAlign: "center",
      fontFamily: "var(--font-mono)",
      fontSize: "11px",
      color: "var(--color-muted)",
    },
    [`.${COLUMN}.${MENU_NUMBER}.${MENU_MAIN}`]: {
      borderColor: "var(--color-accent)",
      color: "var(--color-accent)",
    },
    [`.${COLUMN}.${MENU_NAME}`]: { fontSize: "13px", fontWeight: "500" },
    [`.${COLUMN}.${MENU_NAME}.${MENU_MAIN}`]: { fontWeight: "700" },
    [`.${COLUMN}.${MENU_NAME}.${MENU_DANGER}`]: { color: "var(--color-wait)" },
    [`.${COLUMN}.${MENU_NAME}.${MENU_DONE}`]: { color: "var(--color-accent)" },
    [`.${COLUMN}.${MENU_EFFECT}`]: { fontSize: "12px", color: "var(--color-muted)" },
    [`.${COLUMN}.${SPEAKER_TAG}`]: {
      display: "inline-block",
      borderRadius: "4px",
      padding: "0 6px",
      lineHeight: "1rem",
      fontSize: "12px",
      fontWeight: "700",
    },
    [`.${COLUMN}.${SPEAKER_YOU}`]: {
      backgroundColor: "var(--color-accent)",
      color: "var(--color-surface)",
    },
    [`.${COLUMN}.${SPEAKER_AI}`]: {
      backgroundColor: "var(--color-raised)",
      color: "var(--color-ink)",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      border: "none",
      color: "var(--color-muted)",
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
    },
    [`.${MARK_GUTTER} .cm-gutterElement`]: {
      width: `${metrics.markWidth}px`,
      textAlign: "center",
      color: "var(--color-accent)",
      fontWeight: "700",
      fontSize: side === "list" ? "8px" : "12px",
    },
    [`.${NUM_GUTTER} .cm-gutterElement`]: {
      minWidth: "2.5rem",
      textAlign: "right",
      paddingRight: "8px",
    },
    [`.${NUM_GUTTER} .cm-gutterElement .${CURSOR_NUMBER}`]: { color: "var(--color-ink)" },
    ".cm-line.cm-activeLine": { backgroundColor: "transparent" },
    "&.cm-focused .cm-line.cm-activeLine": { backgroundColor: "var(--color-raised)" },
    "&:not(.cm-focused) .cm-cursorLayer": { display: "none" },
    [`&.cm-focused .cm-line.${MENU}.cm-activeLine`]: { backgroundColor: "var(--color-sel)" },
    [`&.cm-focused .cm-line.${BAND_YOU}.cm-activeLine`]: { backgroundColor: "var(--color-line)" },
    ".cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "var(--color-sel) !important",
    },
    ".cm-fat-cursor": {
      background: "var(--color-accent) !important",
      color: "var(--color-surface) !important",
      borderRadius: "2px",
    },
    "&:not(.cm-focused) .cm-fat-cursor": {
      background: "none !important",
      outline: "none !important",
      color: "inherit !important",
    },
    ".cm-vim-panel": {
      backgroundColor: "var(--color-surface)",
      borderTop: "1px solid var(--color-line)",
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
    },
    ".cm-vim-panel input": { fontFamily: "var(--font-mono)" },
  });
}

export function speakerTagClass(speaker: "you" | "ai"): string {
  return `${COLUMN} ${SPEAKER_TAG} ${speaker === "you" ? SPEAKER_YOU : SPEAKER_AI}`;
}

export function toneClass(tone: "wait" | "doing" | "done" | "muted"): string {
  return `${TONE_CLASS}${tone}`;
}
